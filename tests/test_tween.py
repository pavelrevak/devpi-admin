"""Tests for the tween that redirects / to /+admin/ for browsers."""
import unittest
from unittest.mock import MagicMock

from pyramid.httpexceptions import HTTPFound

from devpi_admin.main import devpi_admin_tween_factory


def make_request(path="/", method="GET", accept="text/html"):
    req = MagicMock()
    req.path = path
    req.method = method
    req.headers = {"Accept": accept} if accept else {}
    return req


class TweenTests(unittest.TestCase):

    def setUp(self):
        self.handler = MagicMock(return_value="downstream")
        self.tween = devpi_admin_tween_factory(self.handler, MagicMock())

    def test_browser_root_redirects(self):
        request = make_request(
            path="/", method="GET",
            accept="text/html,application/xhtml+xml")
        response = self.tween(request)
        self.assertIsInstance(response, HTTPFound)
        self.assertEqual(response.location, "/+admin/")
        self.handler.assert_not_called()

    def test_json_root_passes_through(self):
        request = make_request(
            path="/", method="GET", accept="application/json")
        response = self.tween(request)
        self.assertEqual(response, "downstream")
        self.handler.assert_called_once_with(request)

    def test_post_root_passes_through(self):
        # POST / is not something browsers do; leave it alone
        request = make_request(
            path="/", method="POST", accept="text/html")
        response = self.tween(request)
        self.assertEqual(response, "downstream")

    def test_non_root_browser_passes_through(self):
        request = make_request(
            path="/ci/testing", method="GET", accept="text/html")
        response = self.tween(request)
        self.assertEqual(response, "downstream")

    def test_empty_accept_passes_through(self):
        request = make_request(path="/", method="GET", accept="")
        response = self.tween(request)
        self.assertEqual(response, "downstream")


if __name__ == "__main__":
    unittest.main()
