"""Sanity tests for the plugin package itself."""
import unittest
from importlib.metadata import entry_points
from pathlib import Path

import devpi_admin
import devpi_admin.main as plugin_main


class PackageTests(unittest.TestCase):

    def test_version_string(self):
        self.assertIsInstance(devpi_admin.__version__, str)
        self.assertTrue(len(devpi_admin.__version__) > 0)

    def test_hooks_exposed(self):
        # devpi-server will pick these up via pluggy
        self.assertTrue(callable(plugin_main.devpiserver_pyramid_configure))
        self.assertTrue(callable(plugin_main.devpiserver_get_features))
        self.assertTrue(callable(plugin_main.devpi_admin_tween_factory))

    def test_get_features_returns_set(self):
        features = plugin_main.devpiserver_get_features()
        self.assertIn("devpi-admin", features)

    def test_entry_point_registered(self):
        eps = entry_points(group="devpi_server")
        names = [ep.name for ep in eps]
        self.assertIn("devpi-admin", names,
                      "devpi_server entry point 'devpi-admin' not registered")

    def test_static_dir_exists(self):
        self.assertTrue(plugin_main.STATIC_DIR.is_dir())

    def test_static_files_bundled(self):
        expected = [
            "index.html",
            "css/style.css",
            "js/app.js",
            "js/api.js",
            "js/theme.js",
            "js/marked.min.js",
        ]
        for rel in expected:
            path = plugin_main.STATIC_DIR / rel
            self.assertTrue(
                path.is_file(),
                "missing bundled asset: {}".format(rel))


if __name__ == "__main__":
    unittest.main()
