"""devpi-admin: web UI plugin for devpi-server.

Installs a single-page application that replaces devpi-web. The SPA is served
under ``/+admin/`` and browser requests to ``/`` are redirected there. All
existing devpi REST API endpoints are left untouched — the JS app talks to
the standard devpi JSON API (``/+login``, ``/<user>/<index>``, ...).
"""
import base64
import ipaddress
import json
import logging
import os
import re
import time
from pathlib import Path

from devpi_server.config import hookimpl
from devpi_server.mirror import MirrorStage
from devpi_server.model import ACLList
from devpi_server.view_auth import CredentialsIdentity
from pyramid.httpexceptions import (
    HTTPBadRequest, HTTPForbidden, HTTPFound, HTTPNotFound)
from pyramid.response import FileResponse, Response

from devpi_admin import tokens
from devpi_admin.customizer import (
    DevpiAdminMirrorCustomizer, is_version_allowed, parse_rules)


STATIC_DIR = Path(__file__).parent / "static"
_NORMALIZE_RE = re.compile(r"[-_.]+")
_SDIST_EXTENSIONS = (".tar.gz", ".tar.bz2", ".zip")
_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,49}$")
_log = logging.getLogger(__name__)

# Path patterns for read-ACL enforcement in the tween.
# `_USER_PATH_RE` — single user resource (`/alice`, `/alice/`).
# `_INDEX_ANY_RE` — anything under `/user/index/...` (project list, +simple,
#   +simple/<project>, version, file download, …) where neither user nor
#   index starts with `+`.
_USER_PATH_RE = re.compile(r"^/([^/+][^/]*)/?$")
_INDEX_ANY_RE = re.compile(r"^/([^/+][^/]*)/([^/+][^/]*)(/.*)?$")
# Mirror download URL: /{user}/{index}/+f/{hashdir-a}/{hashdir-b}/{filename}
# Capture user, index, and the filename (last path segment) for filename
# parsing in the package allow/deny enforcement check.
_PKG_FILE_RE = re.compile(
    r"^/([^/+][^/]*)/([^/+][^/]*)/\+f/.+/([^/]+)$")

# Method matrix per token scope. ``read`` is for pip / devpi download;
# ``upload`` adds POST/PUT for package upload via ``twine`` / ``devpi upload``.
# DELETE is never granted — package removal must use password auth so an
# isolated upload token cannot wipe history.
_SCOPE_METHODS = {
    "read": frozenset({"GET", "HEAD"}),
    "upload": frozenset({"GET", "HEAD", "POST", "PUT"}),
}

# In-memory record of every replica's most recent /+changelog/{N}- poll.
# devpi-server's xom.polling_replicas[uuid].serial is overwritten during
# streaming (it ramps from start_serial-1 up to current serial as the
# response generator yields entries), so the original start_serial — the
# only serial that reflects what the replica actually applied — is
# visible only for microseconds. We capture it at the request boundary
# from the tween before devpi's view runs.
_CHANGELOG_PATH_RE = re.compile(r"^/\+changelog/(\d+)-?$")
_H_REPLICA_UUID = "X-DEVPI-REPLICA-UUID"
_H_REPLICA_OUTSIDE_URL = "X-DEVPI-REPLICA-OUTSIDE-URL"
_REPLICA_POLL_TTL = 600  # drop entries unseen for 10 min
_REPLICA_POLL_MAX = 256  # hard cap to bound memory under abuse
_replica_polls = {}  # uuid -> {start_serial, last_seen, remote_ip, outside_url}


@hookimpl
def devpiserver_get_features():
    return {"devpi-admin"}


@hookimpl
def devpiserver_indexconfig_defaults(index_type):
    # ACLList marker tells devpi to validate values via ensure_acl_list()
    # on every PUT/PATCH (normalizes :ANONYMOUS:/:AUTHENTICATED: case,
    # accepts comma-separated strings, strips whitespace).
    defaults = {"acl_read": ACLList([":ANONYMOUS:"])}
    if index_type == "mirror":
        # Plain list defaults trigger ensure_list() in devpi core, which
        # accepts comma-separated input from PATCH and trims whitespace.
        # Per-entry PEP 508 validation runs in our patched MirrorCustomizer
        # (see devpi_admin/customizer.py).
        defaults["package_allowlist"] = []
        defaults["package_denylist"] = []
    return defaults


@hookimpl
def devpiserver_stage_get_principals_for_pkg_read(ixconfig):
    return ixconfig.get("acl_read", [":ANONYMOUS:"])


@hookimpl
def devpiserver_get_identity(request, credentials):
    """Recognize and validate adm_ tokens.

    Returns CredentialsIdentity if the credentials carry a valid admin
    token. Returns None otherwise so devpi's default identity hook handles
    standard tokens/passwords. Sets request.environ["adm.is_admin_token"]
    so the tween can apply scope / index enforcement.

    The tween populates ``adm.token_meta`` from its own lookup before
    invoking the handler; if it's already there we trust that record
    instead of re-reading from keyfs. Falls back to a fresh lookup for
    paths that bypass the tween (e.g. unit tests).
    """
    if credentials is None:
        return None
    user, secret = credentials
    if not tokens.looks_like_token(secret):
        return None
    meta = request.environ.get("adm.token_meta")
    if meta is None:
        xom = request.registry.get("xom")
        if xom is None:
            return None
        meta = tokens.lookup(xom, secret)
        if meta is None:
            return None
    if meta.get("user") != user:
        # token's bound user must match the authentication header user
        return None
    request.environ["adm.is_admin_token"] = True
    request.environ["adm.token_user"] = user
    request.environ["adm.token_meta"] = meta
    return CredentialsIdentity(user, [])


@hookimpl
def devpiserver_pyramid_configure(config, pyramid_config):
    # Register our keyfs keys early so token endpoints can read/write.
    xom = pyramid_config.registry.get("xom")
    if xom is not None:
        tokens.register_keyfs_keys(xom.keyfs)
        # Clean up tokens when a user is deleted, and when an index is
        # removed from a user's config. Only on primary — replicas are
        # read-only.
        role = getattr(xom.config, "role", "primary")
        if role != "replica":
            xom.keyfs.USER.on_key_change(_make_user_changed_handler(xom))
            # One-shot wipe of legacy admin tokens (pre-hash storage or
            # missing index/scope). Idempotent; safe on every startup.
            try:
                tokens.cleanup_legacy_tokens(xom)
            except Exception:
                _log.warning(
                    "cleanup_legacy_tokens at startup failed",
                    exc_info=True)
    # Serve bundled static assets (index.html, css/, js/) under /+admin/.
    pyramid_config.add_static_view(
        name="+admin", path="devpi_admin:static")

    # Serve index.html on /+admin/ (with trailing slash). add_static_view
    # does not auto-resolve directory index files.
    pyramid_config.add_route("devpi_admin_spa", "/+admin/")
    pyramid_config.add_view(_serve_index, route_name="devpi_admin_spa")

    # Bare /+admin (no slash) → redirect so relative asset URLs resolve.
    pyramid_config.add_route("devpi_admin_spa_noslash", "/+admin")
    pyramid_config.add_view(
        lambda request: HTTPFound("/+admin/"),
        route_name="devpi_admin_spa_noslash")

    # Session validity check.
    pyramid_config.add_route(
        "devpi_admin_session",
        "/+admin-api/session")
    pyramid_config.add_view(
        _session_view, route_name="devpi_admin_session",
        request_method="GET")

    # Public URL (anonymously accessible). Single source of truth for
    # the canonical "outside" URL — both backend (token issuance views)
    # and frontend (static pip.conf / .pypirc fallbacks) derive their
    # URLs from request.application_url, which respects --outside-url
    # and X-Forwarded-* headers from a configured reverse proxy. Without
    # this, the frontend's location.origin can disagree with backend
    # output if the deployment doesn't propagate X-Forwarded-Host etc.
    pyramid_config.add_route(
        "devpi_admin_public_url",
        "/+admin-api/public-url")
    pyramid_config.add_view(
        _public_url_view, route_name="devpi_admin_public_url",
        request_method="GET")

    # Authoritative per-replica state. Captures the start_serial of each
    # replica's most recent /+changelog/{N}- poll via the tween, so the
    # dashboard can read where the replica really is — devpi-server's
    # own polling_replicas overwrites this during streaming and gives a
    # misleading "caught up" reading once the response generator drains.
    pyramid_config.add_route(
        "devpi_admin_replicas", "/+admin-api/replicas")
    pyramid_config.add_view(
        _replicas_view, route_name="devpi_admin_replicas",
        request_method="GET")

    # Cached packages API for mirror indexes.
    pyramid_config.add_route(
        "devpi_admin_cached",
        "/+admin-api/cached/{user}/{index}")
    pyramid_config.add_view(
        _cached_packages_view, route_name="devpi_admin_cached",
        request_method="GET")

    # Version listing (lightweight — no full metadata).
    pyramid_config.add_route(
        "devpi_admin_versions",
        "/+admin-api/versions/{user}/{index}/{project}")
    pyramid_config.add_view(
        _versions_view, route_name="devpi_admin_versions",
        request_method="GET")

    # Single version detail (metadata for one version only).
    pyramid_config.add_route(
        "devpi_admin_versiondata",
        "/+admin-api/versiondata/{user}/{index}/{project}/{version}")
    pyramid_config.add_view(
        _versiondata_view, route_name="devpi_admin_versiondata",
        request_method="GET")

    # Token issuance (JSON).
    pyramid_config.add_route(
        "devpi_admin_token", "/+admin-api/token")
    pyramid_config.add_view(
        _issue_token_view, route_name="devpi_admin_token",
        request_method="POST")

    # Pip.conf with embedded short-lived token (text/plain, CI-friendly).
    pyramid_config.add_route(
        "devpi_admin_pip_conf", "/+admin-api/pip-conf")
    pyramid_config.add_view(
        _pip_conf_view, route_name="devpi_admin_pip_conf",
        request_method="GET")

    # Token list (per user) and per-user count (for UI badge).
    pyramid_config.add_route(
        "devpi_admin_user_tokens",
        "/+admin-api/users/{user}/tokens")
    pyramid_config.add_view(
        _list_tokens_view, route_name="devpi_admin_user_tokens",
        request_method="GET")
    pyramid_config.add_view(
        _reset_tokens_view, route_name="devpi_admin_user_tokens",
        request_method="DELETE")

    # Token list per index — root sees all, non-root sees own only.
    pyramid_config.add_route(
        "devpi_admin_index_tokens",
        "/+admin-api/indexes/{user}/{index}/tokens")
    pyramid_config.add_view(
        _list_index_tokens_view, route_name="devpi_admin_index_tokens",
        request_method="GET")

    # Single token revoke.
    pyramid_config.add_route(
        "devpi_admin_token_revoke",
        "/+admin-api/tokens/{token_id}")
    pyramid_config.add_view(
        _revoke_token_view, route_name="devpi_admin_token_revoke",
        request_method="DELETE")

    # Redirect browser visits to "/" to the SPA. Other routes (JSON API
    # calls, CLI requests) pass through untouched because they send
    # Accept: application/json.
    pyramid_config.add_tween(
        "devpi_admin.main.devpi_admin_tween_factory")


_CSP_HEADER = "; ".join((
    "default-src 'self'",
    # No inline <script>; theme.js builds SVGs via innerHTML but those are
    # static literals from same-origin script, not user input.
    "script-src 'self'",
    # 'unsafe-inline' covers programmatic style writes (style.cssText,
    # element.style.width = …) which several views rely on.
    "style-src 'self' 'unsafe-inline'",
    # README images can come from anywhere; data: lets inline icons render.
    "img-src 'self' data: https: http:",
    # PyPI fallback for README on mirror packages.
    "connect-src 'self' https://pypi.org",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
))


def _serve_index(request):
    response = FileResponse(
        str(STATIC_DIR / "index.html"),
        request=request,
        content_type="text/html")
    response.headers["Content-Security-Policy"] = _CSP_HEADER
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def _session_view(request):
    """Return whether the current request carries a valid authenticated session."""
    user = request.authenticated_userid
    if user:
        return _json_response({"valid": True, "user": user})
    raise HTTPForbidden(json_body={"valid": False, "error": "not authenticated"})


def _public_url_view(request):
    """Return the canonical public URL of this devpi-admin deployment.

    Anonymous-accessible — the URL itself is not a secret, and public
    indexes need it for their static pip.conf / .pypirc preview shown
    even to unauthenticated visitors. Trailing slash stripped so callers
    can append paths without producing ``//``.
    """
    return _json_response({"url": request.application_url.rstrip("/")})


def _get_stage_or_404(xom, user, index):
    """Return stage object or raise HTTPNotFound."""
    stage = xom.model.getstage(user, index)
    if stage is None:
        raise HTTPNotFound(json_body={"error": "index not found"})
    return stage


def _check_read_access(request, stage):
    """Raise 401/404 if the request has no read access to the stage.

    Delegates to pyramid's permission system, which evaluates the stage's
    __acl__ via devpiserver_stage_get_principals_for_pkg_read. Returns 404
    (not 403) for authenticated users to avoid confirming that a private
    index exists; returns 401 with a challenge for anonymous so devpi-cli
    and pip retry with credentials.
    """
    if request.has_permission("pkg_read", context=stage):
        return
    if request.authenticated_userid is None:
        raise HTTPForbidden(json_body={"error": "authentication required"})
    raise HTTPNotFound(json_body={"error": "index not found"})


def _json_response(data):
    """Return a JSON Response from a dict."""
    body = json.dumps(data)
    return Response(body=body.encode("utf-8"), content_type="application/json")


def _validate_path_component(value):
    """Reject path components that could cause traversal."""
    if "/" in value or "\\" in value or value in (".", ".."):
        raise ValueError(f"invalid path component: {value!r}")


def _files_dir(xom, user, index):
    """Return Path to +files dir for an index, with path validation."""
    _validate_path_component(user)
    _validate_path_component(index)
    return Path(xom.config.serverdir) / "+files" / user / index / "+f"


# Cache for the +files filesystem scan. Keyed by (user, index); value is
# (serial, {project_name: {version, ...}}). devpi increments keyfs serial
# on every file add/remove, so a serial match means the directory state
# we cached is still authoritative — no need to re-walk.
_files_scan_cache = {}
_FILES_SCAN_CACHE_MAX = 32


def _scan_files(xom, user, index):
    """Return ``{normalized_name: {version, ...}}`` of cached files.

    Result is memoised per ``(user, index)`` and re-scanned only when the
    keyfs serial changes. On filesystem error the partial result is still
    returned (and cached) — the next scan will retry.
    """
    serial = xom.keyfs.get_current_serial()
    cached = _files_scan_cache.get((user, index))
    if cached is not None and cached[0] == serial:
        return cached[1]

    files_dir = _files_dir(xom, user, index)
    result = {}
    try:
        for f in files_dir.rglob("*"):
            if not f.is_file():
                continue
            name, ver = _parse_filename(f.name)
            if name:
                result.setdefault(name, set()).add(ver)
    except OSError:
        _log.warning("Cannot scan %s", files_dir, exc_info=True)

    if len(_files_scan_cache) >= _FILES_SCAN_CACHE_MAX:
        # FIFO eviction; insertion order is preserved by dict in Python 3.7+.
        _files_scan_cache.pop(next(iter(_files_scan_cache)))
    _files_scan_cache[(user, index)] = (serial, result)
    return result


def _cached_packages_view(request):
    """Return list of project names that have cached files on disk.

    Backed by ``_scan_files`` — first call walks ``+files/{user}/{index}/``,
    subsequent calls reuse the cached result until the keyfs serial changes.
    """
    user = request.matchdict["user"]
    index = request.matchdict["index"]
    xom = request.registry["xom"]

    stage = _get_stage_or_404(xom, user, index)
    _check_read_access(request, stage)
    if not isinstance(stage, MirrorStage):
        return HTTPNotFound(
            json_body={"error": "not a mirror index"})

    scan = _scan_files(xom, user, index)
    cached = sorted(scan.keys())
    return _json_response({"result": cached, "total": len(cached)})


def _parse_filename(filename):
    """Extract (normalized_name, version) from wheel or sdist filename.

    Returns (None, None) if the filename is not recognized.
    """
    # wheel: {name}-{ver}(-{build})?-{python}-{abi}-{platform}.whl
    if filename.endswith(".whl"):
        parts = filename.split("-")
        if len(parts) >= 3:
            return _normalize(parts[0]), parts[1]
        return None, None
    # sdist: {name}-{ver}.tar.gz or {name}-{ver}.zip
    for ext in _SDIST_EXTENSIONS:
        if filename.endswith(ext):
            base = filename[:-len(ext)]
            idx = base.rfind("-")
            if idx > 0:
                return _normalize(base[:idx]), base[idx + 1:]
            return None, None
    return None, None


def _normalize(name):
    """PEP 503 name normalization."""
    return _NORMALIZE_RE.sub("-", name).lower()


def _versions_view(request):
    """Return version list with cached/uncached distinction.

    For stage indexes all versions are local (cached). For mirror indexes
    only versions that have downloaded files on disk are marked cached.
    Returns ``{"cached": [...], "all": null}`` initially; the frontend
    can request all versions via ``?all=1`` query parameter.
    """
    user = request.matchdict["user"]
    index = request.matchdict["index"]
    project = request.matchdict["project"]
    xom = request.registry["xom"]
    stage = _get_stage_or_404(xom, user, index)
    _check_read_access(request, stage)

    is_mirror = isinstance(stage, MirrorStage)
    want_all = request.params.get("all") == "1"

    if is_mirror:
        cached_versions = _cached_versions_for_project(
            xom, user, index, project)
        all_versions = None
        if want_all:
            all_versions = sorted(
                stage.list_versions(project), reverse=True)
        return _json_response({
            "cached": cached_versions,
            "all": all_versions,
        })

    # Stage index: everything is local
    versions = sorted(stage.list_versions(project), reverse=True)
    return _json_response({"cached": versions, "all": versions})


def _cached_versions_for_project(xom, user, index, project):
    """Return sorted list of versions that have files on disk."""
    scan = _scan_files(xom, user, index)
    versions = scan.get(_normalize(project), set())
    return sorted(versions, reverse=True)


def _versiondata_view(request):
    """Return metadata + links for a single version of a project."""
    user = request.matchdict["user"]
    index = request.matchdict["index"]
    project = request.matchdict["project"]
    version = request.matchdict["version"]
    xom = request.registry["xom"]
    stage = _get_stage_or_404(xom, user, index)
    _check_read_access(request, stage)
    verdata = stage.get_versiondata(project, version)
    if not verdata:
        return HTTPNotFound(json_body={"error": "version not found"})
    # Convert to plain dict with JSON-safe types
    result = _to_json_safe(verdata)
    # Include file links — filter releaselinks to this version
    try:
        all_links = stage.get_releaselinks(project)
    except Exception:
        _log.warning(
            "Failed to get releaselinks for %s/%s/%s",
            user, index, project, exc_info=True)
        all_links = []
    result["+links"] = []
    for link in all_links:
        if link.version != version:
            continue
        link_info = {
            "href": "/" + link.relpath,
            "basename": link.basename,
            "hash_spec": link.best_available_hash_spec,
        }
        try:
            log = link._log
            link_info["log"] = [
                {k: (list(v) if k == "when" else v)
                 for k, v in entry.items()}
                for entry in log
            ]
        except (AttributeError, TypeError):
            pass
        result["+links"].append(link_info)
    return _json_response({"result": result})


def _to_json_safe(obj):
    """Recursively convert readonly views, tuples, sets to plain types."""
    if isinstance(obj, dict):
        return {k: _to_json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_json_safe(v) for v in obj]
    if isinstance(obj, (set, frozenset)):
        return sorted((_to_json_safe(v) for v in obj), key=str)
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    # Readonly views from devpi keyfs
    try:
        return _to_json_safe(dict(obj))
    except (TypeError, ValueError):
        pass
    try:
        return _to_json_safe(list(obj))
    except TypeError:
        return str(obj)


def devpi_admin_tween_factory(handler, registry):
    xom = registry["xom"]

    def tween(request):
        # Capture replica /+changelog/{N}- polls. Cheap regex on path;
        # no-op for non-replica traffic. Runs before any other tween
        # logic so we record the request even if subsequent enforcement
        # short-circuits (it shouldn't for replica polls, but defensive).
        _record_replica_poll(request)

        # Detect admin token directly from header instead of forcing
        # request.identity to load. Pyramid caches identity per-request,
        # and POST /+login mutates X-Devpi-Auth mid-request — pre-loading
        # here would pin a stale (None) identity and break login.
        token_secret = _extract_admin_token_secret(request)
        if token_secret is not None:
            meta = tokens.lookup(xom, token_secret)
            if meta is not None:
                # Cache for the identity hook so it doesn't re-read keyfs.
                request.environ["adm.token_meta"] = meta
                request.environ["adm.is_admin_token"] = True
                denied = _admin_token_check(request, meta)
                if denied is not None:
                    return denied
            # Invalid/expired token: let the identity hook return None and
            # devpi produce its own 401 — no scope enforcement needed for
            # an unauthenticated request.

        if request.method in ("GET", "HEAD"):
            if request.path == "/" and _wants_html(request):
                return HTTPFound("/+admin/")
            denied = _user_listing_check(request)
            if denied is not None:
                return denied
            denied = _read_acl_pre_check(request, xom)
            if denied is not None:
                return denied
            denied = _pkg_file_deny_check(request, xom)
            if denied is not None:
                return denied
            if request.method == "HEAD":
                return handler(request)
            response = handler(request)
            if request.path in ("/", "") and _is_json_response(response):
                return _filter_root_listing(request, response, xom)
            return response
        return handler(request)
    return tween


def _extract_admin_token_secret(request):
    """Return the admin token secret from the auth headers, or None.

    Inspects ``X-Devpi-Auth`` first, then falls back to RFC 7617 ``Basic``
    auth. Validates the prefix/format without invoking pyramid identity
    loading — pyramid caches identity per-request, and ``/+login`` mutates
    ``X-Devpi-Auth`` mid-request, so a premature load would pin a stale
    identity.
    """
    raw = request.headers.get("X-Devpi-Auth") or ""
    if not raw:
        auth = request.headers.get("Authorization") or ""
        # RFC 7617: auth-scheme is case-insensitive ("Basic", "basic", …).
        if auth[:6].lower() == "basic ":
            raw = auth[6:]
    if not raw:
        return None
    try:
        decoded = base64.b64decode(raw, validate=False).decode("utf-8", "replace")
    except Exception:
        return None
    if ":" not in decoded:
        return None
    _, secret = decoded.split(":", 1)
    if not tokens.looks_like_token(secret):
        return None
    return secret


def _request_carries_admin_token(request):
    """Return True iff the request auth headers carry an adm_ token.

    Thin wrapper kept for tests / callers that only need a boolean.
    """
    return _extract_admin_token_secret(request) is not None


def _admin_token_check(request, token_meta):
    """Restrict admin-token requests by scope and bound index.

    A token carries a ``scope`` (``read`` / ``upload``) and is bound to a
    specific ``user/index``. The tween enforces:

    * Method matrix per scope — see ``_SCOPE_METHODS``. ``DELETE`` is
      never granted; package removal must use password auth so a stolen
      upload token cannot wipe history.
    * URL must be ``/+api`` (devpi client discovery) or under the bound
      ``/<user>/<index>/...``. A token bound to ``alice/dev`` cannot
      reach ``/bob/prod`` or any management endpoint (``/+admin*``,
      ``/+admin-api/*``, ``/+login``, ``/+status``, ``/<user>``).

    Returns ``None`` to allow, or an HTTPForbidden response to deny.
    """
    scope = token_meta.get("scope")
    allowed = _SCOPE_METHODS.get(scope)
    if allowed is None:
        return HTTPForbidden(json_body={
            "error": f"admin token has unknown scope {scope!r}",
        })
    if request.method not in allowed:
        return HTTPForbidden(json_body={
            "error": f"admin token (scope={scope}) does not allow "
                     f"method {request.method}",
        })

    path = request.path
    # /+api is always allowed — devpi client discovery, leaks no data.
    if path == "/+api" or path == "/+api/":
        return None

    bound = token_meta.get("index", "")
    if "/" not in bound:
        # Defensive: lookup() should already reject metas without `index`.
        return HTTPForbidden(json_body={
            "error": "admin token has no bound index",
        })
    # Match exactly /<user>/<index> or /<user>/<index>/...
    prefix = "/" + bound
    if path == prefix or path.startswith(prefix + "/"):
        return None
    return HTTPForbidden(json_body={
        "error": f"admin token bound to {bound} cannot access {path}",
    })


def _user_listing_check(request):
    """Restrict ``GET /<user>/`` to that user or root.

    devpi-server otherwise leaks the full ``indexes`` dict (incl. private
    index names + ixconfig) to anyone — a one-segment GET is enough to
    enumerate a user's private indexes. Hide the resource from everyone
    except the owner and root; non-existent vs. private should both look
    like 404 / 403 to outsiders.
    """
    match = _USER_PATH_RE.match(request.path)
    if match is None:
        return None
    target_user = match.group(1)
    auth_user = request.authenticated_userid
    if auth_user == target_user or auth_user == "root":
        return None
    if auth_user is None:
        return HTTPForbidden(json_body={"error": "authentication required"})
    return HTTPNotFound(json_body={"error": "not found"})


def _read_acl_pre_check(request, xom):
    """Block GET on ``/<user>/<index>/...`` without ``pkg_read``.

    devpi-server has no permission check on these list/metadata endpoints,
    so without this guard an anonymous or unauthorised client can enumerate
    project names, fetch versiondata, or browse +simple of a private index.
    Returning HTTPNotFound hides the index existence from unauthorised
    principals; anonymous gets 403 so devpi/pip retry with credentials.

    File downloads (``/<user>/<index>/+f/...``) are also matched here —
    defense in depth on top of devpi's own ACL on the download view.
    Both checks evaluate ``pkg_read``, so the result is the same; this
    one just returns earlier.
    """
    match = _INDEX_ANY_RE.match(request.path)
    if match is None:
        return None
    user, index = match.group(1), match.group(2)
    try:
        stage = xom.model.getstage(user, index)
    except Exception:
        return None
    if stage is None:
        return None
    if request.has_permission("pkg_read", context=stage):
        return None
    if request.authenticated_userid is None:
        return HTTPForbidden(json_body={"error": "authentication required"})
    return HTTPNotFound(json_body={"error": "index not found"})


def _pkg_file_deny_check(request, xom):
    """Block ``/<user>/<index>/+f/<...>`` downloads of denied versions.

    The customizer's filter hooks already hide denied versions from the
    +simple/ index, but a previously-cached or shared direct file URL
    would otherwise still resolve. We parse the basename, derive
    ``(name, version)`` and apply the same allow/deny logic. The file
    on disk is left intact — removing the deny rule restores access
    without re-downloading from upstream.
    """
    match = _PKG_FILE_RE.match(request.path)
    if match is None:
        return None
    user, index, basename = match.group(1), match.group(2), match.group(3)
    try:
        stage = xom.model.getstage(user, index)
    except Exception:
        return None
    if stage is None or stage.ixconfig.get("type") != "mirror":
        return None
    allow_raw = stage.ixconfig.get("package_allowlist") or ()
    deny_raw = stage.ixconfig.get("package_denylist") or ()
    if not allow_raw and not deny_raw:
        return None
    try:
        from devpi_common.metadata import splitbasename
        from packaging.utils import canonicalize_name
        name, version, _ext = splitbasename(basename, checkarch=False)
    except Exception:
        # Unparseable filename: fall through to devpi (it'll 404 if the
        # entry is bogus). Filter is best-effort here.
        return None
    if not version:
        return None
    try:
        allow = parse_rules(allow_raw)
        deny = parse_rules(deny_raw)
    except Exception:
        # Stored rule is somehow invalid (shouldn't happen — validate_config
        # gates writes). Don't crash downloads on a bad rule.
        return None
    if is_version_allowed(canonicalize_name(name), version, allow, deny):
        return None
    return HTTPNotFound(json_body={"error": "package version blocked by index policy"})


def _is_json_response(response):
    ctype = getattr(response, "content_type", "") or ""
    return "json" in ctype.lower() and getattr(response, "status_code", 0) == 200


def _filter_root_listing(request, response, xom):
    """Strip indexes the requestor cannot read from GET / response.

    The root listing returns every user with their full indexes dict —
    including private index names and ixconfig. We rebuild the body with
    only the indexes the current principal has pkg_read for.
    """
    try:
        body = json.loads(response.body)
    except (ValueError, TypeError):
        return response
    result = body.get("result")
    if not isinstance(result, dict):
        return response
    filtered = {}
    for username, userdata in result.items():
        if not isinstance(userdata, dict):
            filtered[username] = userdata
            continue
        indexes = userdata.get("indexes")
        if not isinstance(indexes, dict):
            filtered[username] = userdata
            continue
        kept = {}
        for index_name in indexes:
            try:
                stage = xom.model.getstage(username, index_name)
            except Exception:
                stage = None
            if stage is None:
                continue
            if request.has_permission("pkg_read", context=stage):
                kept[index_name] = indexes[index_name]
        new_userdata = dict(userdata)
        new_userdata["indexes"] = kept
        filtered[username] = new_userdata
    body["result"] = filtered
    new_body = json.dumps(body).encode("utf-8")
    response.body = new_body
    response.content_length = len(new_body)
    # Filtered output is per-principal — never let a shared cache hand
    # one user's view to another.
    response.headers["Cache-Control"] = "private, no-store"
    return response


def _record_replica_poll(request):
    """Record a replica's most recent /+changelog/{N}- poll.

    Stores ``start_serial`` (the value the replica is asking the master
    for) keyed by replica UUID. The replica polls ``/+changelog/N-`` to
    fetch from serial N onwards, which means it has already applied
    serials 0..N-1. The displayed *applied* serial is therefore N-1.

    Also tracks ``first_seen_at_serial`` — when we first observed this
    exact ``start_serial`` for this replica. If the replica keeps polling
    the same serial for many seconds, replication is stuck (typically a
    plugin mismatch making import_changes fail).
    """
    if request.method != "GET":
        return
    m = _CHANGELOG_PATH_RE.match(request.path)
    if m is None:
        return
    uuid = request.headers.get(_H_REPLICA_UUID)
    if not uuid:
        return
    serial = int(m.group(1))
    now = time.time()
    prev = _replica_polls.get(uuid)
    if prev and prev.get("start_serial") == serial:
        first_seen = prev.get("first_seen_at_serial", now)
    else:
        first_seen = now
    _replica_polls[uuid] = {
        "start_serial": serial,
        "first_seen_at_serial": first_seen,
        "last_seen": now,
        "remote_ip": request.client_addr or "",
        "outside_url": request.headers.get(_H_REPLICA_OUTSIDE_URL) or "",
    }
    # Bound dict size — /+changelog/ is anonymously reachable in devpi,
    # so a malicious caller could spam unique UUIDs to exhaust memory.
    # Cleanup expired entries first; if still over the cap, evict the
    # least-recently-seen entry. Real deployments stay well under the
    # cap (one entry per real replica).
    if len(_replica_polls) > _REPLICA_POLL_MAX:
        cutoff = now - _REPLICA_POLL_TTL
        for k in list(_replica_polls.keys()):
            if _replica_polls[k]["last_seen"] < cutoff:
                del _replica_polls[k]
        while len(_replica_polls) > _REPLICA_POLL_MAX:
            oldest = min(
                _replica_polls,
                key=lambda k: _replica_polls[k]["last_seen"])
            del _replica_polls[oldest]


def _replicas_view(request):
    """GET /+admin-api/replicas — last-poll info per replica.

    Authoritative readout of where each replica is. The ``applied_serial``
    field is the highest serial the replica claims to have applied
    (start_serial - 1 from its most recent /+changelog/{N}- request).
    Compare against ``status.serial`` from /+status to detect stuck
    replicas reliably — no sampling, no heuristics.

    Auth required: replica UUIDs / outside URLs are operational
    metadata, not for anonymous consumption.
    """
    _require_authenticated(request)
    now = time.time()
    cutoff = now - _REPLICA_POLL_TTL
    result = {}
    for uuid in list(_replica_polls.keys()):
        info = _replica_polls[uuid]
        if info["last_seen"] < cutoff:
            del _replica_polls[uuid]
            continue
        first_seen = info.get("first_seen_at_serial", info["last_seen"])
        result[uuid] = {
            "start_serial": info["start_serial"],
            "applied_serial": info["start_serial"] - 1,
            "last_seen": info["last_seen"],
            "remote_ip": info["remote_ip"],
            "outside_url": info["outside_url"],
            "age_seconds": int(now - info["last_seen"]),
            # How long the replica has been polling THIS exact serial.
            # If high (> a few poll cycles) and non-zero lag, replica
            # cannot apply the changelog entry it just fetched.
            "stuck_seconds": int(now - first_seen),
        }
    return _json_response({"result": result})


def _wants_html(request):
    accept = request.headers.get("Accept") or ""
    if not accept:
        return False
    # Browsers send "text/html,application/xhtml+xml,...". JSON clients
    # (our SPA, devpi CLI) send "application/json".
    if "application/json" in accept and "text/html" not in accept:
        return False
    return "text/html" in accept or "*/*" in accept


# --- Token endpoints ---


def _make_user_changed_handler(xom):
    """Subscriber for USER key changes — cleans tokens on user/index removal.

    Runs in the keyfs notifier thread, after the transaction commits.

    * USER deleted (value is None) → wipe all tokens for that user.
    * USER mutated (e.g. ``DELETE /<user>/<index>``) → diff old vs new
      ``indexes`` dict; for each index that disappeared, wipe its tokens.

    Index removal isn't a separate keyfs key in devpi — the index lives
    inside USER.config['indexes'] — so we detect it by comparing the new
    USER value with the previous one fetched at ``ev.back_serial`` (same
    technique used by ``devpi_server.model.on_userchange``).
    """
    def _handler(ev):
        username = ev.typedkey.params.get("user")
        if not username:
            return
        try:
            if ev.value is None:
                count = tokens.reset_for_user(xom, username)
                if count:
                    _log.info(
                        "cleaned up %d admin token(s) for deleted user %s",
                        count, username)
                return
            removed = _removed_indexes(xom, ev)
            for idx_name in removed:
                count = tokens.reset_for_index(xom, username, idx_name)
                if count:
                    _log.info(
                        "cleaned up %d admin token(s) for deleted "
                        "index %s/%s",
                        count, username, idx_name)
        except Exception:
            _log.exception(
                "admin token cleanup failed for user=%s", username)
    return _handler


def _removed_indexes(xom, ev):
    """Return index names present in the previous USER value but not the new."""
    new_indexes = set((ev.value.get("indexes") or {}).keys())
    if ev.back_serial < 0:
        return set()
    keyfs = xom.keyfs
    try:
        with keyfs.read_transaction(at_serial=ev.at_serial) as tx:
            try:
                old = tx.get_value_at(ev.typedkey, ev.back_serial)
            except KeyError:
                return set()
    except Exception:
        _log.warning(
            "could not fetch previous USER value for diff", exc_info=True)
        return set()
    old_indexes = set((old.get("indexes") or {}).keys()) if old else set()
    return old_indexes - new_indexes


def _is_replica(xom):
    return getattr(xom.config, "role", "primary") == "replica"


def _refuse_on_replica(xom):
    if _is_replica(xom):
        raise HTTPBadRequest(
            json_body={"error": "this operation must be sent to the primary"})


def _require_authenticated(request):
    user = request.authenticated_userid
    if user is None:
        raise HTTPForbidden(json_body={"error": "authentication required"})
    return user


def _validate_name(value, kind):
    if not isinstance(value, str) or not _NAME_RE.match(value):
        raise HTTPBadRequest(
            json_body={"error": f"invalid {kind} name: {value!r}"})


def _check_can_issue(request, target_user):
    """Permission rule for token *issuance*.

    * Regular user → may issue tokens for themselves only.
    * Root → may issue tokens for **any other** user (admin delegation: hand
      a CI account a token without that account having to log in). Root may
      NOT issue tokens for itself; a token bound to root would carry
      server-wide privileges via devpi's special root ACL handling.
    * Admin-token requests → never; a stolen token must not be able to
      mint successors and outlive its TTL.

    Tokens are also bound to a specific index (validated separately in
    ``_check_index_perm``); this function only governs *who* may issue.
    """
    auth_user = _require_authenticated(request)
    if request.environ.get("adm.is_admin_token"):
        raise HTTPForbidden(json_body={
            "error": "admin tokens cannot issue further tokens — "
                     "authenticate with a password",
        })
    if auth_user == "root":
        if target_user == "root":
            raise HTTPForbidden(json_body={
                "error": "root may not issue tokens for itself",
            })
        return auth_user
    if auth_user != target_user:
        raise HTTPForbidden(json_body={
            "error": "users can only issue tokens for themselves",
        })
    return auth_user


def _check_index_perm(stage, target_user, scope):
    """Verify ``target_user`` has the given ``scope`` permission on the index.

    We can't use ``request.has_permission`` here because root may issue for
    a third party — ``has_permission`` evaluates against the *authenticated*
    identity, which would be root. Instead we read the ACL list directly
    and check membership, mirroring devpi's own principal logic without
    the implicit root-grants-itself-read shortcut (which doesn't apply to
    a non-root token-bearer anyway).

    ``:ANONYMOUS:`` and ``:AUTHENTICATED:`` grant transitively to any
    real user, so they pass the check. Devpi's ``ensure_acl_list``
    normalises specials to upper case at write time, but we case-fold
    here defensively in case a record was written via another path.
    """
    if scope == "read":
        principals = stage.ixconfig.get("acl_read", [])
    elif scope == "upload":
        principals = stage.ixconfig.get("acl_upload", [])
    else:
        raise HTTPBadRequest(json_body={"error": f"invalid scope: {scope!r}"})
    principals = list(principals) if principals else []
    upper_specials = {
        p.upper() for p in principals
        if isinstance(p, str) and p.startswith(":") and p.endswith(":")}
    if (":ANONYMOUS:" in upper_specials
            or ":AUTHENTICATED:" in upper_specials
            or target_user in principals):
        return
    raise HTTPForbidden(json_body={
        "error": f"user {target_user!r} does not have {scope} permission "
                 f"on this index",
    })


def _check_can_manage(request, target_user):
    """Permission rule for *listing* / *revoking* tokens.

    The user themselves may manage their own tokens; root may manage any
    user's tokens (incident response, offboarding). Admin-token requests
    are rejected — tween already blocks ``/+admin-api/*`` for those, this
    is a defence-in-depth check.
    """
    auth_user = _require_authenticated(request)
    if request.environ.get("adm.is_admin_token"):
        raise HTTPForbidden(json_body={
            "error": "admin tokens cannot manage tokens",
        })
    if auth_user == target_user or auth_user == "root":
        return auth_user
    raise HTTPForbidden(json_body={
        "error": "only the token owner or root may manage these tokens",
    })


_TRUSTED_PROXIES_ENV = "DEVPI_ADMIN_TRUSTED_PROXIES"
_trusted_proxies_cache = None


def _trusted_proxies():
    """Parse and cache trusted-proxy CIDR list from environment.

    Format: comma-separated CIDRs or single IPs in
    ``DEVPI_ADMIN_TRUSTED_PROXIES``, e.g. ``10.0.0.0/8,127.0.0.1``.
    Empty → no proxies trusted (X-Forwarded-For ignored).
    """
    global _trusted_proxies_cache
    if _trusted_proxies_cache is not None:
        return _trusted_proxies_cache
    raw = os.environ.get(_TRUSTED_PROXIES_ENV, "")
    nets = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            nets.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            _log.warning(
                "ignoring invalid CIDR in %s: %r", _TRUSTED_PROXIES_ENV, part)
    _trusted_proxies_cache = nets
    return nets


def _client_ip(request):
    """Return the client IP, honouring X-Forwarded-For only via trusted proxy.

    Without a configured trusted-proxy list, the raw ``X-Forwarded-For``
    header is forgeable, so we fall back to ``request.client_addr``. With a
    list set, the header is honoured iff the immediate peer is one of the
    trusted networks — same model as nginx ``set_real_ip_from``.
    """
    direct = request.client_addr or ""
    nets = _trusted_proxies()
    if not nets or not direct:
        return direct
    try:
        peer = ipaddress.ip_address(direct)
    except ValueError:
        return direct
    if not any(peer in net for net in nets):
        return direct
    xff = request.headers.get("X-Forwarded-For", "")
    if not xff:
        return direct
    # First entry in XFF is the original client; subsequent entries are
    # intermediate proxies. We do not verify the chain — that's the job of
    # the configured trusted proxy list at the network layer.
    return xff.split(",")[0].strip() or direct


_REPLICA_WAIT_MAX = 30           # hard upper bound, seconds
_REPLICA_WAIT_INTERVAL = 0.25    # poll cadence
_REPLICA_STALE_AFTER = 120       # ignore replicas silent for >2 min


def _wait_for_replicas(xom, timeout):
    """Block until all currently polling replicas catch up to the latest serial.

    Solves the Ansible-style race: a playbook calls ``POST /+admin-api/token``
    and immediately uses the token against the load balancer, which may route
    to a replica that hasn't yet replicated the new token record (default
    poll interval ~37 s). Without this wait the next request returns 401.

    Reads ``xom.polling_replicas`` (populated by replicas as they poll the
    primary) and waits until each replica's reported serial reaches the
    primary's current serial. Replicas that haven't been heard from for
    over ``_REPLICA_STALE_AFTER`` seconds are skipped — we don't block the
    caller because of an offline replica.

    Returns dict with ``synced``/``waited``/``timed_out`` so the response
    can include diagnostics. Bounded by ``_REPLICA_WAIT_MAX``.
    """
    timeout = max(0, min(int(timeout or 0), _REPLICA_WAIT_MAX))
    target_serial = xom.keyfs.get_current_serial()
    started = time.monotonic()
    deadline = started + timeout

    def _live_replicas():
        polling = getattr(xom, "polling_replicas", None) or {}
        now = time.time()
        return {
            uuid: info for uuid, info in polling.items()
            if now - info.get("last-request", 0) < _REPLICA_STALE_AFTER
        }

    while True:
        live = _live_replicas()
        if not live:
            return {
                "synced": True, "waited": 0.0, "timed_out": False,
                "target_serial": target_serial, "replicas": 0,
            }
        lagging = [
            uuid for uuid, info in live.items()
            if int(info.get("serial", -1)) < target_serial
        ]
        if not lagging:
            return {
                "synced": True,
                "waited": round(time.monotonic() - started, 3),
                "timed_out": False,
                "target_serial": target_serial,
                "replicas": len(live),
            }
        if time.monotonic() >= deadline:
            return {
                "synced": False,
                "waited": round(time.monotonic() - started, 3),
                "timed_out": True,
                "target_serial": target_serial,
                "replicas": len(live),
                "lagging": len(lagging),
            }
        time.sleep(_REPLICA_WAIT_INTERVAL)


def _parse_wait_replicas(value):
    """Parse a wait_replicas parameter (bool-ish or seconds) into a timeout.

    Accepts: ``""``/``0``/``false`` → 0 (no wait), ``true``/``1`` → default
    timeout, integer string → seconds (capped at ``_REPLICA_WAIT_MAX``).
    """
    if value is None or value == "":
        return 0
    s = str(value).strip().lower()
    if s in ("0", "false", "no", "off"):
        return 0
    if s in ("true", "yes", "on"):
        return _REPLICA_WAIT_MAX
    try:
        return max(0, min(int(s), _REPLICA_WAIT_MAX))
    except ValueError:
        return 0


def _issue_token_view(request):
    """POST /+admin-api/token

    Body (JSON): {
        "user": "gitea-ci",          # optional, default = authenticated
        "index": "gitea-ci/dev",     # required: bound 'user/index'
        "scope": "read",             # required: 'read' or 'upload'
        "ttl_seconds": 3600,         # optional, default 1h, max 1y
        "label": "build-ci"          # optional
    }
    """
    xom = request.registry["xom"]
    _refuse_on_replica(xom)
    try:
        body = request.json_body if request.body else {}
    except (ValueError, TypeError):
        raise HTTPBadRequest(json_body={"error": "invalid JSON body"})

    auth_user = _require_authenticated(request)
    target = body.get("user") or auth_user
    _validate_name(target, "user")
    _check_can_issue(request, target)

    if xom.model.get_user(target) is None:
        raise HTTPNotFound(
            json_body={"error": f"user {target!r} does not exist"})

    index = body.get("index", "")
    if not isinstance(index, str) or "/" not in index:
        raise HTTPBadRequest(
            json_body={"error": "index must be 'user/index'"})
    idx_user, idx_name = index.split("/", 1)
    _validate_name(idx_user, "user")
    _validate_name(idx_name, "index")
    stage = xom.model.getstage(idx_user, idx_name)
    if stage is None:
        raise HTTPNotFound(
            json_body={"error": f"index {index!r} does not exist"})

    scope = body.get("scope", "read")
    if scope not in tokens.VALID_SCOPES:
        raise HTTPBadRequest(json_body={
            "error": f"scope must be one of {list(tokens.VALID_SCOPES)}",
        })
    _check_index_perm(stage, target, scope)

    ttl = body.get("ttl_seconds", tokens.DEFAULT_TTL)
    try:
        ttl = int(ttl)
    except (TypeError, ValueError):
        raise HTTPBadRequest(json_body={"error": "ttl_seconds must be int"})
    if ttl < 60:
        raise HTTPBadRequest(
            json_body={"error": "ttl_seconds must be >= 60"})
    if ttl > tokens.DEFAULT_MAX_TTL:
        raise HTTPBadRequest(json_body={
            "error": f"ttl_seconds must be <= {tokens.DEFAULT_MAX_TTL}"})

    label = body.get("label", "")
    if not isinstance(label, str) or len(label) > 200:
        raise HTTPBadRequest(
            json_body={"error": "label must be a string up to 200 chars"})

    wait_seconds = _parse_wait_replicas(body.get("wait_replicas"))

    token, meta = tokens.issue(
        xom,
        target_user=target, target_index=index, scope=scope,
        issuer=auth_user, ttl_seconds=ttl,
        label=label, client_ip=_client_ip(request))
    response = {
        "token": token,
        "user": meta["user"],
        "index": meta["index"],
        "scope": meta["scope"],
        "issued_at": meta["issued_at"],
        "expires_at": meta["expires_at"],
        "label": meta["label"],
    }
    if wait_seconds > 0:
        response["replication"] = _wait_for_replicas(xom, wait_seconds)
    return _json_response(response)


def _build_pip_conf(public_url, target_user, token, index_path):
    return (
        "[global]\n"
        f"index-url = {_inject_creds(public_url, target_user, token)}/{index_path}/+simple/\n"
        f"trusted-host = {_host_from_url(public_url)}\n"
    )


def _inject_creds(url, user, token):
    """Insert user:token@ into the authority part of an http(s) URL."""
    m = re.match(r"^(https?://)([^/]+)(.*)$", url)
    if not m:
        return url
    from urllib.parse import quote
    return f"{m.group(1)}{quote(user, safe='')}:{quote(token, safe='')}@{m.group(2)}{m.group(3)}"


def _host_from_url(url):
    m = re.match(r"^https?://([^/:]+)", url)
    return m.group(1) if m else ""


def _pip_conf_view(request):
    """GET /+admin-api/pip-conf?index=user/index&ttl=3600&user=...&label=...

    Issues a token (same rules as POST /token) and returns a ready-to-use
    pip.conf file (text/plain). Designed for one-shot CI/Ansible use.
    """
    xom = request.registry["xom"]
    _refuse_on_replica(xom)

    auth_user = _require_authenticated(request)
    target = request.params.get("user") or auth_user
    _validate_name(target, "user")
    _check_can_issue(request, target)
    if xom.model.get_user(target) is None:
        raise HTTPNotFound(
            json_body={"error": f"user {target!r} does not exist"})

    index = request.params.get("index", "")
    if "/" not in index:
        raise HTTPBadRequest(
            json_body={"error": "index parameter must be 'user/index'"})
    idx_user, idx_name = index.split("/", 1)
    _validate_name(idx_user, "user")
    _validate_name(idx_name, "index")
    stage = xom.model.getstage(idx_user, idx_name)
    if stage is None:
        raise HTTPNotFound(
            json_body={"error": f"index {index!r} does not exist"})
    # pip.conf is always a read-scope token (pip never uploads). Verify the
    # bound user has read on the target index, mirroring _issue_token_view.
    _check_index_perm(stage, target, "read")

    try:
        ttl = int(request.params.get("ttl", tokens.DEFAULT_TTL))
    except ValueError:
        raise HTTPBadRequest(json_body={"error": "ttl must be int"})
    if ttl < 60 or ttl > tokens.DEFAULT_MAX_TTL:
        raise HTTPBadRequest(json_body={
            "error": f"ttl must be between 60 and {tokens.DEFAULT_MAX_TTL}"})

    label = request.params.get("label", f"pip-conf {index}")[:200]

    wait_seconds = _parse_wait_replicas(request.params.get("wait_replicas"))

    token, _meta = tokens.issue(
        xom,
        target_user=target, target_index=index, scope="read",
        issuer=auth_user, ttl_seconds=ttl,
        label=label, client_ip=_client_ip(request))
    if wait_seconds > 0:
        _wait_for_replicas(xom, wait_seconds)

    public_url = request.application_url.rstrip("/")
    body = _build_pip_conf(public_url, target, token, index)
    return Response(
        body=body.encode("utf-8"),
        content_type="text/plain",
        charset="utf-8")


def _list_tokens_view(request):
    """GET /+admin-api/users/{user}/tokens

    User can list own tokens; root can list anyone's.
    Returns list of token records (without the secret token string itself).
    """
    xom = request.registry["xom"]
    target = request.matchdict["user"]
    _validate_name(target, "user")
    _check_can_manage(request, target)
    items = tokens.list_for_user(xom, target)
    result = [_format_token_record(tid, meta) for tid, meta in items]
    return _json_response({"result": result, "count": len(result)})


def _format_token_record(tid, meta):
    now = int(time.time())
    return {
        "id": tid,
        "id_short": tid[:8],
        "user": meta.get("user"),
        "index": meta.get("index", ""),
        "scope": meta.get("scope", ""),
        "issuer": meta.get("issuer"),
        "issued_at": meta.get("issued_at"),
        "expires_at": meta.get("expires_at"),
        "expires_in": max(0, int(meta.get("expires_at", 0) - now)),
        "label": meta.get("label", ""),
        "client_ip": meta.get("client_ip", ""),
    }


def _list_index_tokens_view(request):
    """GET /+admin-api/indexes/{user}/{index}/tokens

    List active tokens bound to this index. Visibility:
    * root → all tokens for this index
    * non-root → only tokens issued by / for the requester
    Anyone without ``pkg_read`` on the index gets 404 (hide existence).
    """
    xom = request.registry["xom"]
    auth_user = _require_authenticated(request)
    if request.environ.get("adm.is_admin_token"):
        raise HTTPForbidden(json_body={
            "error": "admin tokens cannot list tokens",
        })
    idx_user = request.matchdict["user"]
    idx_name = request.matchdict["index"]
    _validate_name(idx_user, "user")
    _validate_name(idx_name, "index")
    stage = xom.model.getstage(idx_user, idx_name)
    if stage is None:
        raise HTTPNotFound(json_body={"error": "index not found"})
    if not request.has_permission("pkg_read", context=stage):
        # Hide existence from anyone without read access.
        raise HTTPNotFound(json_body={"error": "index not found"})
    items = tokens.list_for_index(xom, idx_user, idx_name)
    if auth_user != "root":
        items = [(tid, meta) for tid, meta in items
                 if meta.get("user") == auth_user]
    result = [_format_token_record(tid, meta) for tid, meta in items]
    return _json_response({"result": result, "count": len(result)})


def _revoke_token_view(request):
    """DELETE /+admin-api/tokens/{token_id}"""
    xom = request.registry["xom"]
    _refuse_on_replica(xom)
    tid = request.matchdict["token_id"]
    if not tokens.looks_like_token_id(tid):
        raise HTTPBadRequest(json_body={"error": "invalid token id"})
    keyfs = xom.keyfs
    with keyfs.read_transaction(allow_reuse=True):
        meta_key = keyfs.get_key(tokens.KEY_TOKEN)(token_id=tid)
        if not meta_key.exists():
            raise HTTPNotFound(json_body={"error": "token not found"})
        meta = dict(meta_key.get())
    _check_can_manage(request, meta.get("user", ""))
    tokens.revoke(xom, tid)
    return _json_response({"revoked": True, "id": tid})


def _reset_tokens_view(request):
    """DELETE /+admin-api/users/{user}/tokens — revoke all for a user."""
    xom = request.registry["xom"]
    _refuse_on_replica(xom)
    target = request.matchdict["user"]
    _validate_name(target, "user")
    _check_can_manage(request, target)
    count = tokens.reset_for_user(xom, target)
    return _json_response({"revoked": count, "user": target})
