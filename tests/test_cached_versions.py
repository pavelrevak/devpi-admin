"""Tests for _cached_versions_for_project filesystem scanning."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

import devpi_admin.main as plugin
from devpi_admin.main import _cached_versions_for_project


class CachedVersionsTests(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.xom = MagicMock()
        self.xom.config.serverdir = self.tmpdir
        # Stable serial per test so we exercise the scan path each time;
        # also reset the module-level cache to isolate tests.
        self.xom.keyfs.get_current_serial.return_value = 0
        plugin._files_scan_cache.clear()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)
        plugin._files_scan_cache.clear()

    def _create_file(self, user, index, hashdir, filename):
        d = Path(self.tmpdir) / "+files" / user / index / "+f" / hashdir
        d.mkdir(parents=True, exist_ok=True)
        (d / filename).write_text("")

    def test_empty_dir(self):
        result = _cached_versions_for_project(
            self.xom, "root", "pypi", "requests")
        self.assertEqual(result, [])

    def test_single_wheel(self):
        self._create_file(
            "root", "pypi", "abc/123",
            "requests-2.33.1-py3-none-any.whl")
        result = _cached_versions_for_project(
            self.xom, "root", "pypi", "requests")
        self.assertEqual(result, ["2.33.1"])

    def test_multiple_versions(self):
        self._create_file(
            "root", "pypi", "abc/123",
            "requests-2.31.0-py3-none-any.whl")
        self._create_file(
            "root", "pypi", "def/456",
            "requests-2.33.1-py3-none-any.whl")
        result = _cached_versions_for_project(
            self.xom, "root", "pypi", "requests")
        self.assertEqual(result, ["2.33.1", "2.31.0"])

    def test_sdist_and_wheel(self):
        self._create_file(
            "root", "pypi", "abc/123",
            "setuptools-82.0.1-py3-none-any.whl")
        self._create_file(
            "root", "pypi", "def/456",
            "setuptools-82.0.1.tar.gz")
        result = _cached_versions_for_project(
            self.xom, "root", "pypi", "setuptools")
        self.assertEqual(result, ["82.0.1"])

    def test_different_projects_not_mixed(self):
        self._create_file(
            "root", "pypi", "abc/123",
            "requests-2.33.1-py3-none-any.whl")
        self._create_file(
            "root", "pypi", "def/456",
            "urllib3-2.6.3-py3-none-any.whl")
        result = _cached_versions_for_project(
            self.xom, "root", "pypi", "requests")
        self.assertEqual(result, ["2.33.1"])

    def test_underscore_normalization(self):
        self._create_file(
            "root", "pypi", "abc/123",
            "charset_normalizer-3.4.7-cp314-cp314-manylinux_2_17_x86_64.whl")
        result = _cached_versions_for_project(
            self.xom, "root", "pypi", "charset-normalizer")
        self.assertEqual(result, ["3.4.7"])

    def test_different_index(self):
        self._create_file(
            "ci", "testing", "abc/123",
            "mypackage-1.0.0-py3-none-any.whl")
        result = _cached_versions_for_project(
            self.xom, "root", "pypi", "mypackage")
        self.assertEqual(result, [])

    def test_cache_hit_skips_rescan(self):
        # First call populates the cache for serial 0.
        self._create_file(
            "root", "pypi", "abc/123",
            "requests-2.31.0-py3-none-any.whl")
        result1 = _cached_versions_for_project(
            self.xom, "root", "pypi", "requests")
        self.assertEqual(result1, ["2.31.0"])

        # New file added on disk but serial unchanged → cached scan reused
        # so the new version is not visible yet (this is the contract).
        self._create_file(
            "root", "pypi", "def/456",
            "requests-2.33.1-py3-none-any.whl")
        result2 = _cached_versions_for_project(
            self.xom, "root", "pypi", "requests")
        self.assertEqual(result2, ["2.31.0"])

    def test_cache_invalidates_on_serial_bump(self):
        self._create_file(
            "root", "pypi", "abc/123",
            "requests-2.31.0-py3-none-any.whl")
        _cached_versions_for_project(
            self.xom, "root", "pypi", "requests")
        self._create_file(
            "root", "pypi", "def/456",
            "requests-2.33.1-py3-none-any.whl")
        # devpi commits a new serial when files change on disk.
        self.xom.keyfs.get_current_serial.return_value = 1
        result = _cached_versions_for_project(
            self.xom, "root", "pypi", "requests")
        self.assertEqual(result, ["2.33.1", "2.31.0"])

    def test_cache_bounded(self):
        # Fill the cache past its limit and verify size stays capped.
        original_max = plugin._FILES_SCAN_CACHE_MAX
        plugin._FILES_SCAN_CACHE_MAX = 4
        try:
            for i in range(10):
                _cached_versions_for_project(
                    self.xom, "root", "ix%d" % i, "anything")
            self.assertLessEqual(len(plugin._files_scan_cache), 4)
        finally:
            plugin._FILES_SCAN_CACHE_MAX = original_max


if __name__ == "__main__":
    unittest.main()
