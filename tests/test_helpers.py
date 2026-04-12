"""Tests for helper functions in main.py."""
import unittest

from devpi_admin.main import (
    _normalize,
    _project_name_from_filename,
    _version_from_filename,
)


class NormalizeTests(unittest.TestCase):

    def test_lowercase(self):
        self.assertEqual(_normalize("Foo"), "foo")

    def test_underscores(self):
        self.assertEqual(_normalize("my_package"), "my-package")

    def test_dots(self):
        self.assertEqual(_normalize("my.package"), "my-package")

    def test_mixed(self):
        self.assertEqual(_normalize("My_Cool.Package"), "my-cool-package")

    def test_consecutive(self):
        self.assertEqual(_normalize("foo__bar"), "foo-bar")


class ProjectNameFromFilenameTests(unittest.TestCase):

    def test_wheel(self):
        self.assertEqual(
            _project_name_from_filename(
                "setuptools-82.0.1-py3-none-any.whl"),
            "setuptools")

    def test_wheel_underscore(self):
        self.assertEqual(
            _project_name_from_filename(
                "charset_normalizer-3.4.7-cp314-cp314-manylinux_2_17_x86_64.whl"),
            "charset-normalizer")

    def test_sdist_tar_gz(self):
        self.assertEqual(
            _project_name_from_filename(
                "requests-2.33.1.tar.gz"),
            "requests")

    def test_sdist_zip(self):
        self.assertEqual(
            _project_name_from_filename(
                "my-package-1.0.0.zip"),
            "my-package")

    def test_unknown_extension(self):
        self.assertIsNone(
            _project_name_from_filename("readme.txt"))

    def test_no_version_separator(self):
        self.assertIsNone(
            _project_name_from_filename("noversion.tar.gz"))


class VersionFromFilenameTests(unittest.TestCase):

    def test_wheel(self):
        self.assertEqual(
            _version_from_filename(
                "setuptools-82.0.1-py3-none-any.whl"),
            "82.0.1")

    def test_wheel_with_build(self):
        self.assertEqual(
            _version_from_filename(
                "foo-1.2.3-1-py3-none-any.whl"),
            "1.2.3")

    def test_sdist_tar_gz(self):
        self.assertEqual(
            _version_from_filename(
                "requests-2.33.1.tar.gz"),
            "2.33.1")

    def test_sdist_zip(self):
        self.assertEqual(
            _version_from_filename(
                "my-package-1.0.0.zip"),
            "1.0.0")

    def test_dev_version(self):
        self.assertEqual(
            _version_from_filename(
                "villapro_lpr_db-0.0.1.dev35+ga50425652-py3-none-any.whl"),
            "0.0.1.dev35+ga50425652")

    def test_unknown(self):
        self.assertIsNone(
            _version_from_filename("readme.txt"))


if __name__ == "__main__":
    unittest.main()
