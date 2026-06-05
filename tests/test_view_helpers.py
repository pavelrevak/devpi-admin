"""Tests for view-layer helpers (_get_stage_or_404, _check_read_access)."""
import json
import unittest
from unittest.mock import MagicMock, patch

from pyramid.httpexceptions import HTTPBadRequest, HTTPForbidden, HTTPNotFound

from devpi_admin.main import (
    _check_read_access, _get_stage_or_404, _refresh_mirror_cache_view,
    _serve_index, _versiondata_view)


class GetStageOr404Tests(unittest.TestCase):

    def test_returns_stage(self):
        xom = MagicMock()
        stage = MagicMock()
        xom.model.getstage.return_value = stage
        self.assertIs(_get_stage_or_404(xom, "alice", "dev"), stage)

    def test_raises_404_when_missing(self):
        xom = MagicMock()
        xom.model.getstage.return_value = None
        with self.assertRaises(HTTPNotFound):
            _get_stage_or_404(xom, "ghost", "ix")


class CheckReadAccessTests(unittest.TestCase):

    def _make(self, allow, auth_user):
        req = MagicMock()
        req.has_permission.return_value = allow
        req.authenticated_userid = auth_user
        return req

    def test_allowed_returns_none(self):
        # Should silently pass — no exception, no return value relied upon.
        self.assertIsNone(
            _check_read_access(self._make(True, "alice"), MagicMock()))

    def test_denied_anonymous_gets_403(self):
        # Anonymous denial returns 403 so devpi-cli / pip can retry with auth.
        with self.assertRaises(HTTPForbidden):
            _check_read_access(self._make(False, None), MagicMock())

    def test_denied_authenticated_gets_404(self):
        # Authenticated user without read access gets 404 — hides the
        # existence of the private index.
        with self.assertRaises(HTTPNotFound):
            _check_read_access(self._make(False, "bob"), MagicMock())


class ServeIndexTests(unittest.TestCase):

    def _serve(self):
        # FileResponse needs a real file on disk; STATIC_DIR/index.html
        # is bundled and exists in test runs (verified by test_package).
        request = MagicMock()
        return _serve_index(request)

    def test_csp_header_present(self):
        resp = self._serve()
        csp = resp.headers.get("Content-Security-Policy", "")
        self.assertIn("default-src 'self'", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertIn("script-src 'self'", csp)
        # inline script must NOT be allowed
        self.assertNotIn("'unsafe-inline'", csp.split("script-src")[1].split(";")[0])

    def test_csp_allows_pypi_for_readme_fallback(self):
        resp = self._serve()
        csp = resp.headers.get("Content-Security-Policy", "")
        self.assertIn("https://pypi.org", csp)

    def test_security_headers_present(self):
        resp = self._serve()
        self.assertEqual(resp.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(resp.headers.get("Referrer-Policy"), "no-referrer")


class RefreshMirrorCacheViewTests(unittest.TestCase):

    def _stub_xom(self, stage=None, is_replica=False):
        xom = MagicMock()
        xom.config.role = "replica" if is_replica else "primary"
        xom.model.getstage.return_value = stage
        ctx = MagicMock()
        ctx.__enter__ = MagicMock(return_value=ctx)
        ctx.__exit__ = MagicMock(return_value=False)
        xom.keyfs.read_transaction.return_value = ctx
        return xom

    def _stub_mirror_stage(self, tracked_projects=("setuptools", "pip")):
        stage = MagicMock()
        stage.ixconfig = {"type": "mirror"}
        stage.cache_retrieve_times._project2time = {
            p: (1.0, None) for p in tracked_projects}
        stage.cache_retrieve_times.expire = MagicMock()
        stage.cache_projectnames.expire = MagicMock()
        return stage

    def _make(self, xom, user="root", index="pypi", auth_user="alice"):
        req = MagicMock()
        req.registry = {"xom": xom}
        req.matchdict = {"user": user, "index": index}
        req.authenticated_userid = auth_user
        return req

    def test_expires_all_tracked_projects_and_projectnames(self):
        stage = self._stub_mirror_stage(("setuptools", "pip", "wheel"))
        xom = self._stub_xom(stage=stage)
        with patch("devpi_admin.main._is_replica", return_value=False):
            resp = _refresh_mirror_cache_view(self._make(xom))
        body = json.loads(resp.body)
        self.assertEqual(body["result"]["projects_invalidated"], 3)
        self.assertTrue(body["result"]["projectnames_invalidated"])
        # Every tracked project must have been expired exactly once;
        # the project-names cache must be expired regardless.
        self.assertEqual(stage.cache_retrieve_times.expire.call_count, 3)
        stage.cache_projectnames.expire.assert_called_once_with()

    def test_404_when_index_missing(self):
        xom = self._stub_xom(stage=None)
        with patch("devpi_admin.main._is_replica", return_value=False):
            with self.assertRaises(HTTPNotFound):
                _refresh_mirror_cache_view(self._make(xom))

    def test_400_when_index_is_not_mirror(self):
        stage = MagicMock()
        stage.ixconfig = {"type": "stage"}
        xom = self._stub_xom(stage=stage)
        with patch("devpi_admin.main._is_replica", return_value=False):
            with self.assertRaises(HTTPBadRequest):
                _refresh_mirror_cache_view(self._make(xom))

    def test_replica_refuses(self):
        xom = self._stub_xom(stage=self._stub_mirror_stage())
        with patch("devpi_admin.main._is_replica", return_value=True):
            with self.assertRaises(HTTPBadRequest):
                _refresh_mirror_cache_view(self._make(xom))

    def test_unauthenticated_blocked(self):
        xom = self._stub_xom(stage=self._stub_mirror_stage())
        with patch("devpi_admin.main._is_replica", return_value=False):
            with self.assertRaises(HTTPForbidden):
                _refresh_mirror_cache_view(
                    self._make(xom, auth_user=None))


class VersiondataViewTests(unittest.TestCase):
    """+links must be built from verdata +elinks (which carry _log).

    Regression: get_releaselinks() reconstructs ELinks from simplelinks
    metadata without "_log", so the upload timestamps never reached the
    response when the view used it.
    """

    def _make(self, verdata):
        stage = MagicMock()
        stage.get_versiondata.return_value = verdata
        xom = MagicMock()
        xom.model.getstage.return_value = stage
        req = MagicMock()
        req.registry = {"xom": xom}
        req.matchdict = {
            "user": "alice", "index": "dev",
            "project": "testpkg", "version": "1.0"}
        req.has_permission.return_value = True
        req.authenticated_userid = "alice"
        return req

    def test_links_carry_upload_log(self):
        verdata = {
            "name": "testpkg", "version": "1.0",
            "+elinks": [
                {
                    "rel": "releasefile",
                    "entrypath": "alice/dev/+f/b28/abc/testpkg-1.0.tar.gz",
                    "hash_spec": "md5=deadbeef",
                    "hashes": {"sha256": "cafe"},
                    "_log": [{
                        "what": "upload", "who": "alice",
                        "when": (2026, 6, 5, 8, 10, 44),
                        "dst": "alice/dev"}],
                },
                {
                    # non-releasefile links must be filtered out
                    "rel": "toxresult",
                    "entrypath": "alice/dev/+f/123/tox.json",
                },
            ],
        }
        body = json.loads(_versiondata_view(self._make(verdata)).body)
        result = body["result"]
        self.assertNotIn("+elinks", result)
        self.assertEqual(len(result["+links"]), 1)
        link = result["+links"][0]
        self.assertEqual(
            link["href"], "/alice/dev/+f/b28/abc/testpkg-1.0.tar.gz")
        self.assertEqual(link["basename"], "testpkg-1.0.tar.gz")
        self.assertEqual(link["hash_spec"], "sha256=cafe")
        self.assertEqual(link["log"][0]["when"], [2026, 6, 5, 8, 10, 44])
        self.assertEqual(link["log"][0]["who"], "alice")

    def test_mirror_links_without_log(self):
        # Mirror elinks carry no "_log" — the "log" key must be absent,
        # not present-but-empty.
        verdata = {
            "name": "testpkg", "version": "1.0",
            "+elinks": [{
                "rel": "releasefile",
                "entrypath": "root/pypi/+f/abc/testpkg-1.0.tar.gz",
                "hash_spec": "md5=deadbeef",
                "hashes": {},
            }],
        }
        body = json.loads(_versiondata_view(self._make(verdata)).body)
        link = body["result"]["+links"][0]
        self.assertNotIn("log", link)
        self.assertEqual(link["hash_spec"], "md5=deadbeef")

    def test_no_elinks_yields_empty_links(self):
        verdata = {"name": "testpkg", "version": "1.0"}
        body = json.loads(_versiondata_view(self._make(verdata)).body)
        self.assertEqual(body["result"]["+links"], [])


if __name__ == "__main__":
    unittest.main()
