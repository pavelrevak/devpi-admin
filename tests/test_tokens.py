"""Unit tests for the admin token utilities."""
import unittest
from unittest.mock import MagicMock

from devpi_admin import tokens


class TokenFormatTests(unittest.TestCase):

    def test_generated_format(self):
        token, token_id, secret_hash = tokens._generate()
        self.assertTrue(tokens.looks_like_token(token))
        self.assertTrue(tokens.looks_like_token_id(token_id))
        self.assertEqual(len(secret_hash), 64)  # sha256 hex
        # the plaintext secret must NOT equal the stored hash
        secret = token.split(".", 1)[1]
        self.assertNotEqual(secret, secret_hash)

    def test_looks_like_token_requires_prefix_and_dot(self):
        self.assertFalse(tokens.looks_like_token("xxx_abc.def"))
        self.assertFalse(tokens.looks_like_token("adm_" + "x" * 50))  # no dot
        self.assertFalse(tokens.looks_like_token(""))
        self.assertFalse(tokens.looks_like_token(None))

    def test_looks_like_token_rejects_short(self):
        self.assertFalse(tokens.looks_like_token("adm_short.short"))

    def test_looks_like_token_rejects_devpi_session_token(self):
        self.assertFalse(tokens.looks_like_token(
            '["root", [], true].ae3.signature_part_here'))

    def test_split_returns_id_and_secret(self):
        token, token_id, _ = tokens._generate()
        parts = tokens._split(token)
        self.assertIsNotNone(parts)
        self.assertEqual(parts[0], token_id)
        # second part is the raw secret
        self.assertGreaterEqual(len(parts[1]), 40)

    def test_split_returns_none_for_invalid(self):
        self.assertIsNone(tokens._split("not-a-token"))
        self.assertIsNone(tokens._split(""))
        self.assertIsNone(tokens._split("adm_no_dot_here_just_one_blob"))

    def test_generated_tokens_are_unique(self):
        ts = {tokens._generate()[0] for _ in range(100)}
        self.assertEqual(len(ts), 100)

    def test_token_uses_url_safe_alphabet(self):
        token, _, _ = tokens._generate()
        self.assertRegex(token, r"^adm_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")

    def test_hash_is_deterministic(self):
        h1 = tokens._hash_secret("hello")
        h2 = tokens._hash_secret("hello")
        self.assertEqual(h1, h2)
        self.assertNotEqual(h1, tokens._hash_secret("hellp"))


class CleanupPreHashTokensTests(unittest.TestCase):
    """Sanity checks for the startup migration helper.

    Plugin-configure time has no active keyfs transaction — the helper must
    open one itself or get_userlist() raises AttributeError on tx.
    """

    def _mock_xom(self, usernames):
        xom = MagicMock()
        # read_transaction / write_transaction are context managers.
        cm = MagicMock()
        cm.__enter__ = MagicMock(return_value=None)
        cm.__exit__ = MagicMock(return_value=False)
        xom.keyfs.read_transaction.return_value = cm
        xom.keyfs.write_transaction.return_value = cm
        # Both keyfs keys must be registered for the cleanup to even try.
        xom.keyfs.get_key.side_effect = lambda name: MagicMock()
        users = [MagicMock(name=u) for u in usernames]
        for mock, u in zip(users, usernames):
            mock.name = u
        xom.model.get_userlist.return_value = users
        return xom

    def test_opens_transaction_for_userlist(self):
        xom = self._mock_xom([])
        result = tokens.cleanup_pre_hash_tokens(xom)
        self.assertEqual(result, 0)
        # Must have opened a read transaction before calling get_userlist.
        xom.keyfs.read_transaction.assert_called()

    def test_returns_zero_on_userlist_failure(self):
        # Simulates the original bug: get_userlist raises AttributeError(tx).
        xom = self._mock_xom([])
        xom.model.get_userlist.side_effect = AttributeError("tx")
        # Must swallow the exception cleanly so server startup continues.
        self.assertEqual(tokens.cleanup_pre_hash_tokens(xom), 0)


if __name__ == "__main__":
    unittest.main()
