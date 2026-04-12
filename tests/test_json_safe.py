"""Tests for _to_json_safe conversion."""
import json
import unittest

from devpi_admin.main import _to_json_safe


class ToJsonSafeTests(unittest.TestCase):

    def test_plain_types_unchanged(self):
        self.assertEqual(_to_json_safe("hello"), "hello")
        self.assertEqual(_to_json_safe(42), 42)
        self.assertEqual(_to_json_safe(3.14), 3.14)
        self.assertEqual(_to_json_safe(True), True)
        self.assertIsNone(_to_json_safe(None))

    def test_dict(self):
        self.assertEqual(
            _to_json_safe({"a": 1, "b": "c"}),
            {"a": 1, "b": "c"})

    def test_list(self):
        self.assertEqual(_to_json_safe([1, 2, 3]), [1, 2, 3])

    def test_tuple_to_list(self):
        self.assertEqual(_to_json_safe((2026, 4, 12)), [2026, 4, 12])

    def test_set_to_sorted_list(self):
        self.assertEqual(_to_json_safe({"c", "a", "b"}), ["a", "b", "c"])

    def test_frozenset_to_sorted_list(self):
        self.assertEqual(
            _to_json_safe(frozenset(["x", "y"])),
            ["x", "y"])

    def test_nested(self):
        data = {
            "name": "foo",
            "versions": {"1.0", "2.0"},
            "when": (2026, 4, 12, 8, 0, 0),
            "tags": ["a", "b"],
        }
        result = _to_json_safe(data)
        self.assertEqual(result["name"], "foo")
        self.assertEqual(result["versions"], ["1.0", "2.0"])
        self.assertEqual(result["when"], [2026, 4, 12, 8, 0, 0])
        self.assertEqual(result["tags"], ["a", "b"])
        # Must be JSON-serializable
        json.dumps(result)

    def test_dict_like_object(self):
        class FakeReadonly:
            def __init__(self, d):
                self._d = d
            def items(self):
                return self._d.items()
            def keys(self):
                return self._d.keys()
            def __iter__(self):
                return iter(self._d)
            def __getitem__(self, k):
                return self._d[k]
        obj = FakeReadonly({"key": "val"})
        self.assertEqual(_to_json_safe(obj), {"key": "val"})

    def test_unknown_type_to_str(self):
        class Custom:
            def __str__(self):
                return "custom-repr"
        self.assertEqual(_to_json_safe(Custom()), "custom-repr")


if __name__ == "__main__":
    unittest.main()
