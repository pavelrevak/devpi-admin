"""Tests for acl_read enforcement and admin-token tween guards."""
import base64
import json
import unittest
from unittest.mock import MagicMock

from devpi_admin import main
from devpi_admin.main import (
    _INDEX_ANY_RE, _NAME_RE, _TOKEN_ALLOWED_PATH_RE, _USER_PATH_RE,
    _admin_token_check, _filter_root_listing, _request_carries_admin_token,
    _user_listing_check,
    devpiserver_indexconfig_defaults, devpiserver_stage_get_principals_for_pkg_read)


class IndexconfigDefaultsTests(unittest.TestCase):

    def test_returns_acl_read_with_anonymous_default(self):
        result = devpiserver_indexconfig_defaults("stage")
        self.assertIn("acl_read", result)
        self.assertEqual(list(result["acl_read"]), [":ANONYMOUS:"])

    def test_value_is_acllist_for_devpi_validation(self):
        from devpi_server.model import ACLList
        result = devpiserver_indexconfig_defaults("stage")
        self.assertIsInstance(result["acl_read"], ACLList)

    def test_same_default_for_mirror_indexes(self):
        result = devpiserver_indexconfig_defaults("mirror")
        self.assertEqual(list(result["acl_read"]), [":ANONYMOUS:"])


class PrincipalsForPkgReadTests(unittest.TestCase):

    def test_returns_acl_read_from_ixconfig(self):
        result = devpiserver_stage_get_principals_for_pkg_read(
            ixconfig={"acl_read": ["alice", "bob"]})
        self.assertEqual(list(result), ["alice", "bob"])

    def test_default_is_anonymous_when_missing(self):
        result = devpiserver_stage_get_principals_for_pkg_read(ixconfig={})
        self.assertEqual(list(result), [":ANONYMOUS:"])


class PathRegexTests(unittest.TestCase):

    def test_user_path_matches(self):
        self.assertTrue(_USER_PATH_RE.match("/alice"))
        self.assertTrue(_USER_PATH_RE.match("/alice/"))

    def test_user_path_rejects_plus_and_deeper(self):
        self.assertFalse(_USER_PATH_RE.match("/+login"))
        self.assertFalse(_USER_PATH_RE.match("/alice/dev"))
        self.assertFalse(_USER_PATH_RE.match("/"))

    def test_index_any_matches_index_and_subpaths(self):
        self.assertTrue(_INDEX_ANY_RE.match("/alice/dev"))
        self.assertTrue(_INDEX_ANY_RE.match("/alice/dev/"))
        self.assertTrue(_INDEX_ANY_RE.match("/alice/dev/+simple/"))
        self.assertTrue(_INDEX_ANY_RE.match("/alice/dev/+simple/foo"))
        self.assertTrue(_INDEX_ANY_RE.match("/alice/dev/foo"))
        self.assertTrue(_INDEX_ANY_RE.match("/alice/dev/foo/1.0"))

    def test_index_any_rejects_plus_segments(self):
        self.assertFalse(_INDEX_ANY_RE.match("/+login"))
        self.assertFalse(_INDEX_ANY_RE.match("/+api"))
        self.assertFalse(_INDEX_ANY_RE.match("/alice/+api"))

    def test_token_allowed_path_re(self):
        # /+api allowed (devpi client discovery).
        self.assertTrue(_TOKEN_ALLOWED_PATH_RE.match("/+api"))
        self.assertTrue(_TOKEN_ALLOWED_PATH_RE.match("/+api/"))
        # Index/archive paths allowed.
        self.assertTrue(_TOKEN_ALLOWED_PATH_RE.match("/alice/dev"))
        self.assertTrue(_TOKEN_ALLOWED_PATH_RE.match("/alice/dev/+simple/"))
        self.assertTrue(_TOKEN_ALLOWED_PATH_RE.match("/alice/dev/+f/foo.whl"))
        self.assertTrue(_TOKEN_ALLOWED_PATH_RE.match("/alice/dev/foo/1.0"))
        # Management / login / single-segment / SPA paths denied.
        for bad in ("/", "/+login", "/+admin/", "/+admin-api/token",
                    "/+admin-api/users/alice/tokens", "/+status", "/alice",
                    "/alice/"):
            self.assertFalse(
                _TOKEN_ALLOWED_PATH_RE.match(bad),
                "expected token path %r to be denied" % bad)

    def test_name_regex_accepts_typical_names(self):
        for name in ("alice", "ci-runner", "team_a", "user.bot", "u1"):
            self.assertTrue(_NAME_RE.match(name), name)

    def test_name_regex_rejects_path_traversal(self):
        for bad in ("..", ".", "/etc", "alice/dev", "../passwd",
                    "+system", "", "a" * 51):
            self.assertFalse(_NAME_RE.match(bad), bad)


class AdminTokenHeaderDetectionTests(unittest.TestCase):

    def _request_with_devpi_auth(self, user, secret):
        raw = base64.b64encode(("%s:%s" % (user, secret)).encode()).decode()
        req = MagicMock()
        req.headers = {"X-Devpi-Auth": raw}
        return req

    def _valid_token(self):
        # Match the new format: adm_<id>.<secret>
        return "adm_" + ("x" * 22) + "." + ("y" * 43)

    def test_detects_adm_token_in_devpi_auth(self):
        req = self._request_with_devpi_auth("alice", self._valid_token())
        self.assertTrue(_request_carries_admin_token(req))

    def test_ignores_devpi_session_token(self):
        # devpi session tokens look like ["user", [], true].timestamp.sig
        req = self._request_with_devpi_auth("alice", '["alice",[],true].abc.def')
        self.assertFalse(_request_carries_admin_token(req))

    def test_ignores_plain_password(self):
        req = self._request_with_devpi_auth("alice", "secret123")
        self.assertFalse(_request_carries_admin_token(req))

    def test_ignores_old_format_without_dot(self):
        # Old single-blob format must no longer be considered a valid token.
        req = self._request_with_devpi_auth("alice", "adm_" + "x" * 40)
        self.assertFalse(_request_carries_admin_token(req))

    def test_no_headers(self):
        req = MagicMock()
        req.headers = {}
        self.assertFalse(_request_carries_admin_token(req))

    def test_falls_back_to_basic_auth_header(self):
        raw = base64.b64encode(("alice:" + self._valid_token()).encode()).decode()
        req = MagicMock()
        req.headers = {"Authorization": "Basic " + raw}
        self.assertTrue(_request_carries_admin_token(req))

    def test_basic_auth_header_case_insensitive(self):
        # RFC 7617: auth-scheme is case-insensitive.
        raw = base64.b64encode(("alice:" + self._valid_token()).encode()).decode()
        for scheme in ("basic ", "BASIC ", "BaSiC "):
            req = MagicMock()
            req.headers = {"Authorization": scheme + raw}
            self.assertTrue(
                _request_carries_admin_token(req),
                "scheme %r should be detected" % scheme)

    def test_malformed_base64_does_not_throw(self):
        req = MagicMock()
        req.headers = {"X-Devpi-Auth": "!!!!!!!"}
        self.assertFalse(_request_carries_admin_token(req))


class AdminTokenCheckTests(unittest.TestCase):

    def _make(self, method, path):
        req = MagicMock()
        req.method = method
        req.path = path
        return req

    def test_get_index_paths_allowed(self):
        for path in ("/+api", "/alice/dev", "/alice/dev/+simple/",
                     "/alice/dev/+f/foo.whl", "/alice/dev/foo/1.0"):
            self.assertIsNone(
                _admin_token_check(self._make("GET", path)),
                "GET %s should be allowed" % path)

    def test_get_management_paths_blocked(self):
        for path in ("/", "/+login", "/+admin/", "/+admin-api/token",
                     "/+admin-api/users/alice/tokens", "/+status",
                     "/alice", "/alice/"):
            self.assertIsNotNone(
                _admin_token_check(self._make("GET", path)),
                "GET %s should be blocked" % path)

    def test_head_treated_like_get(self):
        self.assertIsNone(_admin_token_check(self._make("HEAD", "/alice/dev")))
        self.assertIsNotNone(_admin_token_check(self._make("HEAD", "/+login")))

    def test_any_write_method_blocked_everywhere(self):
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            for path in ("/+login", "/alice", "/alice/dev",
                         "/alice/dev/foo", "/+admin-api/token"):
                self.assertIsNotNone(
                    _admin_token_check(self._make(method, path)),
                    "%s %s must be blocked for admin tokens" % (method, path))


class UserListingCheckTests(unittest.TestCase):

    def _make(self, path, auth_user=None):
        req = MagicMock()
        req.path = path
        req.authenticated_userid = auth_user
        return req

    def test_non_user_paths_passthrough(self):
        for path in ("/", "/alice/dev", "/+login"):
            self.assertIsNone(_user_listing_check(self._make(path)))

    def test_anonymous_blocked(self):
        result = _user_listing_check(self._make("/alice", auth_user=None))
        self.assertIsNotNone(result)

    def test_owner_allowed(self):
        result = _user_listing_check(self._make("/alice/", auth_user="alice"))
        self.assertIsNone(result)

    def test_root_allowed_for_others(self):
        result = _user_listing_check(self._make("/alice", auth_user="root"))
        self.assertIsNone(result)

    def test_other_user_blocked(self):
        result = _user_listing_check(self._make("/alice", auth_user="bob"))
        self.assertIsNotNone(result)


class FilterRootListingTests(unittest.TestCase):
    """Validate that GET / response strips indexes the requestor cannot read."""

    def _make_response(self, body):
        resp = MagicMock()
        resp.body = json.dumps(body).encode()
        resp.content_type = "application/json"
        resp.status_code = 200
        resp.headers = {}
        return resp

    def _make_xom(self, stage_visibility):
        xom = MagicMock()
        def getstage(user, index):
            key = "%s/%s" % (user, index)
            if key not in stage_visibility:
                return None
            stage = MagicMock()
            stage._adm_visible = stage_visibility[key]
            return stage
        xom.model.getstage.side_effect = getstage
        return xom

    def _make_request(self, xom):
        req = MagicMock()
        req.has_permission.side_effect = (
            lambda perm, context=None: getattr(context, "_adm_visible", False))
        return req

    def test_strips_invisible_indexes(self):
        body = {
            "result": {
                "alice": {"indexes": {"public": {}, "secret": {}}},
                "bob": {"indexes": {"team": {}}},
            },
        }
        xom = self._make_xom({
            "alice/public": True,
            "alice/secret": False,
            "bob/team": True,
        })
        resp = self._make_response(body)
        req = self._make_request(xom)
        out = _filter_root_listing(req, resp, xom)
        filtered = json.loads(out.body)
        self.assertEqual(set(filtered["result"]["alice"]["indexes"]), {"public"})
        self.assertEqual(set(filtered["result"]["bob"]["indexes"]), {"team"})

    def test_sets_private_cache_control(self):
        body = {"result": {"alice": {"indexes": {}}}}
        xom = self._make_xom({})
        resp = self._make_response(body)
        req = self._make_request(xom)
        out = _filter_root_listing(req, resp, xom)
        self.assertIn("private", out.headers.get("Cache-Control", ""))

    def test_keeps_users_with_no_visible_indexes_but_empty(self):
        body = {"result": {"alice": {"indexes": {"secret": {}}}}}
        xom = self._make_xom({"alice/secret": False})
        resp = self._make_response(body)
        req = self._make_request(xom)
        out = _filter_root_listing(req, resp, xom)
        filtered = json.loads(out.body)
        self.assertEqual(filtered["result"]["alice"]["indexes"], {})

    def test_passthrough_when_body_not_json(self):
        resp = MagicMock()
        resp.body = b"not json"
        resp.content_type = "application/json"
        resp.status_code = 200
        resp.headers = {}
        xom = MagicMock()
        req = MagicMock()
        out = _filter_root_listing(req, resp, xom)
        self.assertIs(out, resp)

    def test_passthrough_when_result_missing(self):
        resp = self._make_response({"other": "data"})
        out = _filter_root_listing(MagicMock(), resp, MagicMock())
        self.assertIs(out, resp)

    def test_passthrough_when_result_not_dict(self):
        resp = self._make_response({"result": ["a", "b"]})
        out = _filter_root_listing(MagicMock(), resp, MagicMock())
        self.assertIs(out, resp)

    def test_userdata_not_dict_kept_as_is(self):
        body = {"result": {"alice": "raw-string", "bob": {"indexes": {}}}}
        xom = self._make_xom({})
        req = self._make_request(xom)
        out = _filter_root_listing(req, self._make_response(body), xom)
        filtered = json.loads(out.body)
        self.assertEqual(filtered["result"]["alice"], "raw-string")

    def test_indexes_not_dict_kept_as_is(self):
        body = {"result": {"alice": {"indexes": "weird-value"}}}
        xom = self._make_xom({})
        req = self._make_request(xom)
        out = _filter_root_listing(req, self._make_response(body), xom)
        filtered = json.loads(out.body)
        self.assertEqual(filtered["result"]["alice"]["indexes"], "weird-value")

    def test_getstage_exception_drops_index(self):
        body = {"result": {"alice": {"indexes": {"broken": {}}}}}
        xom = MagicMock()
        xom.model.getstage.side_effect = RuntimeError("boom")
        resp = self._make_response(body)
        req = self._make_request(xom)
        out = _filter_root_listing(req, resp, xom)
        filtered = json.loads(out.body)
        self.assertEqual(filtered["result"]["alice"]["indexes"], {})


class TrustedProxyTests(unittest.TestCase):

    def setUp(self):
        # Reset the module-level cache before each test.
        main._trusted_proxies_cache = None

    def tearDown(self):
        main._trusted_proxies_cache = None
        import os
        os.environ.pop(main._TRUSTED_PROXIES_ENV, None)

    def _request(self, client_addr, xff=None):
        req = MagicMock()
        req.client_addr = client_addr
        req.headers = {}
        if xff is not None:
            req.headers["X-Forwarded-For"] = xff
        return req

    def test_xff_ignored_without_trusted_proxies(self):
        import os
        os.environ.pop(main._TRUSTED_PROXIES_ENV, None)
        ip = main._client_ip(self._request("1.2.3.4", xff="9.9.9.9"))
        self.assertEqual(ip, "1.2.3.4")

    def test_xff_honoured_when_peer_is_trusted(self):
        import os
        os.environ[main._TRUSTED_PROXIES_ENV] = "10.0.0.0/8"
        main._trusted_proxies_cache = None
        ip = main._client_ip(self._request("10.1.2.3", xff="9.9.9.9"))
        self.assertEqual(ip, "9.9.9.9")

    def test_xff_ignored_when_peer_outside_trusted(self):
        import os
        os.environ[main._TRUSTED_PROXIES_ENV] = "10.0.0.0/8"
        main._trusted_proxies_cache = None
        ip = main._client_ip(self._request("8.8.8.8", xff="9.9.9.9"))
        self.assertEqual(ip, "8.8.8.8")

    def test_xff_takes_first_entry(self):
        import os
        os.environ[main._TRUSTED_PROXIES_ENV] = "10.0.0.0/8"
        main._trusted_proxies_cache = None
        ip = main._client_ip(
            self._request("10.0.0.1", xff="1.1.1.1, 2.2.2.2, 10.0.0.1"))
        self.assertEqual(ip, "1.1.1.1")


class WaitReplicasTests(unittest.TestCase):

    def test_parse_disabled_values(self):
        for v in (None, "", "0", "false", "no", "off"):
            self.assertEqual(main._parse_wait_replicas(v), 0)

    def test_parse_bool_truthy_uses_default(self):
        self.assertEqual(
            main._parse_wait_replicas("true"), main._REPLICA_WAIT_MAX)

    def test_parse_int_capped(self):
        self.assertEqual(main._parse_wait_replicas("5"), 5)
        self.assertEqual(
            main._parse_wait_replicas("999"), main._REPLICA_WAIT_MAX)
        self.assertEqual(main._parse_wait_replicas("-3"), 0)

    def _make_xom(self, current_serial, polling):
        xom = MagicMock()
        xom.keyfs.get_current_serial.return_value = current_serial
        xom.polling_replicas = polling
        return xom

    def test_no_replicas_returns_immediately(self):
        xom = self._make_xom(42, {})
        result = main._wait_for_replicas(xom, 5)
        self.assertTrue(result["synced"])
        self.assertEqual(result["replicas"], 0)

    def test_synced_replicas_pass(self):
        import time as _t
        xom = self._make_xom(42, {
            "r1": {"serial": 42, "last-request": _t.time()},
            "r2": {"serial": 43, "last-request": _t.time()},
        })
        result = main._wait_for_replicas(xom, 5)
        self.assertTrue(result["synced"])
        self.assertEqual(result["replicas"], 2)

    def test_lagging_replica_times_out(self):
        import time as _t
        xom = self._make_xom(42, {
            "r1": {"serial": 40, "last-request": _t.time()},
        })
        result = main._wait_for_replicas(xom, 1)
        self.assertFalse(result["synced"])
        self.assertTrue(result["timed_out"])
        self.assertEqual(result["lagging"], 1)

    def test_stale_replica_ignored(self):
        import time as _t
        xom = self._make_xom(42, {
            "r1": {"serial": 0, "last-request": _t.time() - 1000},
        })
        result = main._wait_for_replicas(xom, 1)
        self.assertTrue(result["synced"])
        self.assertEqual(result["replicas"], 0)


if __name__ == "__main__":
    unittest.main()
