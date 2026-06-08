"""Tests for acl_read enforcement and admin-token tween guards."""
import base64
import json
import unittest
from unittest.mock import MagicMock

from devpi_admin import main
from devpi_admin.main import (
    _INDEX_ANY_RE, _NAME_RE, _USER_PATH_RE,
    _admin_token_check, _filter_root_listing, _request_carries_admin_token,
    _REPLICA_USER_NAME,
    _changelog_auth_check,
    _coarse_health,
    _filter_status,
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

    def _meta(self, *, index="alice/dev", scope="read"):
        return {"user": index.split("/")[0], "index": index, "scope": scope}

    # --- read-scope token bound to alice/dev ---

    def test_read_scope_allows_get_on_bound_index(self):
        for path in ("/+api", "/alice/dev", "/alice/dev/",
                     "/alice/dev/+simple/", "/alice/dev/+f/foo.whl",
                     "/alice/dev/foo/1.0"):
            self.assertIsNone(
                _admin_token_check(self._make("GET", path), self._meta(), None),
                "GET %s should be allowed" % path)

    def test_read_scope_blocks_management_paths(self):
        for path in ("/", "/+login", "/+admin/", "/+admin-api/token",
                     "/+admin-api/users/alice/tokens", "/+status",
                     "/alice", "/alice/"):
            self.assertIsNotNone(
                _admin_token_check(self._make("GET", path), self._meta(), None),
                "GET %s should be blocked" % path)

    def test_read_scope_blocks_other_index(self):
        # Token bound to alice/dev cannot reach bob/prod.
        self.assertIsNotNone(_admin_token_check(
            self._make("GET", "/bob/prod"), self._meta(), None))
        self.assertIsNotNone(_admin_token_check(
            self._make("GET", "/bob/prod/+simple/foo"), self._meta(), None))
        # Even alice's *other* index is blocked.
        self.assertIsNotNone(_admin_token_check(
            self._make("GET", "/alice/staging"), self._meta(), None))

    def test_head_treated_like_get(self):
        self.assertIsNone(_admin_token_check(
            self._make("HEAD", "/alice/dev"), self._meta(), None))
        self.assertIsNotNone(_admin_token_check(
            self._make("HEAD", "/+login"), self._meta(), None))

    def test_read_scope_blocks_writes_everywhere(self):
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            for path in ("/alice/dev", "/alice/dev/foo", "/+login"):
                self.assertIsNotNone(
                    _admin_token_check(
                        self._make(method, path), self._meta(), None),
                    "%s %s must be blocked for read-scope token"
                    % (method, path))

    # --- upload-scope token ---

    def test_upload_scope_allows_post_put_on_bound_index(self):
        meta = self._meta(scope="upload")
        for method in ("POST", "PUT"):
            self.assertIsNone(_admin_token_check(
                self._make(method, "/alice/dev"), meta, None),
                "%s should be allowed" % method)
            self.assertIsNone(_admin_token_check(
                self._make(method, "/alice/dev/foo/1.0"), meta, None))

    def test_upload_scope_blocks_delete(self):
        # Even with upload scope, DELETE is never allowed — package
        # removal must use password auth.
        meta = self._meta(scope="upload")
        for path in ("/alice/dev", "/alice/dev/foo", "/alice/dev/foo/1.0"):
            self.assertIsNotNone(
                _admin_token_check(self._make("DELETE", path), meta, None),
                "DELETE %s must be blocked even for upload scope" % path)

    def test_upload_scope_blocks_other_index(self):
        meta = self._meta(scope="upload")
        self.assertIsNotNone(_admin_token_check(
            self._make("POST", "/bob/prod"), meta, None))

    def test_upload_scope_blocks_management_paths(self):
        meta = self._meta(scope="upload")
        for path in ("/+login", "/+admin-api/token", "/+admin/", "/"):
            self.assertIsNotNone(
                _admin_token_check(self._make("POST", path), meta, None))

    # --- malformed meta (defensive) ---

    def test_unknown_scope_blocked(self):
        meta = {"user": "alice", "index": "alice/dev", "scope": "weird"}
        self.assertIsNotNone(_admin_token_check(
            self._make("GET", "/alice/dev"), meta, None))

    def test_missing_index_blocked(self):
        meta = {"user": "alice", "scope": "read"}
        self.assertIsNotNone(_admin_token_check(
            self._make("GET", "/alice/dev"), meta, None))


class AdminTokenBasesAwareTests(unittest.TestCase):
    """File-download cross-index GETs are allowed when the target index
    is reachable through the bound stage's SRO (bases inheritance).

    devpi's ``+simple/`` view on a stage emits links pointing to the
    base index that physically hosts the file (e.g. mirror-fed packages
    on ``villapro/staging`` link to ``/root/pypi/+f/...``); pip then
    follows them with the bound token and must not be 403'd.
    """

    def _make(self, method, path):
        req = MagicMock()
        req.method = method
        req.path = path
        return req

    def _meta(self, index="villapro/staging"):
        return {
            "user": index.split("/")[0], "index": index, "scope": "read"}

    def _xom_with_sro(self, sro_names):
        """Build a stub xom whose bound stage's sro() yields stages with
        the given ``user/index`` names. ``read_transaction()`` is a
        no-op context manager.
        """
        stages = [MagicMock(name=n) for n in sro_names]
        for stage, n in zip(stages, sro_names):
            stage.name = n
        bound_stage = MagicMock()
        bound_stage.sro.return_value = iter(stages)

        xom = MagicMock()
        xom.model.getstage.return_value = bound_stage
        ctx = MagicMock()
        ctx.__enter__ = MagicMock(return_value=ctx)
        ctx.__exit__ = MagicMock(return_value=False)
        xom.keyfs.read_transaction.return_value = ctx
        return xom

    def test_file_download_on_base_index_allowed(self):
        # staging → private → pypi: pip follows mirror file link.
        xom = self._xom_with_sro(
            ["villapro/staging", "villapro/private", "root/pypi"])
        result = _admin_token_check(
            self._make("GET", "/root/pypi/+f/ab/cdef/setuptools-1.0.whl"),
            self._meta(), xom)
        self.assertIsNone(result)

    def test_file_download_on_intermediate_base_allowed(self):
        xom = self._xom_with_sro(
            ["villapro/staging", "villapro/private", "root/pypi"])
        result = _admin_token_check(
            self._make("GET", "/villapro/private/+f/ab/cdef/pkg-1.0.whl"),
            self._meta(), xom)
        self.assertIsNone(result)

    def test_file_download_on_unrelated_index_blocked(self):
        xom = self._xom_with_sro(
            ["villapro/staging", "villapro/private", "root/pypi"])
        result = _admin_token_check(
            self._make("GET", "/charlie/secret/+f/ab/cdef/pkg-1.0.whl"),
            self._meta(), xom)
        self.assertIsNotNone(result)

    def test_simple_listing_on_base_not_exempted(self):
        # Bases exception is scoped to +f/ file downloads only — pip
        # always queries +simple/ on the bound stage URL (devpi merges
        # the views), so cross-index +simple has no legitimate flow and
        # must remain blocked to keep token scope meaningful.
        xom = self._xom_with_sro(
            ["villapro/staging", "root/pypi"])
        result = _admin_token_check(
            self._make("GET", "/root/pypi/+simple/setuptools/"),
            self._meta(), xom)
        self.assertIsNotNone(result)

    def test_bound_stage_missing_denies(self):
        xom = MagicMock()
        xom.model.getstage.return_value = None
        ctx = MagicMock()
        ctx.__enter__ = MagicMock(return_value=ctx)
        ctx.__exit__ = MagicMock(return_value=False)
        xom.keyfs.read_transaction.return_value = ctx
        result = _admin_token_check(
            self._make("GET", "/root/pypi/+f/ab/cdef/pkg.whl"),
            self._meta(), xom)
        self.assertIsNotNone(result)

    def test_sro_lookup_exception_denies(self):
        # Best-effort: any error in SRO traversal falls through to deny,
        # rather than masking a misconfiguration as accidental access.
        xom = MagicMock()
        xom.keyfs.read_transaction.side_effect = RuntimeError("boom")
        result = _admin_token_check(
            self._make("GET", "/root/pypi/+f/ab/cdef/pkg.whl"),
            self._meta(), xom)
        self.assertIsNotNone(result)

    def test_upload_scope_does_not_use_bases_exception(self):
        # Upload tokens write to the bound stage; cross-base writes
        # don't have an analogous "+f link in +simple" justification.
        # POST /root/pypi/... must stay blocked even with SRO match.
        xom = self._xom_with_sro(["villapro/staging", "root/pypi"])
        meta = {"user": "villapro", "index": "villapro/staging",
                "scope": "upload"}
        result = _admin_token_check(
            self._make("POST", "/root/pypi/+f/ab/cdef/pkg.whl"),
            meta, xom)
        self.assertIsNotNone(result)


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


class ChangelogAuthCheckTests(unittest.TestCase):
    """/+changelog/ must be readable only by the replica principal.

    devpi-server core lets anonymous (identity None) requests stream the
    full keyfs changelog — password hashes, token secrets. We gate it
    fail-closed: only the '+replica' principal passes.
    """

    def _make(self, path, auth_user=None):
        req = MagicMock()
        req.path = path
        req.authenticated_userid = auth_user
        return req

    def test_non_changelog_passthrough(self):
        for path in ("/", "/+status", "/root/pypi/+simple/", "/+changelogx"):
            self.assertIsNone(_changelog_auth_check(self._make(path)))

    def test_anonymous_blocked(self):
        for path in ("/+changelog/0", "/+changelog/5-", "/+changelog"):
            result = _changelog_auth_check(self._make(path, auth_user=None))
            self.assertIsNotNone(result, path)
            self.assertEqual(result.status_code, 403)

    def test_normal_user_blocked(self):
        # A regular authenticated user (even root) is not a replica.
        for user in ("alice", "root"):
            result = _changelog_auth_check(
                self._make("/+changelog/0-", auth_user=user))
            self.assertIsNotNone(result)
            self.assertEqual(result.status_code, 403)

    def test_replica_allowed(self):
        result = _changelog_auth_check(
            self._make("/+changelog/0-", auth_user=_REPLICA_USER_NAME))
        self.assertIsNone(result)


class CoarseHealthTests(unittest.TestCase):

    def test_ok_for_primary(self):
        self.assertEqual(_coarse_health({"role": "MASTER"}), "ok")

    def test_ok_for_healthy_replica(self):
        self.assertEqual(
            _coarse_health({"role": "REPLICA", "replication-errors": {}}), "ok")

    def test_fatal_for_replica_with_errors(self):
        self.assertEqual(
            _coarse_health(
                {"role": "REPLICA", "replication-errors": {"7": "boom"}}),
            "fatal")

    def test_ok_on_empty_or_missing(self):
        self.assertEqual(_coarse_health({}), "ok")


class FilterStatusTests(unittest.TestCase):
    """/+status is reduced to a coarse health verdict for anonymous callers,
    full detail kept for authenticated principals (recon hardening)."""

    _FULL = {
        "type": "status",
        "result": {
            "role": "REPLICA", "serverdir": "/var/lib/pypi/.devpi/server",
            "uuid": "abc123", "versioninfo": {"devpi-server": "6.19.3"},
            "serial": 758, "replication-errors": {},
            "polling_replicas": {"uuid": {"outside-url": "http://r"}}},
    }

    def _make_response(self, body):
        resp = MagicMock()
        resp.body = json.dumps(body).encode()
        resp.content_type = "application/json"
        resp.status_code = 200
        resp.headers = {}
        return resp

    def _make_request(self, auth_user=None):
        req = MagicMock()
        req.authenticated_userid = auth_user
        return req

    def test_authenticated_gets_full_detail(self):
        resp = self._make_response(self._FULL)
        out = _filter_status(self._make_request(auth_user="alice"), resp)
        body = json.loads(out.body)
        self.assertIn("serverdir", body["result"])
        self.assertIn("versioninfo", body["result"])

    def test_anonymous_gets_only_health(self):
        resp = self._make_response(self._FULL)
        out = _filter_status(self._make_request(auth_user=None), resp)
        body = json.loads(out.body)
        # Nothing sensitive survives — only the verdict.
        self.assertEqual(body, {"type": "status", "result": {"status": "ok"}})
        self.assertIn("private", out.headers.get("Cache-Control", ""))

    def test_anonymous_sees_fatal_on_replica_errors(self):
        full = json.loads(json.dumps(self._FULL))
        full["result"]["replication-errors"] = {"7": "import failed"}
        out = _filter_status(
            self._make_request(auth_user=None), self._make_response(full))
        self.assertEqual(
            json.loads(out.body)["result"]["status"], "fatal")

    def test_anonymous_unparseable_body_yields_opaque_ok(self):
        resp = MagicMock()
        resp.body = b"not json"
        resp.content_type = "application/json"
        resp.status_code = 200
        resp.headers = {}
        out = _filter_status(self._make_request(auth_user=None), resp)
        self.assertEqual(
            json.loads(out.body), {"type": "status", "result": {"status": "ok"}})


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

    def _make_request(self, xom, auth_user=None):
        req = MagicMock()
        req.authenticated_userid = auth_user
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

    def test_drops_users_with_no_visible_indexes(self):
        # Account enumeration hardening: a user whose only index the
        # requestor cannot read is removed entirely from the listing.
        body = {"result": {"alice": {"indexes": {"secret": {}}}}}
        xom = self._make_xom({"alice/secret": False})
        resp = self._make_response(body)
        req = self._make_request(xom, auth_user=None)
        out = _filter_root_listing(req, resp, xom)
        filtered = json.loads(out.body)
        self.assertNotIn("alice", filtered["result"])

    def test_root_sees_all_users_even_empty(self):
        # root administers everyone — zero-index / no-readable-index users
        # must remain so the Users page works.
        body = {"result": {
            "alice": {"indexes": {"secret": {}}},
            "ghost": {"indexes": {}},
        }}
        xom = self._make_xom({"alice/secret": False})
        resp = self._make_response(body)
        req = self._make_request(xom, auth_user="root")
        out = _filter_root_listing(req, resp, xom)
        filtered = json.loads(out.body)
        self.assertEqual(set(filtered["result"]), {"alice", "ghost"})
        self.assertEqual(filtered["result"]["alice"]["indexes"], {})

    def test_requestor_sees_own_account_even_without_indexes(self):
        body = {"result": {
            "alice": {"indexes": {}},
            "bob": {"indexes": {"secret": {}}},
        }}
        xom = self._make_xom({"bob/secret": False})
        resp = self._make_response(body)
        req = self._make_request(xom, auth_user="alice")
        out = _filter_root_listing(req, resp, xom)
        filtered = json.loads(out.body)
        self.assertIn("alice", filtered["result"])
        self.assertNotIn("bob", filtered["result"])

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

    def test_userdata_not_dict_kept_only_for_root(self):
        body = {"result": {"alice": "raw-string", "bob": {"indexes": {}}}}
        xom = self._make_xom({})
        # root sees the malformed entry; anonymous does not.
        out_root = _filter_root_listing(
            self._make_request(xom, auth_user="root"),
            self._make_response(body), xom)
        self.assertEqual(json.loads(out_root.body)["result"]["alice"], "raw-string")
        out_anon = _filter_root_listing(
            self._make_request(xom, auth_user=None),
            self._make_response(body), xom)
        self.assertNotIn("alice", json.loads(out_anon.body)["result"])

    def test_indexes_not_dict_kept_only_for_root(self):
        body = {"result": {"alice": {"indexes": "weird-value"}}}
        xom = self._make_xom({})
        out_root = _filter_root_listing(
            self._make_request(xom, auth_user="root"),
            self._make_response(body), xom)
        self.assertEqual(
            json.loads(out_root.body)["result"]["alice"]["indexes"], "weird-value")
        out_anon = _filter_root_listing(
            self._make_request(xom, auth_user=None),
            self._make_response(body), xom)
        self.assertNotIn("alice", json.loads(out_anon.body)["result"])

    def test_getstage_exception_drops_index(self):
        # Broken index is excluded without crashing; for root the user
        # stays (with empty indexes), proving the exception path is hit.
        body = {"result": {"alice": {"indexes": {"broken": {}}}}}
        xom = MagicMock()
        xom.model.getstage.side_effect = RuntimeError("boom")
        resp = self._make_response(body)
        req = self._make_request(xom, auth_user="root")
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


class RecordReplicaPollTests(unittest.TestCase):
    """Verify the tween captures /+changelog/{N}- requests correctly."""

    def setUp(self):
        main._replica_polls.clear()

    def tearDown(self):
        main._replica_polls.clear()

    def _req(self, *, method="GET", path="/+changelog/103-",
              uuid="r1-uuid", outside_url=None, client_addr="10.0.0.5"):
        req = MagicMock()
        req.method = method
        req.path = path
        req.client_addr = client_addr
        headers = {}
        if uuid is not None:
            headers["X-DEVPI-REPLICA-UUID"] = uuid
        if outside_url is not None:
            headers["X-DEVPI-REPLICA-OUTSIDE-URL"] = outside_url
        req.headers = headers
        return req

    def test_records_start_serial_for_replica_poll(self):
        main._record_replica_poll(self._req(path="/+changelog/103-"))
        self.assertIn("r1-uuid", main._replica_polls)
        rec = main._replica_polls["r1-uuid"]
        self.assertEqual(rec["start_serial"], 103)
        self.assertEqual(rec["remote_ip"], "10.0.0.5")

    def test_records_outside_url_when_present(self):
        main._record_replica_poll(self._req(outside_url="https://r1.local"))
        self.assertEqual(
            main._replica_polls["r1-uuid"]["outside_url"], "https://r1.local")

    def test_overwrites_previous_record_with_latest(self):
        main._record_replica_poll(self._req(path="/+changelog/103-"))
        main._record_replica_poll(self._req(path="/+changelog/186-"))
        self.assertEqual(
            main._replica_polls["r1-uuid"]["start_serial"], 186)

    def test_first_seen_at_serial_preserved_when_serial_unchanged(self):
        # Two polls for the same start_serial — the first_seen timestamp
        # must NOT advance, so the dashboard can detect stuck replicas.
        import time as _time
        main._record_replica_poll(self._req(path="/+changelog/103-"))
        rec1 = dict(main._replica_polls["r1-uuid"])
        _time.sleep(0.01)
        main._record_replica_poll(self._req(path="/+changelog/103-"))
        rec2 = main._replica_polls["r1-uuid"]
        self.assertEqual(
            rec1["first_seen_at_serial"], rec2["first_seen_at_serial"])
        self.assertGreater(rec2["last_seen"], rec1["last_seen"])

    def test_first_seen_at_serial_resets_on_serial_change(self):
        import time as _time
        main._record_replica_poll(self._req(path="/+changelog/103-"))
        rec1 = dict(main._replica_polls["r1-uuid"])
        _time.sleep(0.01)
        main._record_replica_poll(self._req(path="/+changelog/186-"))
        rec2 = main._replica_polls["r1-uuid"]
        self.assertGreater(
            rec2["first_seen_at_serial"], rec1["first_seen_at_serial"])

    def test_dict_bounded_under_uuid_spam(self):
        # /+changelog/ is anonymously reachable in devpi; an attacker
        # could spam unique UUIDs to exhaust master memory. Verify the
        # cap prevents runaway growth.
        original = main._REPLICA_POLL_MAX
        main._REPLICA_POLL_MAX = 8
        try:
            for i in range(100):
                main._record_replica_poll(
                    self._req(uuid="spam-" + str(i)))
            self.assertLessEqual(
                len(main._replica_polls), main._REPLICA_POLL_MAX)
        finally:
            main._REPLICA_POLL_MAX = original

    def test_ignores_request_without_uuid(self):
        main._record_replica_poll(self._req(uuid=None))
        self.assertEqual(main._replica_polls, {})

    def test_ignores_non_changelog_path(self):
        main._record_replica_poll(self._req(path="/+api"))
        self.assertEqual(main._replica_polls, {})

    def test_ignores_non_get_method(self):
        main._record_replica_poll(self._req(method="POST"))
        self.assertEqual(main._replica_polls, {})

    def test_accepts_changelog_without_trailing_dash(self):
        # Single-changelog endpoint /+changelog/{N} (no dash) is also
        # used during initial replica handshakes.
        main._record_replica_poll(self._req(path="/+changelog/42"))
        self.assertEqual(
            main._replica_polls["r1-uuid"]["start_serial"], 42)


class ReplicasViewTests(unittest.TestCase):
    """Verify the /+admin-api/replicas endpoint."""

    def setUp(self):
        main._replica_polls.clear()

    def tearDown(self):
        main._replica_polls.clear()

    def _authed_req(self):
        req = MagicMock()
        req.authenticated_userid = "alice"
        req.environ = {}
        return req

    def test_returns_recorded_polls(self):
        now = main.time.time()
        main._replica_polls["r1"] = {
            "start_serial": 103,
            "first_seen_at_serial": now - 45,
            "last_seen": now,
            "remote_ip": "10.0.0.5",
            "outside_url": "",
        }
        resp = main._replicas_view(self._authed_req())
        body = json.loads(resp.body)
        self.assertIn("r1", body["result"])
        self.assertEqual(body["result"]["r1"]["start_serial"], 103)
        self.assertEqual(body["result"]["r1"]["applied_serial"], 102)
        # Stuck for ~45s — the duration the replica has been polling
        # this same serial without progressing.
        self.assertGreaterEqual(body["result"]["r1"]["stuck_seconds"], 44)

    def test_drops_stale_entries(self):
        # Older than TTL → removed at read time
        now = main.time.time()
        main._replica_polls["r1"] = {
            "start_serial": 103,
            "first_seen_at_serial": now - main._REPLICA_POLL_TTL - 10,
            "last_seen": now - main._REPLICA_POLL_TTL - 5,
            "remote_ip": "",
            "outside_url": "",
        }
        resp = main._replicas_view(self._authed_req())
        body = json.loads(resp.body)
        self.assertEqual(body["result"], {})
        self.assertNotIn("r1", main._replica_polls)

    def test_anonymous_rejected(self):
        from pyramid.httpexceptions import HTTPForbidden
        req = MagicMock()
        req.authenticated_userid = None
        req.environ = {}
        with self.assertRaises(HTTPForbidden):
            main._replicas_view(req)


class PublicUrlViewTests(unittest.TestCase):
    """Verify the anonymous /+admin-api/public-url endpoint."""

    def test_returns_application_url_without_trailing_slash(self):
        req = MagicMock()
        req.application_url = "https://devpi.example.com/"
        resp = main._public_url_view(req)
        body = json.loads(resp.body)
        self.assertEqual(body, {"url": "https://devpi.example.com"})

    def test_handles_url_without_trailing_slash(self):
        req = MagicMock()
        req.application_url = "https://devpi.example.com"
        resp = main._public_url_view(req)
        body = json.loads(resp.body)
        self.assertEqual(body, {"url": "https://devpi.example.com"})

    def test_strips_multiple_trailing_slashes(self):
        req = MagicMock()
        req.application_url = "https://devpi.example.com///"
        resp = main._public_url_view(req)
        body = json.loads(resp.body)
        self.assertEqual(body, {"url": "https://devpi.example.com"})


class CheckCanIssueTests(unittest.TestCase):
    """Variant B: root may issue for *others*, never for self.

    Regular users only for themselves. Admin tokens never.
    """

    def _req(self, *, auth_user, is_admin_token=False):
        req = MagicMock()
        req.authenticated_userid = auth_user
        req.environ = {"adm.is_admin_token": True} if is_admin_token else {}
        return req

    def test_user_issues_for_self(self):
        req = self._req(auth_user="alice")
        self.assertEqual(main._check_can_issue(req, "alice"), "alice")

    def test_user_cannot_issue_for_others(self):
        from pyramid.httpexceptions import HTTPForbidden
        req = self._req(auth_user="alice")
        with self.assertRaises(HTTPForbidden):
            main._check_can_issue(req, "bob")

    def test_root_issues_for_others(self):
        req = self._req(auth_user="root")
        self.assertEqual(main._check_can_issue(req, "alice"), "root")

    def test_root_cannot_issue_for_self(self):
        from pyramid.httpexceptions import HTTPForbidden
        req = self._req(auth_user="root")
        with self.assertRaises(HTTPForbidden):
            main._check_can_issue(req, "root")

    def test_admin_token_request_cannot_issue(self):
        from pyramid.httpexceptions import HTTPForbidden
        req = self._req(auth_user="alice", is_admin_token=True)
        with self.assertRaises(HTTPForbidden):
            main._check_can_issue(req, "alice")

    def test_anonymous_cannot_issue(self):
        from pyramid.httpexceptions import HTTPForbidden
        req = self._req(auth_user=None)
        with self.assertRaises(HTTPForbidden):
            main._check_can_issue(req, "alice")


class CheckIndexPermTests(unittest.TestCase):

    def _stage(self, *, acl_read=None, acl_upload=None):
        stage = MagicMock()
        stage.ixconfig = {
            "acl_read": list(acl_read or []),
            "acl_upload": list(acl_upload or []),
        }
        return stage

    def test_read_with_user_in_acl(self):
        stage = self._stage(acl_read=["alice"])
        # No exception = pass
        main._check_index_perm(stage, "alice", "read")

    def test_read_anonymous_in_acl_grants_anyone(self):
        stage = self._stage(acl_read=[":ANONYMOUS:"])
        main._check_index_perm(stage, "alice", "read")

    def test_read_authenticated_in_acl_grants_real_users(self):
        stage = self._stage(acl_read=[":AUTHENTICATED:"])
        main._check_index_perm(stage, "alice", "read")

    def test_read_user_not_in_acl(self):
        from pyramid.httpexceptions import HTTPForbidden
        stage = self._stage(acl_read=["bob"])
        with self.assertRaises(HTTPForbidden):
            main._check_index_perm(stage, "alice", "read")

    def test_upload_uses_acl_upload(self):
        from pyramid.httpexceptions import HTTPForbidden
        stage = self._stage(acl_read=["alice"], acl_upload=["bob"])
        with self.assertRaises(HTTPForbidden):
            main._check_index_perm(stage, "alice", "upload")
        main._check_index_perm(stage, "bob", "upload")

    def test_invalid_scope(self):
        from pyramid.httpexceptions import HTTPBadRequest
        stage = self._stage(acl_read=["alice"])
        with self.assertRaises(HTTPBadRequest):
            main._check_index_perm(stage, "alice", "delete")

    def test_specials_case_insensitive(self):
        # Devpi normalises to upper case, but defend against a record
        # that slipped in via a custom code path.
        for spec in (":anonymous:", ":Anonymous:", ":AUTHENTICATED:",
                      ":authenticated:"):
            stage = self._stage(acl_read=[spec])
            main._check_index_perm(stage, "alice", "read")

    def test_unknown_special_does_not_grant(self):
        from pyramid.httpexceptions import HTTPForbidden
        # `:STAFF:` or anything else colon-wrapped is not a recognised
        # principal — must NOT grant access just because it looks like
        # a special.
        stage = self._stage(acl_read=[":STAFF:"])
        with self.assertRaises(HTTPForbidden):
            main._check_index_perm(stage, "alice", "read")


class UserChangedHandlerTests(unittest.TestCase):
    """Verify INDEX cleanup via USER subscriber diff."""

    def _make_event(self, *, value, back_serial=5, at_serial=6, user="alice"):
        ev = MagicMock()
        ev.value = value
        ev.back_serial = back_serial
        ev.at_serial = at_serial
        ev.typedkey.params = {"user": user}
        return ev

    def test_user_deleted_wipes_all(self):
        from devpi_admin import tokens as tokmod
        called = {}
        original = tokmod.reset_for_user
        tokmod.reset_for_user = lambda xom, u: called.setdefault("u", u) or 7
        try:
            xom = MagicMock()
            handler = main._make_user_changed_handler(xom)
            handler(self._make_event(value=None))
            self.assertEqual(called.get("u"), "alice")
        finally:
            tokmod.reset_for_user = original

    def test_index_removed_triggers_index_reset(self):
        from devpi_admin import tokens as tokmod
        calls = []
        original = tokmod.reset_for_index
        tokmod.reset_for_index = (
            lambda xom, u, i: calls.append((u, i)) or 2)
        try:
            xom = MagicMock()
            # Stub the previous-value fetch via our helper rather than
            # plumbing through the real keyfs API.
            old_indexes_returned = {"dev", "stage", "old"}
            new_indexes = {"dev"}
            ev = self._make_event(
                value={"indexes": {n: {} for n in new_indexes}})
            # Patch _removed_indexes directly so we don't need to mock
            # the keyfs read transaction machinery.
            real_removed = main._removed_indexes
            main._removed_indexes = (
                lambda _xom, _ev: old_indexes_returned - new_indexes)
            try:
                handler = main._make_user_changed_handler(xom)
                handler(ev)
            finally:
                main._removed_indexes = real_removed
            self.assertEqual(
                set(calls), {("alice", "stage"), ("alice", "old")})
        finally:
            tokmod.reset_for_index = original

    def test_no_index_change_no_reset(self):
        from devpi_admin import tokens as tokmod
        calls = []
        original = tokmod.reset_for_index
        tokmod.reset_for_index = (
            lambda xom, u, i: calls.append((u, i)) or 0)
        try:
            xom = MagicMock()
            real_removed = main._removed_indexes
            main._removed_indexes = lambda _xom, _ev: set()
            try:
                handler = main._make_user_changed_handler(xom)
                handler(self._make_event(value={"indexes": {"dev": {}}}))
            finally:
                main._removed_indexes = real_removed
            self.assertEqual(calls, [])
        finally:
            tokmod.reset_for_index = original

    def test_handler_swallows_exceptions(self):
        from devpi_admin import tokens as tokmod
        original = tokmod.reset_for_user
        tokmod.reset_for_user = MagicMock(side_effect=RuntimeError("boom"))
        try:
            xom = MagicMock()
            handler = main._make_user_changed_handler(xom)
            # Must not raise — keyfs notifier thread would die otherwise.
            handler(self._make_event(value=None))
        finally:
            tokmod.reset_for_user = original

    def test_back_serial_negative_returns_empty(self):
        # Creation event for a brand-new user — no previous state to
        # diff against. Must not call reset_for_index for any index.
        from devpi_admin import tokens as tokmod
        calls = []
        original = tokmod.reset_for_index
        tokmod.reset_for_index = lambda xom, u, i: calls.append((u, i))
        try:
            xom = MagicMock()
            real_removed = main._removed_indexes
            # back_serial < 0 short-circuit lives inside _removed_indexes
            # — let the real implementation run; it should return ∅.
            try:
                handler = main._make_user_changed_handler(xom)
                handler(self._make_event(
                    value={"indexes": {"dev": {}}}, back_serial=-1))
            finally:
                main._removed_indexes = real_removed
            self.assertEqual(calls, [])
        finally:
            tokmod.reset_for_index = original


class IndexDeleteEndToEndTests(unittest.TestCase):
    """Full chain: issue token → user-changed event → lookup must fail.

    Exercises the same in-memory keyfs as test_tokens.py so the cleanup
    path is verified across all three keyfs keys, not just the ones the
    handler explicitly touches.
    """

    def setUp(self):
        # Reuse the FakeXOM from test_tokens to avoid duplicating
        # 80 lines of keyfs scaffolding.
        from tests.test_tokens import _FakeXOM
        self.xom = _FakeXOM()

    def _issue(self, user, index, scope="read"):
        from devpi_admin import tokens as tokmod
        token, _ = tokmod.issue(
            self.xom, target_user=user, target_index=index,
            scope=scope, issuer=user, ttl_seconds=3600)
        return token

    def _user_change_event(self, user, *, new_indexes, back_serial=5,
                            at_serial=6):
        ev = MagicMock()
        ev.value = {"indexes": {n: {} for n in new_indexes}}
        ev.back_serial = back_serial
        ev.at_serial = at_serial
        ev.typedkey.params = {"user": user}
        return ev

    def test_index_delete_invalidates_token(self):
        from devpi_admin import tokens as tokmod
        token = self._issue("alice", "alice/dev")
        # Sanity: token works before cleanup.
        self.assertIsNotNone(tokmod.lookup(self.xom, token))

        # Patch _removed_indexes to report 'dev' was the gone index.
        real_removed = main._removed_indexes
        main._removed_indexes = lambda _xom, _ev: {"dev"}
        try:
            handler = main._make_user_changed_handler(self.xom)
            ev = self._user_change_event("alice", new_indexes=set())
            handler(ev)
        finally:
            main._removed_indexes = real_removed

        # After the handler, lookup must reject the token because the
        # token meta itself has been deleted from keyfs.
        self.assertIsNone(
            tokmod.lookup(self.xom, token),
            "token must not authenticate after its bound index was "
            "removed from USER.indexes")

    def test_index_delete_does_not_affect_other_index(self):
        from devpi_admin import tokens as tokmod
        dev_token = self._issue("alice", "alice/dev")
        stage_token = self._issue("alice", "alice/staging")

        real_removed = main._removed_indexes
        main._removed_indexes = lambda _xom, _ev: {"dev"}
        try:
            handler = main._make_user_changed_handler(self.xom)
            ev = self._user_change_event(
                "alice", new_indexes={"staging"})
            handler(ev)
        finally:
            main._removed_indexes = real_removed

        self.assertIsNone(tokmod.lookup(self.xom, dev_token))
        self.assertIsNotNone(
            tokmod.lookup(self.xom, stage_token),
            "tokens for alice/staging must survive deletion of alice/dev")

    def test_user_delete_invalidates_all_user_tokens(self):
        from devpi_admin import tokens as tokmod
        t1 = self._issue("alice", "alice/dev")
        t2 = self._issue("alice", "alice/staging", scope="upload")
        # Sibling user's token must NOT be touched.
        bob_token = self._issue("bob", "bob/own")

        ev = MagicMock()
        ev.value = None
        ev.back_serial = 5
        ev.at_serial = 6
        ev.typedkey.params = {"user": "alice"}

        handler = main._make_user_changed_handler(self.xom)
        handler(ev)

        # Drop alice from the model so lookup also fails the user-exists
        # check (matches what would happen in real devpi after USER del).
        self.xom._users.discard("alice")

        self.assertIsNone(tokmod.lookup(self.xom, t1))
        self.assertIsNone(tokmod.lookup(self.xom, t2))
        self.assertIsNotNone(
            tokmod.lookup(self.xom, bob_token),
            "bob's tokens must survive alice's deletion")


if __name__ == "__main__":
    unittest.main()
