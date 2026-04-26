"""Unit tests for the admin token utilities."""
import re
import unittest

from devpi_admin import tokens


class TokenFormatTests(unittest.TestCase):

    def test_looks_like_token_accepts_generated(self):
        for _ in range(20):
            t = tokens._generate()
            self.assertTrue(
                tokens.looks_like_token(t),
                "generated token should match: %r" % t)

    def test_looks_like_token_requires_prefix(self):
        self.assertFalse(tokens.looks_like_token("xxx_abcdef"))
        self.assertFalse(tokens.looks_like_token("abcdef" * 10))

    def test_looks_like_token_rejects_short(self):
        self.assertFalse(tokens.looks_like_token("adm_short"))

    def test_looks_like_token_rejects_devpi_session_token(self):
        # devpi session tokens have format ["user", [], true].timestamp.signature
        # — they must NOT be mistaken for our admin tokens.
        self.assertFalse(tokens.looks_like_token(
            '["root", [], true].ae3.signature_part_here'))

    def test_looks_like_token_handles_empty_and_none(self):
        self.assertFalse(tokens.looks_like_token(""))
        self.assertFalse(tokens.looks_like_token(None))

    def test_generated_tokens_are_unique(self):
        ts = {tokens._generate() for _ in range(100)}
        self.assertEqual(len(ts), 100)

    def test_split_strips_prefix(self):
        token = tokens._generate()
        tid = tokens._split(token)
        self.assertEqual(tokens.TOKEN_PREFIX + tid, token)
        self.assertGreaterEqual(len(tid), 32)

    def test_split_returns_none_for_invalid(self):
        self.assertIsNone(tokens._split("not-a-token"))
        self.assertIsNone(tokens._split(""))

    def test_token_uses_url_safe_alphabet(self):
        token = tokens._generate()
        self.assertRegex(token, r"^adm_[A-Za-z0-9_-]+$")


if __name__ == "__main__":
    unittest.main()
