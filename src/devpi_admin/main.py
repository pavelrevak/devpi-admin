"""devpi-admin: web UI plugin for devpi-server.

Installs a single-page application that replaces devpi-web. The SPA is served
under ``/+admin/`` and browser requests to ``/`` are redirected there. All
existing devpi REST API endpoints are left untouched — the JS app talks to
the standard devpi JSON API (``/+login``, ``/<user>/<index>``, ...).
"""
import json
import logging
import re
from pathlib import Path

from devpi_server.config import hookimpl
from devpi_server.mirror import MirrorStage
from pyramid.httpexceptions import HTTPFound, HTTPForbidden, HTTPNotFound
from pyramid.response import FileResponse, Response


STATIC_DIR = Path(__file__).parent / "static"
_NORMALIZE_RE = re.compile(r"[-_.]+")
_SDIST_EXTENSIONS = (".tar.gz", ".tar.bz2", ".zip")
_log = logging.getLogger(__name__)


@hookimpl
def devpiserver_get_features():
    return {"devpi-admin"}


@hookimpl
def devpiserver_pyramid_configure(config, pyramid_config):
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


def _get_stage_or_404(xom, user, index):
    """Return stage object or raise HTTPNotFound."""
    stage = xom.model.getstage(user, index)
    if stage is None:
        raise HTTPNotFound(json_body={"error": "index not found"})
    return stage


def _check_read_access(request, stage):
    """Raise HTTPForbidden if the request has no read access to the stage.

    Mirrors the ACL check devpi's own views perform: the stage's acl_read
    list controls who may read.  An empty list means public access.
    """
    acl_read = getattr(stage.ixconfig, "acl_read", None)
    if not acl_read:
        return  # public index
    principals = request.authenticated_userid
    if principals is None:
        raise HTTPForbidden(json_body={"error": "authentication required"})
    # ':ANONYMOUS:' in acl_read means public
    if ":ANONYMOUS:" in acl_read:
        return
    if principals not in acl_read:
        raise HTTPForbidden(json_body={"error": "read access denied"})


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
    def tween(request):
        if (request.method == "GET"
                and request.path == "/"
                and _wants_html(request)):
            return HTTPFound("/+admin/")
        return handler(request)
    return tween


def _wants_html(request):
    accept = request.headers.get("Accept") or ""
    if not accept:
        return False
    # Browsers send "text/html,application/xhtml+xml,...". JSON clients
    # (our SPA, devpi CLI) send "application/json".
    if "application/json" in accept and "text/html" not in accept:
        return False
    return "text/html" in accept or "*/*" in accept
