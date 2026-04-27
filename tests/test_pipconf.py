"""Tests for the pip.conf credential helpers."""
import unittest

from devpi_admin.main import (
    _build_pip_conf, _host_from_url, _inject_creds)


class HostFromUrlTests(unittest.TestCase):

    def test_https_with_port(self):
        self.assertEqual(
            _host_from_url("https://pypi.example.com:8443/x"),
            "pypi.example.com")

    def test_http_no_port(self):
        self.assertEqual(
            _host_from_url("http://devpi.local/+admin/"),
            "devpi.local")

    def test_invalid_scheme(self):
        # Non-http(s) input falls back to empty string.
        self.assertEqual(_host_from_url("ftp://x"), "")
        self.assertEqual(_host_from_url(""), "")


class InjectCredsTests(unittest.TestCase):

    def test_basic_injection(self):
        result = _inject_creds(
            "https://pypi.example.com", "alice", "tok123")
        self.assertEqual(result, "https://alice:tok123@pypi.example.com")

    def test_preserves_path(self):
        result = _inject_creds(
            "https://pypi.example.com/+admin/", "alice", "tok")
        self.assertEqual(
            result, "https://alice:tok@pypi.example.com/+admin/")

    def test_preserves_port(self):
        result = _inject_creds(
            "http://localhost:3141", "u", "t")
        self.assertEqual(result, "http://u:t@localhost:3141")

    def test_url_encodes_special_chars(self):
        # devpi enforces alpha-num/._- in usernames, but the token is
        # base64url and the helper must not blow up on edge characters.
        result = _inject_creds(
            "https://h", "user.bot", "ad-m_T0k.ENs.x_y")
        self.assertEqual(
            result,
            "https://user.bot:ad-m_T0k.ENs.x_y@h")

    def test_passthrough_for_non_http(self):
        # If the scheme is unrecognised, return URL unchanged rather
        # than mangling it.
        self.assertEqual(_inject_creds("not-a-url", "u", "t"), "not-a-url")


class BuildPipConfTests(unittest.TestCase):

    def test_full_format(self):
        result = _build_pip_conf(
            "https://pypi.example.com", "alice", "tok", "alice/dev")
        self.assertIn("[global]", result)
        self.assertIn(
            "index-url = https://alice:tok@pypi.example.com/alice/dev/+simple/",
            result)
        self.assertIn("trusted-host = pypi.example.com", result)

    def test_trailing_newline(self):
        # pip.conf parsers want a trailing newline; ensure we emit one.
        result = _build_pip_conf(
            "https://h", "u", "t", "u/i")
        self.assertTrue(result.endswith("\n"))


if __name__ == "__main__":
    unittest.main()
