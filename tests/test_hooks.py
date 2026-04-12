"""Tests that plugin hooks are properly registered with pluggy."""
import unittest

from pluggy import PluginManager

from devpi_server import hookspecs
import devpi_admin.main as plugin


class HookRegistrationTests(unittest.TestCase):

    def setUp(self):
        self.pm = PluginManager("devpiserver")
        self.pm.add_hookspecs(hookspecs)
        self.pm.register(plugin)

    def test_plugin_registered(self):
        self.assertTrue(
            self.pm.is_registered(plugin),
            "plugin module not registered with pluggy")

    def test_get_features_recognized(self):
        results = self.pm.hook.devpiserver_get_features()
        found = set()
        for s in results:
            found.update(s)
        self.assertIn("devpi-admin", found)

    def test_pyramid_configure_recognized(self):
        callers = self.pm.hook.devpiserver_pyramid_configure.\
            get_hookimpls()
        modules = [impl.plugin for impl in callers]
        self.assertIn(plugin, modules,
                      "devpiserver_pyramid_configure not found in hook impls")

    def test_no_unknown_hooks(self):
        # All public devpiserver_* functions must be valid hookspecs.
        # If a function has @hookimpl but a typo in the name, pluggy
        # would reject it at register() — this test catches that.
        hook_names = [
            name for name in dir(plugin)
            if name.startswith("devpiserver_") and callable(getattr(plugin, name))
        ]
        spec_names = [
            name for name in dir(hookspecs)
            if name.startswith("devpiserver_") and callable(getattr(hookspecs, name))
        ]
        for name in hook_names:
            self.assertIn(
                name, spec_names,
                "{} is not a valid devpi-server hookspec".format(name))


if __name__ == "__main__":
    unittest.main()
