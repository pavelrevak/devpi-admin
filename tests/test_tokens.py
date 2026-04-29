"""Unit tests for the admin token utilities."""
import unittest
from unittest.mock import MagicMock

from devpi_admin import tokens


class _FakeKey:
    """In-memory stand-in for a single keyfs typed-key value slot."""
    __slots__ = ("_store", "_path")

    def __init__(self, store, path):
        self._store = store
        self._path = path

    def exists(self):
        return self._path in self._store

    def get(self):
        return self._store[self._path]

    def set(self, value):
        # mimic devpi keyfs semantics: stored values are detached snapshots.
        if isinstance(value, set):
            self._store[self._path] = set(value)
        elif isinstance(value, dict):
            self._store[self._path] = dict(value)
        else:
            self._store[self._path] = value

    def delete(self):
        self._store.pop(self._path, None)


class _FakeKeyPattern:
    """Stand-in for a parameterised keyfs key (callable -> concrete key)."""

    def __init__(self, store, template):
        self._store = store
        self._template = template

    def __call__(self, **params):
        return _FakeKey(self._store, self._template.format(**params))


class _FakeXOM:
    """Minimal xom mock with a working in-memory keyfs and user model."""

    def __init__(self, users=("alice", "bob", "root")):
        self._store = {}
        self._patterns = {}
        self.config = MagicMock()
        self.config.role = "primary"
        cm = MagicMock()
        cm.__enter__ = MagicMock(return_value=None)
        cm.__exit__ = MagicMock(return_value=False)
        self.keyfs = MagicMock()
        self.keyfs.read_transaction.return_value = cm
        self.keyfs.write_transaction.return_value = cm
        self.keyfs.add_key.side_effect = self._add_key
        self.keyfs.get_key.side_effect = self._get_key
        tokens.register_keyfs_keys(self.keyfs)
        self.model = MagicMock()
        self._users = set(users)
        self.model.get_user.side_effect = (
            lambda u: MagicMock() if u in self._users else None)
        self.model.get_userlist.side_effect = (
            lambda: [MagicMock(name=u) for u in self._users])

    def _add_key(self, name, template, _type):
        self._patterns[name] = _FakeKeyPattern(self._store, template)

    def _get_key(self, name):
        return self._patterns.get(name)

    def store(self):
        return self._store


class IssueAndLookupTests(unittest.TestCase):

    def setUp(self):
        self.xom = _FakeXOM()

    def test_issue_persists_meta_with_index_and_scope(self):
        token, meta = tokens.issue(
            self.xom, target_user="alice", target_index="alice/dev",
            scope="read", issuer="alice", ttl_seconds=3600)
        self.assertTrue(token.startswith("adm_"))
        self.assertEqual(meta["user"], "alice")
        self.assertEqual(meta["index"], "alice/dev")
        self.assertEqual(meta["scope"], "read")
        # All three keyfs keys must be populated.
        store = self.xom.store()
        token_id = next(
            k.split("/")[-1] for k in store
            if k.startswith("+admin/tokens/"))
        self.assertIn("+admin/tokens/" + token_id, store)
        self.assertIn(token_id, store["+admin/user-tokens/alice"])
        self.assertIn(token_id, store["+admin/index-tokens/alice/dev"])

    def test_issue_rejects_invalid_scope(self):
        with self.assertRaises(ValueError):
            tokens.issue(
                self.xom, target_user="alice", target_index="alice/dev",
                scope="weird", issuer="alice", ttl_seconds=60)

    def test_issue_rejects_malformed_index(self):
        for bad in ("alice", "", "alice/dev/sub", "/dev", "alice/"):
            with self.assertRaises(ValueError):
                tokens.issue(
                    self.xom, target_user="alice", target_index=bad,
                    scope="read", issuer="alice", ttl_seconds=60)

    def test_lookup_returns_meta_for_valid_token(self):
        token, _ = tokens.issue(
            self.xom, target_user="alice", target_index="alice/dev",
            scope="upload", issuer="alice", ttl_seconds=3600)
        meta = tokens.lookup(self.xom, token)
        self.assertIsNotNone(meta)
        self.assertEqual(meta["scope"], "upload")
        self.assertEqual(meta["index"], "alice/dev")

    def test_lookup_rejects_legacy_token_without_index(self):
        # Forge a legacy record directly in the store (no index/scope).
        token, _ = tokens.issue(
            self.xom, target_user="alice", target_index="alice/dev",
            scope="read", issuer="alice", ttl_seconds=3600)
        token_id = next(
            k.split("/")[-1] for k in self.xom.store()
            if k.startswith("+admin/tokens/"))
        meta = self.xom.store()["+admin/tokens/" + token_id]
        meta.pop("index", None)
        meta.pop("scope", None)
        self.assertIsNone(tokens.lookup(self.xom, token))

    def test_lookup_rejects_wrong_secret(self):
        token, _ = tokens.issue(
            self.xom, target_user="alice", target_index="alice/dev",
            scope="read", issuer="alice", ttl_seconds=3600)
        token_id, _, _ = tokens._split(token), None, None
        # Build a token with same id but different secret.
        head, _ = token.split(".", 1)
        bad = head + "." + ("z" * 43)
        self.assertIsNone(tokens.lookup(self.xom, bad))

    def test_revoke_cleans_all_three_keys(self):
        token, _ = tokens.issue(
            self.xom, target_user="alice", target_index="alice/dev",
            scope="read", issuer="alice", ttl_seconds=3600)
        token_id = next(
            k.split("/")[-1] for k in self.xom.store()
            if k.startswith("+admin/tokens/"))
        self.assertTrue(tokens.revoke(self.xom, token_id))
        store = self.xom.store()
        self.assertNotIn("+admin/tokens/" + token_id, store)
        # Empty sets should be deleted, not left behind.
        self.assertNotIn("+admin/user-tokens/alice", store)
        self.assertNotIn("+admin/index-tokens/alice/dev", store)


class ResetForIndexTests(unittest.TestCase):

    def setUp(self):
        self.xom = _FakeXOM()

    def _issue(self, user, index, scope="read"):
        return tokens.issue(
            self.xom, target_user=user, target_index=index,
            scope=scope, issuer=user, ttl_seconds=3600)

    def test_reset_for_index_removes_only_that_index(self):
        self._issue("alice", "alice/dev")
        self._issue("alice", "alice/dev", scope="upload")
        self._issue("alice", "alice/staging")
        self._issue("bob", "alice/dev")  # bob has read on alice/dev

        count = tokens.reset_for_index(self.xom, "alice", "dev")
        self.assertEqual(count, 3)
        store = self.xom.store()
        self.assertNotIn("+admin/index-tokens/alice/dev", store)
        # alice/staging tokens untouched
        self.assertIn("+admin/index-tokens/alice/staging", store)
        # user-token sets pruned: alice has only the staging one left
        self.assertEqual(len(store["+admin/user-tokens/alice"]), 1)
        # bob's user-tokens set was emptied (and dropped)
        self.assertNotIn("+admin/user-tokens/bob", store)

    def test_reset_for_index_returns_zero_when_missing(self):
        self.assertEqual(
            tokens.reset_for_index(self.xom, "ghost", "nope"), 0)


class ListForIndexTests(unittest.TestCase):

    def setUp(self):
        self.xom = _FakeXOM()

    def test_list_for_index_returns_records(self):
        tokens.issue(
            self.xom, target_user="alice", target_index="alice/dev",
            scope="read", issuer="alice", ttl_seconds=3600, label="ci")
        tokens.issue(
            self.xom, target_user="bob", target_index="alice/dev",
            scope="upload", issuer="bob", ttl_seconds=3600)
        items = tokens.list_for_index(self.xom, "alice", "dev")
        self.assertEqual(len(items), 2)
        # secret_hash never leaks
        for _, meta in items:
            self.assertNotIn("secret_hash", meta)
            self.assertEqual(meta["index"], "alice/dev")


class CleanupChainIntegrationTests(unittest.TestCase):
    """End-to-end: token vydaný → cleanup udalosť → lookup() už zlyhá.

    Verifies the bookkeeping is consistent across the three keyfs keys
    (token meta + per-user set + per-index set), so a half-cleaned state
    cannot leave a token quietly authenticating.
    """

    def setUp(self):
        self.xom = _FakeXOM()

    def _issue(self, user, index, scope="read"):
        token, _ = tokens.issue(
            self.xom, target_user=user, target_index=index,
            scope=scope, issuer=user, ttl_seconds=3600)
        return token

    def _token_id(self, token):
        rest = token[4:]
        return rest.split(".", 1)[0]

    # --- single-token revoke ---

    def test_lookup_fails_after_revoke(self):
        token = self._issue("alice", "alice/dev")
        self.assertIsNotNone(tokens.lookup(self.xom, token))
        tokens.revoke(self.xom, self._token_id(token))
        self.assertIsNone(
            tokens.lookup(self.xom, token),
            "revoked token must no longer authenticate")

    # --- reset_for_index ---

    def test_lookup_fails_after_reset_for_index(self):
        token = self._issue("alice", "alice/dev")
        self.assertIsNotNone(tokens.lookup(self.xom, token))
        tokens.reset_for_index(self.xom, "alice", "dev")
        self.assertIsNone(tokens.lookup(self.xom, token))

    def test_reset_for_index_does_not_affect_other_indexes(self):
        # Two indexes for alice; wipe just the dev one.
        dev_token = self._issue("alice", "alice/dev")
        stage_token = self._issue("alice", "alice/staging")
        tokens.reset_for_index(self.xom, "alice", "dev")
        self.assertIsNone(tokens.lookup(self.xom, dev_token))
        self.assertIsNotNone(
            tokens.lookup(self.xom, stage_token),
            "tokens for alice/staging must survive reset_for_index(alice/dev)")

    def test_reset_for_index_does_not_affect_other_users_tokens(self):
        # bob has a token for alice/dev (bob has read on it). Resetting
        # alice/dev wipes bob's token there too — that's correct, the
        # whole *index* is being scrubbed.
        # But bob's token for bob/own must survive.
        bob_on_alice = self._issue("bob", "alice/dev")
        bob_on_own = self._issue("bob", "bob/own")
        tokens.reset_for_index(self.xom, "alice", "dev")
        self.assertIsNone(tokens.lookup(self.xom, bob_on_alice))
        self.assertIsNotNone(
            tokens.lookup(self.xom, bob_on_own),
            "tokens for unrelated indexes must survive reset_for_index")

    # --- reset_for_user ---

    def test_lookup_fails_after_reset_for_user(self):
        token = self._issue("alice", "alice/dev", scope="upload")
        tokens.reset_for_user(self.xom, "alice")
        self.assertIsNone(tokens.lookup(self.xom, token))

    def test_reset_for_user_does_not_affect_other_users(self):
        alice_token = self._issue("alice", "alice/dev")
        bob_token = self._issue("bob", "alice/dev")
        tokens.reset_for_user(self.xom, "alice")
        self.assertIsNone(tokens.lookup(self.xom, alice_token))
        self.assertIsNotNone(
            tokens.lookup(self.xom, bob_token),
            "bob's tokens must survive reset_for_user(alice)")

    def test_reset_for_user_cleans_index_set(self):
        # After reset_for_user, the per-index set for the affected
        # index must also be cleaned of those token ids — otherwise
        # list_for_index would later return zombies pointing to deleted
        # token records.
        token = self._issue("alice", "alice/dev")
        tid = self._token_id(token)
        tokens.reset_for_user(self.xom, "alice")
        items = tokens.list_for_index(self.xom, "alice", "dev")
        self.assertEqual(
            [t for t, _m in items], [],
            "index-tokens set should be empty after reset_for_user")
        # And the underlying token meta is gone too.
        store = self.xom.store()
        self.assertNotIn("+admin/tokens/" + tid, store)

    # --- lookup() rejects expired / unknown-user records ---

    def test_lookup_fails_for_unknown_user(self):
        token = self._issue("alice", "alice/dev")
        # Simulate user deletion at the model level (without firing
        # the cleanup handler). lookup() should still reject — defense
        # in depth: even if cleanup didn't run, the token is invalid.
        self.xom._users.discard("alice")
        self.assertIsNone(tokens.lookup(self.xom, token))

    def test_lookup_rejects_expired_token(self):
        # Issue with TTL=60s, then mutate stored expires_at into the past.
        token = self._issue("alice", "alice/dev")
        tid = self._token_id(token)
        meta = self.xom.store()["+admin/tokens/" + tid]
        meta["expires_at"] = 0
        self.assertIsNone(tokens.lookup(self.xom, token))


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
