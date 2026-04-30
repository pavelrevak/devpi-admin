"""Tests for the mirror allow/deny package filter."""
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

from devpi_server.model import InvalidIndexconfig
from pyramid.httpexceptions import HTTPNotFound

from devpi_admin import main as plugin
from devpi_admin.customizer import (
    DevpiAdminMirrorCustomizer, FilterRule, _validate_entries)
from devpi_admin.main import _pkg_file_deny_check


def _customizer(allow=None, deny=None):
    """Build a customizer wired to a stub stage carrying just the ixconfig."""
    cfg = {"package_allowlist": allow or [], "package_denylist": deny or []}
    stage = SimpleNamespace(
        ixconfig=cfg,
        xom=SimpleNamespace(config=SimpleNamespace(hook=SimpleNamespace())))
    c = DevpiAdminMirrorCustomizer.__new__(DevpiAdminMirrorCustomizer)
    c.stage = stage
    c.hooks = stage.xom.config.hook
    return c


def _drain(iterator, items):
    """Run apply_filter_iter semantics: True keeps, False drops."""
    if iterator is None:
        return list(items)
    out = []
    for item in items:
        keep = next(iterator, True)
        if keep:
            out.append(item)
    return out


class FilterRuleTests(unittest.TestCase):

    def test_name_only_matches_any_version(self):
        r = FilterRule("numpy")
        self.assertTrue(r.matches_version("numpy", "1.0"))
        self.assertTrue(r.matches_version("numpy", "99.99.0a1"))
        self.assertFalse(r.matches_version("scipy", "1.0"))

    def test_version_specifier(self):
        r = FilterRule("urllib3<1.26.5")
        self.assertTrue(r.matches_version("urllib3", "1.26.4"))
        self.assertFalse(r.matches_version("urllib3", "1.26.5"))
        self.assertFalse(r.matches_version("urllib3", "2.0.0"))
        self.assertFalse(r.matches_version("requests", "1.0.0"))

    def test_canonicalized_name_match(self):
        # Caller is expected to pass canonicalized names; the rule
        # itself is stored canonicalized.
        r = FilterRule("Django")
        self.assertTrue(r.matches_version("django", "4.0"))
        self.assertFalse(r.matches_version("DJANGO", "4.0"))

    def test_unparseable_version_does_not_match_specifier(self):
        r = FilterRule("foo>=1.0")
        self.assertFalse(r.matches_version("foo", "not-a-version"))

    def test_wildcard_prefix(self):
        r = FilterRule("mojafirma-*")
        self.assertTrue(r.is_wildcard)
        self.assertTrue(r.matches_version("mojafirma-billing", "1.0"))
        self.assertTrue(r.matches_version("mojafirma-x", "0.0.1"))
        self.assertFalse(r.matches_version("numpy", "1.0"))
        self.assertFalse(r.matches_version("mojafirma", "1.0"))  # no hyphen

    def test_wildcard_suffix(self):
        r = FilterRule("*-internal")
        self.assertTrue(r.matches_version("foo-internal", "1.0"))
        self.assertTrue(r.matches_version("bar-internal", "2.0"))
        self.assertFalse(r.matches_version("foo-public", "1.0"))

    def test_wildcard_with_specifier(self):
        r = FilterRule("mojafirma-*<2.0")
        self.assertTrue(r.matches_version("mojafirma-x", "1.5"))
        self.assertFalse(r.matches_version("mojafirma-x", "2.0"))
        self.assertFalse(r.matches_version("numpy", "1.5"))

    def test_wildcard_underscore_normalization(self):
        # Pattern "Mojafirma_*" should match canonicalized "mojafirma-x"
        # because "_" canonicalizes to "-".
        r = FilterRule("Mojafirma_*")
        self.assertTrue(r.matches_version("mojafirma-x", "1.0"))

    def test_wildcard_rejects_extras_or_marker(self):
        from packaging.requirements import InvalidRequirement
        with self.assertRaises(InvalidRequirement):
            FilterRule("foo-*[extras]")
        with self.assertRaises(InvalidRequirement):
            FilterRule("foo-*; python_version<'3.10'")

    def test_wildcard_match_all(self):
        # Edge case but consistent: deny "*" blocks everything.
        r = FilterRule("*")
        self.assertTrue(r.matches_version("anything", "1.0"))


class ValidationTests(unittest.TestCase):

    def test_valid_entries_pass(self):
        _validate_entries(
            ["numpy", "requests>=2.0", "  django==4.0  ", ""],
            "package_allowlist")

    def test_invalid_entry_rejected(self):
        with self.assertRaises(InvalidIndexconfig):
            _validate_entries(["!!! bogus"], "package_allowlist")

    def test_non_list_rejected(self):
        with self.assertRaises(InvalidIndexconfig):
            _validate_entries("numpy,requests", "package_allowlist")

    def test_validate_config_via_customizer(self):
        c = _customizer()
        c.validate_config({}, {"package_allowlist": ["numpy", "requests>=2"]})
        with self.assertRaises(InvalidIndexconfig):
            c.validate_config({}, {"package_denylist": ["@@@"]})


class ProjectFilterTests(unittest.TestCase):

    def test_empty_config_returns_none(self):
        c = _customizer()
        self.assertIsNone(c.get_projects_filter_iter(["numpy"]))
        self.assertIsNone(c.get_versions_filter_iter("numpy", ["1.0"]))
        self.assertIsNone(c.get_simple_links_filter_iter("numpy", []))

    def test_allowlist_only_those_listed(self):
        c = _customizer(allow=["numpy", "requests"])
        out = _drain(
            c.get_projects_filter_iter(["numpy", "requests", "django", "scipy"]),
            ["numpy", "requests", "django", "scipy"])
        self.assertEqual(out, ["numpy", "requests"])

    def test_allowlist_with_specifier_keeps_project(self):
        # Project-level filter only checks names. Specifier filtering
        # happens at the version level.
        c = _customizer(allow=["numpy>=2.0"])
        out = _drain(
            c.get_projects_filter_iter(["numpy", "scipy"]),
            ["numpy", "scipy"])
        self.assertEqual(out, ["numpy"])

    def test_denylist_blocks_whole_project_when_no_specifier(self):
        c = _customizer(deny=["evilpkg"])
        out = _drain(
            c.get_projects_filter_iter(["numpy", "evilpkg"]),
            ["numpy", "evilpkg"])
        self.assertEqual(out, ["numpy"])

    def test_denylist_wildcard_blocks_namespace(self):
        # Real-world: ban an internal namespace from the public mirror.
        c = _customizer(deny=["mojafirma-*"])
        projects = ["mojafirma-billing", "mojafirma-auth", "numpy", "django"]
        out = _drain(c.get_projects_filter_iter(projects), projects)
        self.assertEqual(out, ["numpy", "django"])

    def test_denylist_with_specifier_keeps_project_visible(self):
        # urllib3<1.26.5 deny → project still listed (older ones
        # remain visible), versions filter handles per-version block.
        c = _customizer(deny=["urllib3<1.26.5"])
        out = _drain(
            c.get_projects_filter_iter(["urllib3", "numpy"]),
            ["urllib3", "numpy"])
        self.assertEqual(out, ["urllib3", "numpy"])

    def test_canonicalization(self):
        # PEP 503: lowercase + [-_.]+ → '-'. Hyphen != removal.
        c = _customizer(allow=["Foo-Bar"])
        out = _drain(
            c.get_projects_filter_iter(["foo-bar", "Foo_Bar", "FOO.BAR", "scipy"]),
            ["foo-bar", "Foo_Bar", "FOO.BAR", "scipy"])
        self.assertEqual(out, ["foo-bar", "Foo_Bar", "FOO.BAR"])


class VersionFilterTests(unittest.TestCase):

    def test_allowlist_specifier(self):
        c = _customizer(allow=["numpy>=2.0"])
        out = _drain(
            c.get_versions_filter_iter("numpy", ["1.9", "2.0", "2.5", "3.0"]),
            ["1.9", "2.0", "2.5", "3.0"])
        self.assertEqual(out, ["2.0", "2.5", "3.0"])

    def test_denylist_overrides_allowlist(self):
        # Allow numpy entirely, deny <2.0 → only 2.x reaches us.
        c = _customizer(allow=["numpy"], deny=["numpy<2.0"])
        out = _drain(
            c.get_versions_filter_iter("numpy", ["1.0", "1.9", "2.0", "2.5"]),
            ["1.0", "1.9", "2.0", "2.5"])
        self.assertEqual(out, ["2.0", "2.5"])

    def test_denylist_only_mode(self):
        # Empty allowlist + non-empty denylist = everything except deny.
        c = _customizer(deny=["urllib3<1.26.5"])
        out = _drain(
            c.get_versions_filter_iter("urllib3", ["1.26.4", "1.26.5", "2.0"]),
            ["1.26.4", "1.26.5", "2.0"])
        self.assertEqual(out, ["1.26.5", "2.0"])

    def test_allowlist_blocks_unrelated_project(self):
        c = _customizer(allow=["numpy"])
        out = _drain(
            c.get_versions_filter_iter("scipy", ["1.0"]),
            ["1.0"])
        self.assertEqual(out, [])

    def test_unparseable_version_in_allowlist_mode_dropped(self):
        c = _customizer(allow=["numpy>=1.0"])
        out = _drain(
            c.get_versions_filter_iter("numpy", ["1.0", "weird-legacy"]),
            ["1.0", "weird-legacy"])
        self.assertEqual(out, ["1.0"])


class SimpleLinkFilterTests(unittest.TestCase):

    def _link(self, name, version):
        # Mimic SimplelinkMeta interface: just .name and .version.
        return SimpleNamespace(name=name, version=version)

    def test_filters_links_per_version(self):
        c = _customizer(deny=["urllib3<1.26.5"])
        links = [
            self._link("urllib3", "1.26.4"),
            self._link("urllib3", "1.26.5"),
            self._link("urllib3", "2.0.0"),
        ]
        out = _drain(
            c.get_simple_links_filter_iter("urllib3", links),
            links)
        self.assertEqual([l.version for l in out], ["1.26.5", "2.0.0"])

    def test_returns_none_when_no_rules(self):
        c = _customizer()
        self.assertIsNone(c.get_simple_links_filter_iter("urllib3", []))

    def test_unparseable_filename_dropped_in_allowlist_mode(self):
        class Bad:
            @property
            def name(self):
                raise ValueError("unparseable")
            version = "1.0"
        c = _customizer(allow=["numpy"])
        bad = Bad()
        out = _drain(
            c.get_simple_links_filter_iter("numpy", [bad]),
            [bad])
        self.assertEqual(out, [])


class PkgFileDenyCheckTests(unittest.TestCase):
    """Tween-level +f/ download block."""

    def _xom(self, ixconfig):
        stage = SimpleNamespace(ixconfig=ixconfig)
        xom = MagicMock()
        xom.model.getstage.return_value = stage
        return xom

    def _req(self, path):
        r = MagicMock()
        r.path = path
        return r

    def test_blocks_denied_version(self):
        xom = self._xom({
            "type": "mirror",
            "package_denylist": ["urllib3<1.26.5"],
        })
        req = self._req("/root/pypi/+f/ab/cd/urllib3-1.26.4.tar.gz")
        result = _pkg_file_deny_check(req, xom)
        self.assertIsInstance(result, HTTPNotFound)

    def test_passes_allowed_version(self):
        xom = self._xom({
            "type": "mirror",
            "package_denylist": ["urllib3<1.26.5"],
        })
        req = self._req("/root/pypi/+f/ab/cd/urllib3-1.26.5.tar.gz")
        self.assertIsNone(_pkg_file_deny_check(req, xom))

    def test_blocks_wildcard_namespace(self):
        xom = self._xom({
            "type": "mirror",
            "package_denylist": ["mycompany-*"],
        })
        req = self._req("/root/pypi/+f/ab/cd/mycompany-billing-1.0.tar.gz")
        self.assertIsInstance(_pkg_file_deny_check(req, xom), HTTPNotFound)

    def test_blocks_outside_allowlist(self):
        xom = self._xom({
            "type": "mirror",
            "package_allowlist": ["numpy"],
        })
        req = self._req("/root/pypi/+f/ab/cd/scipy-1.0.tar.gz")
        self.assertIsInstance(_pkg_file_deny_check(req, xom), HTTPNotFound)

    def test_allowlist_member_passes(self):
        xom = self._xom({
            "type": "mirror",
            "package_allowlist": ["numpy"],
        })
        req = self._req("/root/pypi/+f/ab/cd/numpy-1.26.0-cp310-cp310-linux_x86_64.whl")
        self.assertIsNone(_pkg_file_deny_check(req, xom))

    def test_skips_non_mirror_index(self):
        # Stage indexes don't carry allow/deny config; type guard prevents
        # accidental enforcement on private uploads.
        xom = self._xom({
            "type": "stage",
            "package_denylist": ["urllib3"],  # ignored anyway
        })
        req = self._req("/alice/dev/+f/ab/cd/urllib3-1.26.4.tar.gz")
        self.assertIsNone(_pkg_file_deny_check(req, xom))

    def test_skips_when_no_rules(self):
        xom = self._xom({"type": "mirror"})
        req = self._req("/root/pypi/+f/ab/cd/urllib3-1.26.4.tar.gz")
        self.assertIsNone(_pkg_file_deny_check(req, xom))
        # No keyfs lookup either — getstage shouldn't be called when
        # path doesn't match. Here it does match, so getstage IS called,
        # but rules check exits early. Verify no exception.

    def test_skips_non_file_paths(self):
        xom = self._xom({
            "type": "mirror",
            "package_denylist": ["urllib3"],
        })
        # +simple/ is handled by customizer hooks, not this check.
        for path in ("/root/pypi/+simple/urllib3/", "/root/pypi/urllib3",
                     "/", "/root", "/root/pypi"):
            req = self._req(path)
            self.assertIsNone(
                _pkg_file_deny_check(req, xom),
                "should not match path %r" % path)

    def test_unparseable_filename_falls_through(self):
        # Don't 500 the request; let devpi handle it (it'll 404 anyway).
        xom = self._xom({
            "type": "mirror",
            "package_denylist": ["urllib3"],
        })
        req = self._req("/root/pypi/+f/ab/cd/garbage")
        self.assertIsNone(_pkg_file_deny_check(req, xom))


class HookIntegrationTests(unittest.TestCase):

    def test_indexconfig_defaults_for_mirror(self):
        defaults = plugin.devpiserver_indexconfig_defaults("mirror")
        self.assertIn("package_allowlist", defaults)
        self.assertIn("package_denylist", defaults)
        self.assertEqual(defaults["package_allowlist"], [])
        self.assertEqual(defaults["package_denylist"], [])
        self.assertIn("acl_read", defaults)

    def test_indexconfig_defaults_for_stage(self):
        defaults = plugin.devpiserver_indexconfig_defaults("stage")
        self.assertNotIn("package_allowlist", defaults)
        self.assertNotIn("package_denylist", defaults)
        self.assertIn("acl_read", defaults)

    def test_methods_patched_onto_upstream_mirror_customizer(self):
        # We don't register a separate customizer (devpi rejects dups);
        # instead our methods are monkey-patched onto the upstream
        # MirrorCustomizer at import time of devpi_admin.customizer.
        from devpi_server.mirror import MirrorCustomizer
        self.assertIs(
            MirrorCustomizer.get_projects_filter_iter,
            DevpiAdminMirrorCustomizer.get_projects_filter_iter)
        self.assertIs(
            MirrorCustomizer.validate_config,
            DevpiAdminMirrorCustomizer.validate_config)

    def test_no_customizer_classes_hook(self):
        # Belt-and-suspenders: ensure we don't accidentally re-add the
        # hook and trigger devpi's "multiple implementation classes" Fatal.
        self.assertFalse(
            hasattr(plugin, "devpiserver_get_stage_customizer_classes"))


if __name__ == "__main__":
    unittest.main()
