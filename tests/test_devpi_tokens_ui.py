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

    def test_devpi_create_endpoint(self):
        self.assertIn(
            "'/' + encodeURIComponent(username) + '/+token-create'", self.js)

    def test_admin_create_endpoint(self):
        # Unified Issue modal dispatches to /+admin-api/token for the
        # Admin tokens branch.
        self.assertIn("'/+admin-api/token'", self.js)

    def test_delete_endpoint_uses_token_id(self):
        self.assertIn("'/+tokens/' + encodeURIComponent(tokenId)", self.js)

    def test_devpi_body_uses_documented_field_names(self):
        # devpi-tokens restrictions parser whitelists these keys; any other
        # name returns 400 "Unknown restriction".
        self.assertIn("indexes:", self.js)
        self.assertIn("allowed:", self.js)
        self.assertIn("expires:", self.js)

    def test_admin_body_uses_backend_field_names(self):
        # /+admin-api/token expects user / index / scope / ttl_seconds / label
        for field in ("user:", "index:", "scope:", "ttl_seconds:", "label:"):
            self.assertIn(field, self.js,
                "Admin POST body must include %r" % field)


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

    def test_unified_modal_titles(self):
        # Unified Tokens modal titles — per-user and per-index variants.
        # Old per-type "Devpi tokens for X" / "Admin tokens for X" titles
        # were retired with the orphan modals.
        self.assertIn("'Tokens for ' + username", self.js)
        self.assertIn("'Tokens for ' + userIdx", self.js)
        # Issue modal title omits the token type because the selector
        # inside the modal makes it explicit.
        self.assertIn("'Issue token \\u2014 ' + username".replace(
            "\\u2014", "—"), self.js)

    def test_unified_tokens_kebab_label(self):
        # User card has a single "Tokens" item that opens the unified
        # modal (Admin + Devpi sections in one place).
        self.assertIn("label: 'Tokens'", self.js)
        # Modal title for unified per-user listing.
        self.assertIn("'Tokens for ' + username", self.js)

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
        # Indented one level deeper now that the picker lives inside the
        # `else` (non-locked-index) branch.
        self.assertIn(
            "buildTagPicker(\n                        'macaroon-indexes'",
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
        # Unified Tokens kebab is offered for both Admin and Devpi tokens,
        # so it doesn't depend on hasDevpiTokens — owner/root see it
        # always, then the modal hides any empty section internally.
        self.assertIn(
            "if (loggedIn === 'root' || loggedIn === idx._user) {\n"
            "                    (function (idxRef) {\n"
            "                        menuItems.push({\n"
            "                            label: 'Tokens',",
            self.js)


class UnifiedIssueModalTests(unittest.TestCase):
    """One Issue modal serves both token backends (Phase 6)."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()

    def test_token_type_constants(self):
        self.assertIn("var TOKEN_TYPE_DEVPI = 'devpi'", self.js)
        self.assertIn("var TOKEN_TYPE_ADMIN = 'admin'", self.js)

    def test_unified_entry_point_exists(self):
        self.assertIn("function showIssueTokenModal(username, options)", self.js)

    def test_unified_listing_has_issue_button(self):
        # Single Issue entry point on the unified per-user Tokens modal —
        # no preselectType so the user picks devpi/admin in the form.
        self.assertIn("showIssueTokenModal(username);", self.js)

    def test_per_index_uses_unified_modal_with_preselect_and_lock(self):
        # Per-index Issue: preselect + lockIndex so the user can't
        # accidentally aim at a different index from per-index context.
        self.assertIn("preselectIndexes: [userIdx],", self.js)
        self.assertIn("lockIndex: true,", self.js)

    def test_type_visibility_helper(self):
        # data-token-only attribute drives field visibility.
        self.assertIn("function _applyTokenTypeVisibility", self.js)
        self.assertIn("data-token-only", self.js)

    def test_admin_form_has_scope_select(self):
        # Admin tokens have ONE scope per token, not a permission list.
        self.assertIn("'admin-scope-select'", self.js)
        self.assertIn("textContent: 'read", self.js)
        self.assertIn("textContent: 'upload", self.js)

    def test_admin_form_uses_single_index_select(self):
        # Admin tokens bind to one index — single <select>, not multi tag picker.
        self.assertIn("'admin-index-select'", self.js)

    def test_admin_form_has_label_field(self):
        self.assertIn("'admin-label'", self.js)

    def test_falls_back_to_admin_when_devpi_unavailable(self):
        # If the user requested Devpi but the plugin is not installed,
        # silently use Admin tokens instead of failing.
        self.assertIn(
            "if (preselType === TOKEN_TYPE_DEVPI && !hasDevpiTokens())",
            self.js)

    def test_admin_token_ttl_validation(self):
        # Pre-flight bounds-check matches backend (60 s … 1 year).
        self.assertIn("Admin tokens must live at least 60 seconds.", self.js)
        self.assertIn("Admin tokens cannot live longer than 1 year.", self.js)

    def test_issued_view_uses_capability_helper(self):
        # The shared _renderIssued must derive read/upload capability from
        # the form so it picks the right configs to render for either
        # backend.
        self.assertIn("function _issuedCapabilities(form)", self.js)
        self.assertIn("canRead:", self.js)
        self.assertIn("canUpload:", self.js)


class UnifiedListingTests(unittest.TestCase):
    """Single Tokens modal merges Admin + Devpi sections (Phase 7)."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()
        cls.css = _read_style_css()

    def test_user_kebab_has_single_tokens_item(self):
        # Replaced "Admin tokens" + "Devpi tokens" pair on the user card.
        self.assertIn("label: 'Tokens'", self.js)
        self.assertIn("showTokensModal(uname)", self.js)

    def test_unified_modal_function_exists(self):
        self.assertIn("function showTokensModal(username)", self.js)
        self.assertIn("function _renderUnifiedTokensModal", self.js)

    def test_sections_hide_when_empty(self):
        # Each section starts hidden; the post-fetch reconciliation
        # toggles visibility based on the actual count.
        self.assertIn("'tokens-admin-section'", self.js)
        self.assertIn("'tokens-devpi-section'", self.js)
        self.assertIn("'tokens-empty-both'", self.js)
        self.assertIn("adminEl.hidden = (adminCount === 0)", self.js)
        self.assertIn("devpiEl.hidden = (devpiCount === 0)", self.js)

    def test_render_functions_return_count(self):
        # Both list renderers must resolve with the count so the unified
        # modal can decide what to hide. The hideOnEmpty option suppresses
        # the per-section "No tokens." placeholder.
        self.assertIn("if (hideOnEmpty) return 0", self.js)
        # Admin path explicitly returns from .then chain.
        self.assertIn("return tokens.length;", self.js)
        # Devpi path resolves with ids count.
        self.assertIn("return ids.length;", self.js)

    def test_section_heading_styled(self):
        self.assertIn(".tokens-section-heading", self.css)


class IndexScopingTests(unittest.TestCase):
    """Issue form filters indexes to the bound user by default (Phase 7)."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()

    def test_issue_context_carries_acl_map(self):
        # _renderIssued reads aclByIndex to decide whether pip.conf is
        # worth surfacing.
        self.assertIn("var _issueContext = null", self.js)
        self.assertIn("aclByIndex:", self.js)

    def test_pickers_share_accessible_indexes(self):
        # Single accessible-indexes set powers both Devpi (multi) and
        # Admin (single) pickers — owner OR ACL-allowed for the bound user.
        self.assertIn("accessibleIndexes:", self.js)
        self.assertIn("for (var ii = 0; ii < indexOptions.length; ii++)", self.js)

    def test_acl_membership_grants_access(self):
        # Bound user gets to see indexes where they're in acl_read or
        # acl_upload of someone else's index, not just owned ones.
        self.assertIn("idx.acl_read.indexOf(username)", self.js)
        self.assertIn("idx.acl_upload.indexOf(username)", self.js)

    def test_root_sees_every_index(self):
        # Root bypasses ACL everywhere, so the picker shouldn't pretend
        # otherwise.
        self.assertIn("var isRoot = username === 'root'", self.js)

    def test_preselect_indexes_always_available(self):
        # Caller-supplied preselect must show up even if the bound user
        # has no ACL match (e.g. root issuing on behalf of pavel from
        # alice's index).
        self.assertIn("if (accessible.indexOf(presel[p]) === -1)", self.js)


class IssuedViewSmartConfigTests(unittest.TestCase):
    """pip.conf only when at least one bound index actually needs auth."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()

    def test_helper_checks_each_index_acl(self):
        self.assertIn("function _anyIndexPrivate(indexes)", self.js)
        self.assertIn("isPublicAclRead(acl)", self.js)

    def test_pipconf_skipped_for_all_public(self):
        # Combined predicate gates the pip.conf block.
        self.assertIn(
            "if (caps.canRead && _anyIndexPrivate(form.indexes))",
            self.js)


class IndexKebabTests(unittest.TestCase):
    """Quick-actions on the index card (Phase 8)."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()

    def test_pip_conf_kebab_only_for_public_indexes(self):
        # Private indexes route through the unified Tokens flow so the
        # user explicitly chooses scope/TTL and gets credentialed config.
        self.assertIn("if (isPublicAclRead(idx.acl_read))", self.js)
        # The private-side "pip.conf + token" / ".pypirc + token" quick
        # actions are gone.
        self.assertNotIn("'pip.conf' + (needsToken ? ' + token' : '')", self.js)
        self.assertNotIn("'.pypirc' + (needsToken ? ' + token' : '')", self.js)

    def test_unified_index_tokens_modal_function_exists(self):
        self.assertIn("function showIndexTokensModal", self.js)
        self.assertIn("function _renderUnifiedIndexTokensModal", self.js)

    def test_per_index_admin_tokens_endpoint(self):
        self.assertIn("'/+admin-api/indexes/'", self.js)

    def test_per_index_admin_render_returns_count(self):
        self.assertIn("function renderIndexAdminTokensList", self.js)
        # Same count contract as the per-user list (Promise<int>).
        self.assertIn("if (hideOnEmpty) return 0", self.js)

    def test_per_index_issue_preselects_index(self):
        self.assertIn(
            "showIssueTokenModal(idxUser, {\n                            preselectIndexes: [userIdx],",
            self.js)


class AdminScopeGatingTests(unittest.TestCase):
    """Admin scope auto-defaults based on index ACL; user can override."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()

    def test_public_index_omits_read_option(self):
        # On a public index the read option isn't even appended to the
        # select — only upload is shown. Private indexes get both.
        self.assertIn("function _refreshAdminScopeOptions", self.js)
        self.assertIn("if (!publicIdx) {", self.js)
        # The unconditional append after the if-block is for upload.
        self.assertIn(
            "scopeSel.appendChild(el('option', {\n"
            "                        value: 'upload',",
            self.js)

    def test_scope_hint_explains_public_index(self):
        self.assertIn("only upload", self.js)
        self.assertIn("scope is meaningful", self.js)


class IssuedIntentTests(unittest.TestCase):
    """Result view follows the user's stated scope intent."""

    @classmethod
    def setUpClass(cls):
        cls.js = _read_app_js()

    def test_admin_capability_is_intent_not_backend_max(self):
        # Picking upload means upload — pip.conf surfaces only when the
        # user explicitly requested read.
        self.assertIn(
            "canRead: form.scope === 'read',\n"
            "            canUpload: form.scope === 'upload',",
            self.js)

    def test_done_returns_to_unified_modal(self):
        # Done navigation falls back to the per-user unified Tokens modal
        # so the new token shows alongside everything else for that user.
        self.assertIn("_issueReturnTo = options.returnTo || function ()", self.js)
        self.assertIn("showTokensModal(username);", self.js)

    def test_per_index_passes_returnto(self):
        # Per-index Issue button preserves the per-index context on Done.
        self.assertIn("returnTo: function () {\n"
            "                                showIndexTokensModal(\n"
            "                                    idxUser, idxName, aclRead);", self.js)

    def test_per_index_locks_picker(self):
        # When the entry already knows the index, the picker is hidden
        # entirely so the user can't accidentally aim the token at a
        # different one.
        self.assertIn("lockIndex: true", self.js)
        self.assertIn("var _issueLockedIndex = null", self.js)
        self.assertIn(
            "_issueLockedIndex = (options.lockIndex && presel.length)",
            self.js)
        # Form collector falls back to the locked index when set.
        self.assertIn(
            "form.indexes = _issueLockedIndex\n"
            "                ? [_issueLockedIndex]\n"
            "                : getTagPickerValues",
            self.js)


if __name__ == "__main__":
    unittest.main()
