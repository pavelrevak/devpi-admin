"""Tests for acl_read enforcement and admin-token tween guards."""
import base64
import json
import unittest
from unittest.mock import MagicMock

from devpi_admin import main
from devpi_admin.main import (
    _ADMIN_TOKEN_BLOCKED_PATHS, _INDEX_PATH_RE, _NAME_RE, _SIMPLE_PATH_RE,
    _admin_token_check, _filter_root_listing, _request_carries_admin_token,
    devpiserver_indexconfig_defaults, devpiserver_stage_get_principals_for_pkg_read)


class IndexconfigDefaultsTests(unittest.TestCase):

    def test_returns_acl_read_with_anonymous_default(self):
        result = devpiserver_indexconfig_defaults("stage")
        self.assertIn("acl_read", result)
        self.assertEqual(list(result["acl_read"]), [":ANONYMOUS:"])

    def test_value_is_acllist_for_devpi_validation(self):
        # ACLList marker tells devpi to apply ensure_acl_list normalization
        # on every PUT/PATCH (case-folds principals, accepts comma strings).
        from devpi_server.model import ACLList
        result = devpiserver_indexconfig_defaults("stage")
        self.assertIsInstance(result["acl_read"], ACLList)

    def test_same_default_for_mirror_indexes(self):
        # Mirror indexes can also be private; default must be public though.
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

    def test_index_path_matches_user_index(self):
        self.assertTrue(_INDEX_PATH_RE.match("/alice/dev"))
        self.assertTrue(_INDEX_PATH_RE.match("/alice/dev/"))

    def test_index_path_rejects_plus_segments(self):
        self.assertFalse(_INDEX_PATH_RE.match("/+login"))
        self.assertFalse(_INDEX_PATH_RE.match("/+api"))
        self.assertFalse(_INDEX_PATH_RE.match("/alice/+api"))

    def test_index_path_rejects_deeper_paths(self):
        # Project paths and simple paths must not be caught here.
        self.assertFalse(_INDEX_PATH_RE.match("/alice/dev/foo"))
        self.assertFalse(_INDEX_PATH_RE.match("/alice/dev/+simple/"))

    def test_simple_path(self):
        self.assertTrue(_SIMPLE_PATH_RE.match("/alice/dev/+simple/"))
        self.assertTrue(_SIMPLE_PATH_RE.match("/alice/dev/+simple"))
        self.assertFalse(_SIMPLE_PATH_RE.match("/alice/dev/+simple/foo/"))

    def test_admin_token_blocked_paths(self):
        # Paths that escalate identity: must block any non-GET method.
        self.assertTrue(_ADMIN_TOKEN_BLOCKED_PATHS.match("/+login"))
        self.assertTrue(_ADMIN_TOKEN_BLOCKED_PATHS.match("/+login/"))
        self.assertTrue(_ADMIN_TOKEN_BLOCKED_PATHS.match("/alice"))
        self.assertTrue(_ADMIN_TOKEN_BLOCKED_PATHS.match("/alice/"))
        # Index/package paths must NOT be blocked here — devpi ACL handles them.
        self.assertFalse(_ADMIN_TOKEN_BLOCKED_PATHS.match("/alice/dev"))
        self.assertFalse(_ADMIN_TOKEN_BLOCKED_PATHS.match("/alice/dev/foo"))
        self.assertFalse(_ADMIN_TOKEN_BLOCKED_PATHS.match("/+api"))

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

    def test_detects_adm_token_in_devpi_auth(self):
        token = "adm_" + "x" * 40
        req = self._request_with_devpi_auth("alice", token)
        self.assertTrue(_request_carries_admin_token(req))

    def test_ignores_devpi_session_token(self):
        # devpi session tokens look like ["user", [], true].timestamp.sig
        req = self._request_with_devpi_auth("alice", '["alice",[],true].abc.def')
        self.assertFalse(_request_carries_admin_token(req))

    def test_ignores_plain_password(self):
        req = self._request_with_devpi_auth("alice", "secret123")
        self.assertFalse(_request_carries_admin_token(req))

    def test_no_headers(self):
        req = MagicMock()
        req.headers = {}
        self.assertFalse(_request_carries_admin_token(req))

    def test_falls_back_to_basic_auth_header(self):
        token = "adm_" + "x" * 40
        raw = base64.b64encode(("alice:" + token).encode()).decode()
        req = MagicMock()
        req.headers = {"Authorization": "Basic " + raw}
        self.assertTrue(_request_carries_admin_token(req))

    def test_malformed_base64_does_not_throw(self):
        req = MagicMock()
        req.headers = {"X-Devpi-Auth": "!!!!!!!"}
        # Should return False, not raise.
        self.assertFalse(_request_carries_admin_token(req))


class AdminTokenCheckTests(unittest.TestCase):

    def _make(self, method, path):
        req = MagicMock()
        req.method = method
        req.path = path
        return req

    def test_get_always_allowed(self):
        for path in ("/+login", "/alice", "/alice/dev", "/alice/dev/foo"):
            self.assertIsNone(
                _admin_token_check(self._make("GET", path)),
                "GET %s should not be blocked" % path)

    def test_head_always_allowed(self):
        self.assertIsNone(_admin_token_check(self._make("HEAD", "/+login")))

    def test_post_login_blocked(self):
        result = _admin_token_check(self._make("POST", "/+login"))
        self.assertIsNotNone(result)

    def test_patch_user_blocked(self):
        result = _admin_token_check(self._make("PATCH", "/alice"))
        self.assertIsNotNone(result)

    def test_delete_user_blocked(self):
        result = _admin_token_check(self._make("DELETE", "/alice"))
        self.assertIsNotNone(result)

    def test_put_user_blocked(self):
        result = _admin_token_check(self._make("PUT", "/alice"))
        self.assertIsNotNone(result)

    def test_index_management_passes_through(self):
        # Operations on indexes (PATCH /<user>/<index>) flow through devpi ACL.
        # Our tween only blocks user-management paths.
        for method in ("PATCH", "PUT", "DELETE", "POST"):
            self.assertIsNone(
                _admin_token_check(self._make(method, "/alice/dev")),
                "%s /alice/dev should not be blocked by admin token guard"
                % method)


class FilterRootListingTests(unittest.TestCase):
    """Validate that GET / response strips indexes the requestor cannot read."""

    def _make_response(self, body):
        resp = MagicMock()
        resp.body = json.dumps(body).encode()
        resp.content_type = "application/json"
        resp.status_code = 200
        return resp

    def _make_xom(self, stage_visibility):
        # stage_visibility maps "user/index" -> True/False (has pkg_read)
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
        # has_permission returns True iff stage._adm_visible is True
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

    def test_keeps_users_with_no_visible_indexes_but_empty(self):
        body = {
            "result": {
                "alice": {"indexes": {"secret": {}}},
            },
        }
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
        xom = MagicMock()
        req = MagicMock()
        out = _filter_root_listing(req, resp, xom)
        # On parse failure, response is returned untouched.
        self.assertIs(out, resp)


if __name__ == "__main__":
    unittest.main()
