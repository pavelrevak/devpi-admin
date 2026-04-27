"""Tests for view-layer helpers (_get_stage_or_404, _check_read_access)."""
import unittest
from unittest.mock import MagicMock, patch

from pyramid.httpexceptions import HTTPForbidden, HTTPNotFound

from devpi_admin.main import _check_read_access, _get_stage_or_404, _serve_index


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


if __name__ == "__main__":
    unittest.main()
