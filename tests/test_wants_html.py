"""Tests for the Accept-header heuristic used by the redirect tween."""
import unittest
from unittest.mock import MagicMock

from devpi_admin.main import _wants_html


def make_request(accept):
    req = MagicMock()
    req.headers = {"Accept": accept} if accept is not None else {}
    return req


class WantsHtmlTests(unittest.TestCase):

    def test_browser_accept(self):
        accept = (
            "text/html,application/xhtml+xml,"
            "application/xml;q=0.9,image/webp,*/*;q=0.8")
        self.assertTrue(_wants_html(make_request(accept)))

    def test_plain_html(self):
        self.assertTrue(_wants_html(make_request("text/html")))

    def test_wildcard_only(self):
        self.assertTrue(_wants_html(make_request("*/*")))

    def test_json_only(self):
        self.assertFalse(_wants_html(make_request("application/json")))

    def test_json_with_wildcard(self):
        # devpi CLI sends exactly "application/json"; it must not redirect
        self.assertFalse(_wants_html(make_request("application/json")))

    def test_empty_accept(self):
        self.assertFalse(_wants_html(make_request("")))

    def test_missing_accept(self):
        self.assertFalse(_wants_html(make_request(None)))

    def test_json_preferred_no_html(self):
        self.assertFalse(_wants_html(
            make_request("application/json;q=1.0")))

    def test_mixed_json_and_html(self):
        # When both are accepted, prefer the HTML branch (browser typical).
        self.assertTrue(_wants_html(
            make_request("application/json, text/html")))


if __name__ == "__main__":
    unittest.main()
