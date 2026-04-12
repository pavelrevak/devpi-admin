"""Tests for helper functions in main.py."""
import unittest

from devpi_admin.main import _normalize, _parse_filename


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


class ParseFilenameTests(unittest.TestCase):

    # --- project name extraction ---

    def test_wheel_name(self):
        name, _ver = _parse_filename(
            "setuptools-82.0.1-py3-none-any.whl")
        self.assertEqual(name, "setuptools")

    def test_wheel_underscore_name(self):
        name, _ver = _parse_filename(
            "charset_normalizer-3.4.7-cp314-cp314-manylinux_2_17_x86_64.whl")
        self.assertEqual(name, "charset-normalizer")

    def test_sdist_tar_gz_name(self):
        name, _ver = _parse_filename("requests-2.33.1.tar.gz")
        self.assertEqual(name, "requests")

    def test_sdist_zip_name(self):
        name, _ver = _parse_filename("my-package-1.0.0.zip")
        self.assertEqual(name, "my-package")

    def test_unknown_extension_name(self):
        name, ver = _parse_filename("readme.txt")
        self.assertIsNone(name)
        self.assertIsNone(ver)

    def test_no_version_separator_name(self):
        name, ver = _parse_filename("noversion.tar.gz")
        self.assertIsNone(name)
        self.assertIsNone(ver)

    # --- version extraction ---

    def test_wheel_version(self):
        _name, ver = _parse_filename(
            "setuptools-82.0.1-py3-none-any.whl")
        self.assertEqual(ver, "82.0.1")

    def test_wheel_with_build_version(self):
        _name, ver = _parse_filename(
            "foo-1.2.3-1-py3-none-any.whl")
        self.assertEqual(ver, "1.2.3")

    def test_sdist_tar_gz_version(self):
        _name, ver = _parse_filename("requests-2.33.1.tar.gz")
        self.assertEqual(ver, "2.33.1")

    def test_sdist_zip_version(self):
        _name, ver = _parse_filename("my-package-1.0.0.zip")
        self.assertEqual(ver, "1.0.0")

    def test_dev_version(self):
        _name, ver = _parse_filename(
            "villapro_lpr_db-0.0.1.dev35+ga50425652-py3-none-any.whl")
        self.assertEqual(ver, "0.0.1.dev35+ga50425652")

    def test_unknown_version(self):
        name, ver = _parse_filename("readme.txt")
        self.assertIsNone(ver)

    # --- both together ---

    def test_wheel_name_and_version(self):
        name, ver = _parse_filename(
            "setuptools-82.0.1-py3-none-any.whl")
        self.assertEqual(name, "setuptools")
        self.assertEqual(ver, "82.0.1")

    def test_sdist_name_and_version(self):
        name, ver = _parse_filename("requests-2.33.1.tar.gz")
        self.assertEqual(name, "requests")
        self.assertEqual(ver, "2.33.1")


if __name__ == "__main__":
    unittest.main()
