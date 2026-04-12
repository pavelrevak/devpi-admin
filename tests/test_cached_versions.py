"""Tests for _cached_versions_for_project filesystem scanning."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from devpi_admin.main import _cached_versions_for_project


class CachedVersionsTests(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.xom = MagicMock()
        self.xom.config.serverdir = self.tmpdir

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

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


if __name__ == "__main__":
    unittest.main()
