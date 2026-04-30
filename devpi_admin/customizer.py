"""Mirror stage customizer with package allow/deny lists.

Filters projects, versions and simple-index links served from a mirror
index. Each entry is a PEP 508 requirement (``numpy``, ``numpy==1.26.0``,
``urllib3<1.26.5``) optionally with a glob in the name part for
namespace bans (``mojafirma-*``, ``*-internal``, ``mojafirma-*<2.0``).
An empty allowlist means "everything allowed except denylist"; a
non-empty allowlist switches the index into whitelist mode. The
denylist always wins and overrides allowlist matches.

Devpi-server refuses to register two customizers for the same index
``type`` (Fatal in xom startup), so we don't register a separate class
— instead we patch our methods onto the upstream ``MirrorCustomizer``,
which is an empty pass-through class designed exactly for this kind of
extension. The patch happens once at module import time.
"""
import fnmatch
import logging
import re

from devpi_server.mirror import MirrorCustomizer
from devpi_server.model import InvalidIndexconfig
from packaging.requirements import InvalidRequirement, Requirement
from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.utils import NormalizedName, canonicalize_name
from packaging.version import InvalidVersion, Version


# First char of a PEP 440 specifier set after the project name. A space
# is allowed too (``foo >= 1.0``). This is used only to split wildcard
# entries — non-wildcard entries go through Requirement() directly.
_SPEC_START_RE = re.compile(r"[<>=!~ ]")


_log = logging.getLogger(__name__)


class FilterRule:
    """One entry from allow/deny list.

    Two forms:
    - Plain PEP 508 requirement: ``numpy``, ``numpy>=2.0``, ``urllib3<1.26.5``.
    - Wildcard in name part: ``mojafirma-*``, ``*-internal`` or
      ``mojafirma-*<2.0``. Glob is matched (case-insensitively, after
      PEP 503 normalization) against the canonicalized project name.
    """

    __slots__ = ("name", "specifier", "raw", "is_wildcard")

    def __init__(self, raw: str):
        self.raw = raw
        if "*" in raw:
            self._init_wildcard(raw)
        else:
            self._init_plain(raw)
        # Pre-releases are accepted — `numpy>=2.0` should match
        # `2.0.0rc1` so an admin allowing a forthcoming version doesn't
        # accidentally exclude release candidates.
        if self.specifier is not None:
            self.specifier.prereleases = True

    def _init_plain(self, raw: str) -> None:
        req = Requirement(raw)
        # Markers / extras / URLs are silently ignored; index-side
        # filtering only looks at name + version specifier.
        self.name = canonicalize_name(req.name)
        self.specifier = req.specifier
        self.is_wildcard = False

    def _init_wildcard(self, raw: str) -> None:
        m = _SPEC_START_RE.search(raw)
        if m is not None:
            name_part = raw[:m.start()].strip()
            spec_part = raw[m.start():].strip()
        else:
            name_part = raw.strip()
            spec_part = ""
        if not name_part or "[" in name_part or ";" in name_part:
            raise InvalidRequirement(
                "wildcard entry %r: only name + optional version "
                "specifier are supported" % raw)
        # Canonicalize each non-'*' chunk so the pattern matches against
        # already-canonicalized names. ``Foo_*`` becomes ``foo-*`` and
        # matches ``foo-bar`` correctly.
        chunks = name_part.split("*")
        normalized = "*".join(
            canonicalize_name(c) if c else "" for c in chunks)
        self.name = normalized  # glob pattern, not a NormalizedName
        self.is_wildcard = True
        if spec_part:
            self.specifier = SpecifierSet(spec_part)
        else:
            self.specifier = SpecifierSet()

    def matches_name(self, name: NormalizedName) -> bool:
        if self.is_wildcard:
            # Both pattern and name are already lower-case + canonical;
            # use the case-sensitive variant to avoid surprises from a
            # locale-aware fnmatch().
            return fnmatch.fnmatchcase(name, self.name)
        return self.name == name

    def matches_version(self, name: NormalizedName, version: str) -> bool:
        if not self.matches_name(name):
            return False
        if not self.specifier:
            return True
        try:
            return Version(version) in self.specifier
        except InvalidVersion:
            # Devpi can carry weird upstream versions (legacy "1.0-dev")
            # that packaging refuses to parse. Be conservative: treat
            # unparseable versions as non-matching for both allow and
            # deny — caller decides what that implies.
            return False


def parse_rules(entries):
    """Parse a list of raw entry strings into FilterRule objects.

    Empty/whitespace-only entries are dropped; invalid entries raise
    InvalidRequirement / InvalidSpecifier (caller is expected to have
    validated already).
    """
    rules = []
    for entry in entries or ():
        entry = entry.strip()
        if not entry:
            continue
        rules.append(FilterRule(entry))
    return rules


def is_version_allowed(name, version, allow_rules, deny_rules):
    """Module-level version of the project-aware allow/deny check.

    Same semantics as ``DevpiAdminMirrorCustomizer._version_allowed`` but
    callable without a customizer instance (used by the +f/ download
    block in the request tween). ``name`` must already be canonicalized.
    """
    for rule in deny_rules:
        if rule.matches_version(name, version):
            return False
    if not allow_rules:
        return True
    return any(rule.matches_version(name, version) for rule in allow_rules)




def _validate_entries(value, key):
    if not isinstance(value, (list, tuple)):
        raise InvalidIndexconfig(
            "%s must be a list of entries" % key)
    for entry in value:
        entry = entry.strip()
        if not entry:
            continue
        try:
            FilterRule(entry)
        except (InvalidRequirement, InvalidSpecifier) as exc:
            raise InvalidIndexconfig(
                "invalid %s entry %r: %s" % (key, entry, exc))


class DevpiAdminMirrorCustomizer(MirrorCustomizer):
    """Mirror customizer with allow/deny filtering.

    Not registered as a separate customizer (devpi rejects duplicates for
    a given index type). Its methods are monkey-patched onto upstream
    MirrorCustomizer below — this class exists as a clean handle for
    tests and to keep the implementation cohesive.
    """

    def validate_config(self, oldconfig, newconfig):
        # Empty list ⇒ no filter (allowlist) / nothing banned (denylist).
        # Non-empty list entries must each parse as a PEP 508 requirement.
        _validate_entries(newconfig.get("package_allowlist", []), "package_allowlist")
        _validate_entries(newconfig.get("package_denylist", []), "package_denylist")

    # ---- filter helpers ----

    def _rules(self):
        cfg = self.stage.ixconfig
        allow = parse_rules(cfg.get("package_allowlist"))
        deny = parse_rules(cfg.get("package_denylist"))
        return allow, deny

    def _project_allowed(self, name: NormalizedName, allow, deny) -> bool:
        # Project-level: only block if the entire project is denied
        # (denylist entry has no specifier and matches by name). With a
        # specifier the deny is per-version, so the project as a whole
        # may still surface some allowed versions.
        for rule in deny:
            if not rule.specifier and rule.matches_name(name):
                return False
        if not allow:
            return True
        # In whitelist mode the project must be referenced by at least
        # one allow rule; specifier vs no-specifier doesn't matter here
        # because we filter further at version level.
        return any(rule.matches_name(name) for rule in allow)

    def _version_allowed(self, name: NormalizedName, version: str, allow, deny) -> bool:
        return is_version_allowed(name, version, allow, deny)

    # ---- hooks called by devpi-server ----

    def get_projects_filter_iter(self, projects):
        allow, deny = self._rules()
        if not allow and not deny:
            return None

        def gen():
            for project in projects:
                yield self._project_allowed(canonicalize_name(project), allow, deny)
        return gen()

    def get_versions_filter_iter(self, project, versions):
        allow, deny = self._rules()
        if not allow and not deny:
            return None
        name = canonicalize_name(project)

        def gen():
            for version in versions:
                yield self._version_allowed(name, version, allow, deny)
        return gen()

    def get_simple_links_filter_iter(self, project, links):
        # Defense in depth: even if a version sneaks through (e.g. devpi
        # internal cache state or an upstream filename mismatch), check
        # each individual file's parsed (name, version) before serving.
        allow, deny = self._rules()
        if not allow and not deny:
            return None
        project_name = canonicalize_name(project)

        def gen():
            for link in links:
                # SimplelinkMeta exposes .name (PEP 503) and .version
                # parsed from the wheel/sdist filename.
                try:
                    link_name = canonicalize_name(link.name)
                    link_version = link.version
                except Exception:
                    # Unparseable filename — drop it conservatively in
                    # whitelist mode, keep it otherwise.
                    yield not allow
                    continue
                # Filename name should equal project name; if it
                # doesn't we still trust the project name we were called
                # with as authoritative.
                yield self._version_allowed(
                    project_name if link_name != project_name else link_name,
                    link_version, allow, deny)
        return gen()


# Attach our methods to upstream MirrorCustomizer so devpi-server's
# single registration of `("mirror", MirrorCustomizer)` picks up our
# behavior. Skip dunder/private — copy explicit methods only.
for _name in (
        "validate_config",
        "_rules", "_project_allowed", "_version_allowed",
        "get_projects_filter_iter",
        "get_versions_filter_iter",
        "get_simple_links_filter_iter"):
    setattr(MirrorCustomizer, _name, getattr(DevpiAdminMirrorCustomizer, _name))
del _name
