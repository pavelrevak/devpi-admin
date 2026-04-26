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

# Paths that an admin-token request is permitted to GET. Anything else is
# blocked: management pages (`/`, `/+admin*`, `/+admin-api/*`, `/+status`),
# the user resource itself, and any non-GET method (no upload, no
# password change, no `/+login` exchange, no nested token issuance).
_TOKEN_ALLOWED_PATH_RE = re.compile(
    r"^/(\+api/?|[^/+][^/]*/[^/+][^/]*(/.*)?)$")


@hookimpl
def devpiserver_get_features():
    return {"devpi-admin"}


@hookimpl
def devpiserver_indexconfig_defaults(index_type):
    # ACLList marker tells devpi to validate values via ensure_acl_list()
    # on every PUT/PATCH (normalizes :ANONYMOUS:/:AUTHENTICATED: case,
    # accepts comma-separated strings, strips whitespace).
    return {"acl_read": ACLList([":ANONYMOUS:"])}


@hookimpl
def devpiserver_stage_get_principals_for_pkg_read(ixconfig):
    return ixconfig.get("acl_read", [":ANONYMOUS:"])


@hookimpl
def devpiserver_get_identity(request, credentials):
    """Recognize and validate adm_ tokens.

    Returns CredentialsIdentity if the credentials carry a valid admin
    token. Returns None otherwise so devpi's default identity hook handles
    standard tokens/passwords. Sets request.environ["adm.is_admin_token"]
    so the tween can apply read-only / no-escalation enforcement.
    """
    if credentials is None:
        return None
    user, secret = credentials
    if not tokens.looks_like_token(secret):
        return None
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
    return CredentialsIdentity(user, [])


@hookimpl
def devpiserver_pyramid_configure(config, pyramid_config):
    # Register our keyfs keys early so token endpoints can read/write.
    xom = pyramid_config.registry.get("xom")
    if xom is not None:
        tokens.register_keyfs_keys(xom.keyfs)
        # Clean up tokens when a user is deleted. Only on primary —
        # replicas are read-only.
        role = getattr(xom.config, "role", "primary")
        if role != "replica":
            xom.keyfs.USER.on_key_change(_make_user_deleted_handler(xom))
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


def _serve_index(request):
    return FileResponse(
        str(STATIC_DIR / "index.html"),
        request=request,
        content_type="text/html")


def _session_view(request):
    """Return whether the current request carries a valid authenticated session."""
    user = request.authenticated_userid
    if user:
        return _json_response({"valid": True, "user": user})
    raise HTTPForbidden(json_body={"valid": False, "error": "not authenticated"})


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


def _cached_packages_view(request):
    """Return list of project names that have cached files on disk.

    Scans the ``+files/{user}/{index}/`` directory for downloaded wheels
    and sdists, extracts project names from filenames via
    ``packaging.utils``, and returns deduplicated sorted list.
    """
    user = request.matchdict["user"]
    index = request.matchdict["index"]
    xom = request.registry["xom"]

    stage = _get_stage_or_404(xom, user, index)
    _check_read_access(request, stage)
    if not isinstance(stage, MirrorStage):
        return HTTPNotFound(
            json_body={"error": "not a mirror index"})

    files_dir = _files_dir(xom, user, index)
    projects = set()
    try:
        for whl in files_dir.rglob("*"):
            if not whl.is_file():
                continue
            name, _ver = _parse_filename(whl.name)
            if name:
                projects.add(name)
    except OSError:
        _log.warning("Cannot scan %s", files_dir, exc_info=True)

    cached = sorted(projects)
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
    files_dir = _files_dir(xom, user, index)
    versions = set()
    norm_project = _normalize(project)
    try:
        for f in files_dir.rglob("*"):
            if not f.is_file():
                continue
            name, ver = _parse_filename(f.name)
            if name == norm_project and ver:
                versions.add(ver)
    except OSError:
        _log.warning("Cannot scan %s", files_dir, exc_info=True)
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
        # Detect admin token directly from header instead of forcing
        # request.identity to load. Pyramid caches identity per-request,
        # and POST /+login mutates X-Devpi-Auth mid-request — pre-loading
        # here would pin a stale (None) identity and break login.
        if _request_carries_admin_token(request):
            denied = _admin_token_check(request)
            if denied is not None:
                return denied

        if request.method == "GET":
            if request.path == "/" and _wants_html(request):
                return HTTPFound("/+admin/")
            denied = _user_listing_check(request)
            if denied is not None:
                return denied
            denied = _read_acl_pre_check(request, xom)
            if denied is not None:
                return denied
            response = handler(request)
            if request.path in ("/", "") and _is_json_response(response):
                return _filter_root_listing(request, response, xom)
            return response
        return handler(request)
    return tween


def _request_carries_admin_token(request):
    """Return True iff the X-Devpi-Auth or Basic auth header carries an adm_ token.

    This inspects the credential string by prefix without invoking pyramid's
    identity loading (which caches per-request and breaks /+login flow).
    """
    raw = request.headers.get("X-Devpi-Auth") or ""
    if not raw:
        auth = request.headers.get("Authorization") or ""
        if auth.startswith("Basic "):
            raw = auth[6:]
    if not raw:
        return False
    try:
        decoded = base64.b64decode(raw, validate=False).decode("utf-8", "replace")
    except Exception:
        return False
    if ":" not in decoded:
        return False
    _, secret = decoded.split(":", 1)
    return tokens.looks_like_token(secret)


def _admin_token_check(request):
    """Restrict admin-token requests to read-only access on index/archive paths.

    Admin tokens exist for one purpose: machine reads of indexes and package
    archives (pip install, devpi download). They MUST NOT be usable for:
    user/index management, package upload, ``/+login`` exchange, SPA pages,
    nested admin-api calls (incl. issuing further tokens), or status/admin
    introspection.

    Rules:
    * Only ``GET`` / ``HEAD`` is allowed.
    * The path must be ``/+api`` (devpi client discovery) or fall under
      ``/<user>/<index>/...``. Single-segment paths (``/``, ``/<user>``),
      everything under ``/+admin*`` and ``/+admin-api/*``, ``/+login``,
      ``/+status`` etc. are denied.
    """
    if request.method not in ("GET", "HEAD"):
        return HTTPForbidden(json_body={
            "error": "admin token is read-only — use password auth for "
                     "writes and management",
        })
    if not _TOKEN_ALLOWED_PATH_RE.match(request.path):
        return HTTPForbidden(json_body={
            "error": "admin token may only access /+api or "
                     "/<user>/<index>/... (index data and archives)",
        })
    return None


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

    Files (``/<user>/<index>/+f/...``) are NOT pre-checked here — the
    download view in devpi-server enforces its own ACL on those URLs.
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


def _make_user_deleted_handler(xom):
    """Subscriber for USER key changes — cleans up tokens on user deletion.

    Runs in the keyfs notifier thread, after the deleting transaction commits.
    Only delete events (value is None) trigger cleanup; password/email changes
    leave tokens intact.
    """
    def _handler(ev):
        if ev.value is not None:
            return
        username = ev.typedkey.params.get("user")
        if not username:
            return
        try:
            count = tokens.reset_for_user(xom, username)
            if count:
                _log.info(
                    "cleaned up %d admin token(s) for deleted user %s",
                    count, username)
        except Exception:
            _log.exception(
                "admin token cleanup failed for deleted user %s", username)
    return _handler


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

    Only regular users may issue tokens, and only for themselves. Root is
    forbidden from issuing tokens entirely — a leaked root token would have
    full server-wide privileges. Requests already authenticated via an admin
    token are also rejected, so a leaked token cannot mint successor tokens
    and outlive its TTL.
    """
    auth_user = _require_authenticated(request)
    if request.environ.get("adm.is_admin_token"):
        raise HTTPForbidden(json_body={
            "error": "admin tokens cannot issue further tokens — "
                     "authenticate with a password",
        })
    if auth_user == "root":
        raise HTTPForbidden(json_body={
            "error": "root may not issue admin tokens; "
                     "create a regular user account for automation",
        })
    if auth_user != target_user:
        raise HTTPForbidden(json_body={
            "error": "users can only issue tokens for themselves",
        })
    return auth_user


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


def _issue_token_view(request):
    """POST /+admin-api/token

    Body (JSON): {
        "user": "gitea-ci",          # optional, default = authenticated
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

    token, meta = tokens.issue(
        xom,
        target_user=target, issuer=auth_user, ttl_seconds=ttl,
        label=label, client_ip=_client_ip(request))
    return _json_response({
        "token": token,
        "user": meta["user"],
        "issued_at": meta["issued_at"],
        "expires_at": meta["expires_at"],
        "label": meta["label"],
    })


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
    if xom.model.getstage(idx_user, idx_name) is None:
        raise HTTPNotFound(
            json_body={"error": f"index {index!r} does not exist"})

    try:
        ttl = int(request.params.get("ttl", tokens.DEFAULT_TTL))
    except ValueError:
        raise HTTPBadRequest(json_body={"error": "ttl must be int"})
    if ttl < 60 or ttl > tokens.DEFAULT_MAX_TTL:
        raise HTTPBadRequest(json_body={
            "error": f"ttl must be between 60 and {tokens.DEFAULT_MAX_TTL}"})

    label = request.params.get("label", f"pip-conf {index}")[:200]

    token, _meta = tokens.issue(
        xom,
        target_user=target, issuer=auth_user, ttl_seconds=ttl,
        label=label, client_ip=_client_ip(request))

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
    result = []
    now = int(time.time())
    for tid, meta in items:
        result.append({
            "id": tid,
            "id_short": tid[:8],
            "user": meta.get("user"),
            "issuer": meta.get("issuer"),
            "issued_at": meta.get("issued_at"),
            "expires_at": meta.get("expires_at"),
            "expires_in": max(0, int(meta.get("expires_at", 0) - now)),
            "label": meta.get("label", ""),
            "client_ip": meta.get("client_ip", ""),
        })
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
