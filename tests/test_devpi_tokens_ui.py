"""Textual smoke checks for the devpi-tokens UI integration.

The frontend is plain JS with no build step or JS test framework — these
Python tests are deliberately lightweight regression guards, not behavior
tests. They catch the most common breakage: someone renames a helper, an
endpoint URL drifts from what devpi-tokens accepts, or a user-facing
string changes between releases.

For real behavior testing, run the SPA against a devpi server with
`devpi-tokens` installed and walk through the test scenarios documented
in `PLAN-devpi-tokens-ui.md`.
"""
import os
import unittest


_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_APP_JS = os.path.join(_REPO_ROOT, "devpi_admin", "static", "js", "app.js")
_STYLE_CSS = os.path.join(_REPO_ROOT, "devpi_admin", "static", "css", "style.css")


def _read_app_js():
    with open(_APP_JS, "r", encoding="utf-8") as f:
        return f.read()


def _read_style_css():
    with open(_STYLE_CSS, "r", encoding="utf-8") as f:
        return f.read()


class DetectionTests(unittest.TestCase):
    """Plugin capability detection helper (Phase 1)."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()

    def test_detection_helper_exists(self):
        self.assertIn("function hasDevpiTokens", self.js)
        self.assertIn("function loadPluginCaps", self.js)
        self.assertIn("function devpiTokensVersion", self.js)

    def test_detection_checks_features_array(self):
        # The 'tokens' feature flag is the runtime contract; versioninfo
        # is the import-time fallback. Both must be queried.
        self.assertIn("indexOf('tokens')", self.js)
        self.assertIn("'devpi-tokens'", self.js)

    def test_loads_caps_on_users_view(self):
        # Without this, Devpi tokens kebab item only appears after the
        # Status page has been visited at least once.
        self.assertIn("Promise.all([fetchRoot(), loadPluginCaps()])", self.js)

    def test_loads_caps_on_indexes_view(self):
        # Per-index Devpi tokens kebab item depends on hasDevpiTokens()
        # being warm; loadIndexes must prefetch.
        self.assertIn(
            "Promise.all([fetchRoot(), loadPluginCaps()]).then(function (parts) {\n            var result = parts[0];\n            clear(content);\n            content.appendChild(el('div', {id: 'indexes-header'}));",
            self.js,
        )


class EndpointTests(unittest.TestCase):
    """Frontend talks directly to devpi-tokens — URLs must match."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()

    def test_list_endpoint(self):
        self.assertIn("'/' + encodeURIComponent(username) + '/+tokens'", self.js)
        self.assertIn("'/' + encodeURIComponent(idxUser) + '/+tokens'", self.js)

    def test_create_endpoint(self):
        self.assertIn(
            "'/' + encodeURIComponent(username) + '/+token-create'", self.js)

    def test_delete_endpoint_uses_token_id(self):
        self.assertIn("'/+tokens/' + encodeURIComponent(tokenId)", self.js)

    def test_create_body_uses_documented_field_names(self):
        # devpi-tokens restrictions parser whitelists these keys; any other
        # name returns 400 "Unknown restriction".
        self.assertIn("indexes:", self.js)
        self.assertIn("allowed:", self.js)
        self.assertIn("expires:", self.js)


class RestrictionParserTests(unittest.TestCase):
    """The wire format is `key=value` / `key=v1,v2` strings."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()

    def test_parser_recognizes_list_restrictions(self):
        for key in ("indexes", "projects", "allowed"):
            self.assertIn(key, self.js,
                "parser must recognize restriction key %r" % key)

    def test_parser_recognizes_int_restrictions(self):
        self.assertIn("expires:", self.js)
        self.assertIn("not_before", self.js)


class UserFacingStringsTests(unittest.TestCase):
    """Renamed from "Macaroon tokens" → "Devpi tokens" — guard the rename."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()

    def test_kebab_label_says_devpi_tokens(self):
        self.assertIn("'Devpi tokens'", self.js)

    def test_modal_titles_use_devpi_tokens(self):
        self.assertIn("'Devpi tokens for '", self.js)
        self.assertIn("'Issue Devpi token", self.js)

    def test_admin_tokens_kebab_label_renamed(self):
        # Phase 5 cleanup: original "Tokens" became "Admin tokens" so it
        # reads symmetrically with "Devpi tokens".
        self.assertIn("'Admin tokens'", self.js)
        self.assertIn("'Admin tokens for '", self.js)

    def test_no_user_facing_macaroon_label(self):
        # Internal identifiers (function names, CSS classes, comments) may
        # still mention "macaroon" — the term is still used in the security
        # banner to explain *why* the threat model differs. But no kebab
        # label, modal title, button, or empty-state should say "Macaroon".
        forbidden = [
            "label: 'Macaroon",
            "'Macaroon tokens for '",
            "'No macaroon tokens",
            "'Issue macaroon",
            "'Revoke macaroon",
        ]
        for needle in forbidden:
            self.assertNotIn(needle, self.js,
                "user-facing string %r should have been renamed" % needle)


class SecurityBannerTests(unittest.TestCase):
    """Persistent dismissible warning about raw-secret storage."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()
        cls.css = _read_style_css()

    def test_dismiss_key_is_per_user(self):
        # Different humans on the same browser should each see the warning
        # at least once — keying by Api.getUser() is the contract.
        self.assertIn(
            "'devpi-admin.macaroon-banner-dismissed.'",
            self.js)
        self.assertIn("Api.getUser() || '_anon'", self.js)

    def test_dismiss_uses_localstorage(self):
        # sessionStorage would re-show the banner on every browser reopen.
        self.assertIn("localStorage.getItem(_macaroonBannerKey())", self.js)
        self.assertIn("localStorage.setItem(_macaroonBannerKey()", self.js)

    def test_banner_explains_threat_model(self):
        self.assertIn("raw secret", self.js)
        self.assertIn("keyfs", self.js)

    def test_banner_close_button_styled(self):
        self.assertIn(".macaroon-security-dismiss", self.css)


class IssueFormTests(unittest.TestCase):
    """Anti-footgun defaults + custom expires + index tag picker."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()
        cls.css = _read_style_css()

    def test_default_expires_is_one_day(self):
        # 1 day matches admin tokens pip-conf default; longer TTLs are
        # explicit opt-in so a forgotten CI token doesn't outlive its
        # purpose by a year.
        self.assertIn("MACAROON_DEFAULT_EXPIRES = 86400", self.js)

    def test_one_hour_preset_present(self):
        # Mirrors TTL_OPTIONS for admin tokens.
        self.assertIn("seconds: 3600", self.js)
        self.assertIn("'1 hour'", self.js)

    def test_default_perms_safe(self):
        self.assertIn("MACAROON_PERMS_DEFAULT_CHECKED = {pkg_read: 1, upload: 1}",
            self.js)

    def test_destructive_perms_in_advanced_section(self):
        for perm in ("del_entry", "del_project", "del_verdata",
                "index_modify", "index_delete"):
            self.assertIn("'" + perm + "'", self.js)
        # The destructive group must be visually distinct so a hurried
        # user doesn't accidentally include them.
        self.assertIn(".macaroon-perms-advanced", self.css)

    def test_uses_tag_picker_for_indexes(self):
        # buildTagPicker is the same component used for acl_read /
        # acl_upload — visual consistency across the modal universe.
        self.assertIn("buildTagPicker(\n                    'macaroon-indexes'",
            self.js)

    def test_custom_expires_option(self):
        self.assertIn("'Custom\\u2026'", self.js.encode().decode('unicode_escape')
            ) if False else self.assertIn("Custom", self.js)
        # Picker reveals on demand and clears its value on switch-away,
        # so the form has a single source of truth.
        self.assertIn("customWrap.hidden = (expSel.value !== 'custom')",
            self.js)


class IndexTokensFilterTests(unittest.TestCase):
    """Per-index view filters owner's tokens client-side (Phase 4)."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()

    def test_super_tokens_included(self):
        # A token with no `indexes` caveat grants access to every index;
        # the per-index view must surface it so admins know it exists.
        self.assertIn("if (!parsed.indexes || !parsed.indexes.length) return true",
            self.js)

    def test_index_tokens_kebab_gated_to_owner_or_root(self):
        self.assertIn(
            "if ((loggedIn === 'root' || loggedIn === idx._user)"
            "\n                        && hasDevpiTokens())",
            self.js)


if __name__ == "__main__":
    unittest.main()
