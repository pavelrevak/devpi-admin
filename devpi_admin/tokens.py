"""Stateful opaque tokens for devpi-admin.

Token format: ``adm_<token_id>.<secret>``

* ``token_id`` — random 16 raw bytes encoded url-safe base64 (~22 chars).
  Used as the lookup key in keyfs.
* ``secret`` — random 32 raw bytes encoded url-safe base64 (~43 chars).
  Only its SHA-256 is persisted; the plaintext is shown to the issuer
  exactly once (at creation time).

Authentication compares the secret hash via constant-time ``hmac.compare_digest``.
Storage compromise (keyfs dump, replica disk, backup) does NOT reveal usable
tokens — the attacker would still need to find a SHA-256 preimage.

Each token is bound to a specific ``user/index`` and a ``scope``
(``read`` or ``upload``). The bound user is the ACL identity used by
devpi for permission evaluation; the index restricts URL access via the
tween; the scope restricts allowed HTTP methods. A leaked token is
contained to one index and one operation class.

Three keyfs keys keep the bookkeeping consistent:

* ``+admin/tokens/{token_id}``                    — token metadata + hash
* ``+admin/user-tokens/{user}``                   — set of token_ids per user
* ``+admin/index-tokens/{user}/{index}``          — set of token_ids per index

Cleanup on user delete walks ``user-tokens``; cleanup on index delete walks
``index-tokens``. Both are kept in sync by ``issue`` / ``revoke`` /
``reset_for_*``.
"""
import hashlib
import hmac
import logging
import re
import secrets
import time


log = logging.getLogger(__name__)

TOKEN_PREFIX = "adm_"
# token_id and secret are both base64url with strict length bounds. The
# length floors come from the byte counts in `_generate`; the ceilings
# guard against pathological lookups via crafted long ids.
_ID_RE = r"[A-Za-z0-9_-]{20,32}"
_SECRET_RE = r"[A-Za-z0-9_-]{40,64}"
_TOKEN_RE = re.compile(r"^adm_(" + _ID_RE + r")\.(" + _SECRET_RE + r")$")
_TOKEN_ID_RE = re.compile(r"^" + _ID_RE + r"$")

DEFAULT_TTL = 3600                 # 1 hour
DEFAULT_MAX_TTL = 31_536_000       # 1 year — final cap configurable per deployment
KEY_TOKEN = "ADMIN_TOKEN"
KEY_USER_TOKENS = "ADMIN_USER_TOKENS"
KEY_INDEX_TOKENS = "ADMIN_INDEX_TOKENS"

VALID_SCOPES = ("read", "upload")


def register_keyfs_keys(keyfs):
    """Idempotently register our typed keyfs keys.

    Called once at plugin init (devpiserver_pyramid_configure).
    """
    if keyfs.get_key(KEY_TOKEN) is None:
        keyfs.add_key(KEY_TOKEN, "+admin/tokens/{token_id}", dict)
    if keyfs.get_key(KEY_USER_TOKENS) is None:
        keyfs.add_key(KEY_USER_TOKENS, "+admin/user-tokens/{user}", set)
    if keyfs.get_key(KEY_INDEX_TOKENS) is None:
        keyfs.add_key(
            KEY_INDEX_TOKENS, "+admin/index-tokens/{user}/{index}", set)


def looks_like_token(s):
    return bool(_TOKEN_RE.match(s or ""))


def looks_like_token_id(s):
    return bool(_TOKEN_ID_RE.match(s or ""))


def _split(token):
    """Return ``(token_id, secret)`` or ``None`` if format is invalid."""
    m = _TOKEN_RE.match(token or "")
    if m is None:
        return None
    return m.group(1), m.group(2)


def _hash_secret(secret):
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _generate():
    """Return a new (token_string, token_id, secret_hash) triple."""
    token_id = secrets.token_urlsafe(16)
    secret = secrets.token_urlsafe(32)
    token = f"{TOKEN_PREFIX}{token_id}.{secret}"
    return token, token_id, _hash_secret(secret)


def _split_index(target_index):
    """Split ``user/index`` into a (user, index) pair, raising on bad input."""
    if not isinstance(target_index, str) or "/" not in target_index:
        raise ValueError(
            f"target_index must be 'user/index': {target_index!r}")
    idx_user, idx_name = target_index.split("/", 1)
    if not idx_user or not idx_name or "/" in idx_name:
        raise ValueError(
            f"target_index must be 'user/index': {target_index!r}")
    return idx_user, idx_name


def issue(
        xom, *, target_user, target_index, scope, issuer,
        ttl_seconds, label="", client_ip=""):
    """Create and persist a new token bound to a specific index and scope.

    Returns ``(token_string, metadata_dict)``. Caller is responsible for
    permission checks (see ``_check_can_issue`` / ``_check_index_perm``
    in the view layer).

    The plaintext secret is returned to the caller and never re-readable;
    keyfs only stores the SHA-256 hash. The token id is recorded in three
    indexes (token meta, per-user set, per-index set) so cleanup can find
    it from either direction.
    """
    if scope not in VALID_SCOPES:
        raise ValueError(f"invalid scope: {scope!r}")
    idx_user, idx_name = _split_index(target_index)

    now = int(time.time())
    token, token_id, secret_hash = _generate()
    meta = {
        "user": target_user,
        "index": target_index,
        "scope": scope,
        "issuer": issuer,
        "issued_at": now,
        "expires_at": now + int(ttl_seconds),
        "label": label or "",
        "client_ip": client_ip or "",
        "secret_hash": secret_hash,
    }
    keyfs = xom.keyfs
    with keyfs.write_transaction(allow_restart=True):
        keyfs.get_key(KEY_TOKEN)(token_id=token_id).set(meta)
        user_key = keyfs.get_key(KEY_USER_TOKENS)(user=target_user)
        ids = set(user_key.get()) if user_key.exists() else set()
        ids.add(token_id)
        user_key.set(ids)
        index_key = keyfs.get_key(KEY_INDEX_TOKENS)(
            user=idx_user, index=idx_name)
        ids = set(index_key.get()) if index_key.exists() else set()
        ids.add(token_id)
        index_key.set(ids)
    log.info(
        "admin token issued: user=%s index=%s scope=%s issuer=%s ttl=%ds "
        "label=%r ip=%s id=%s",
        target_user, target_index, scope, issuer, ttl_seconds,
        label, client_ip, token_id[:8])
    return token, meta


def lookup(xom, token):
    """Verify a token. Return its metadata dict if valid, else None.

    Validates: format, presence in keyfs, secret hash (constant-time),
    expiry, target user existence, presence of ``index`` and ``scope``
    fields (legacy tokens without these are rejected). All failure paths
    are logged so an operator can spot misuse.
    """
    parts = _split(token)
    if parts is None:
        return None
    token_id, secret = parts
    keyfs = xom.keyfs
    try:
        with keyfs.read_transaction(allow_reuse=True):
            key = keyfs.get_key(KEY_TOKEN)(token_id=token_id)
            if not key.exists():
                log.warning(
                    "admin token lookup: unknown id=%s", token_id[:8])
                return None
            meta = dict(key.get())
    except Exception:
        log.warning("admin token lookup failed", exc_info=True)
        return None
    expected_hash = meta.get("secret_hash") or ""
    actual_hash = _hash_secret(secret)
    if not hmac.compare_digest(expected_hash, actual_hash):
        # Real authentication failure: the id matched a token but the
        # secret did not. Worth logging at WARNING for bruteforce visibility.
        log.warning(
            "admin token lookup: secret mismatch for id=%s user=%s",
            token_id[:8], meta.get("user"))
        return None
    if meta.get("expires_at", 0) < time.time():
        log.info(
            "admin token lookup: expired id=%s user=%s",
            token_id[:8], meta.get("user"))
        return None
    if xom.model.get_user(meta.get("user", "")) is None:
        log.warning(
            "admin token lookup: user %r no longer exists, id=%s",
            meta.get("user"), token_id[:8])
        return None
    # Reject legacy tokens that pre-date the index/scope fields. They cannot
    # be safely scoped, so they must not authenticate. The startup cleanup
    # will eventually wipe them; this check just prevents leakage in the
    # meantime.
    if not meta.get("index") or meta.get("scope") not in VALID_SCOPES:
        log.warning(
            "admin token lookup: legacy token without index/scope, id=%s "
            "user=%s — denying",
            token_id[:8], meta.get("user"))
        return None
    return meta


def _remove_from_user_set(keyfs, user, token_id):
    if not user:
        return
    user_key = keyfs.get_key(KEY_USER_TOKENS)(user=user)
    if not user_key.exists():
        return
    ids = set(user_key.get())
    ids.discard(token_id)
    if ids:
        user_key.set(ids)
    else:
        user_key.delete()


def _remove_from_index_set(keyfs, target_index, token_id):
    if not target_index or "/" not in target_index:
        return
    idx_user, idx_name = target_index.split("/", 1)
    index_key = keyfs.get_key(KEY_INDEX_TOKENS)(
        user=idx_user, index=idx_name)
    if not index_key.exists():
        return
    ids = set(index_key.get())
    ids.discard(token_id)
    if ids:
        index_key.set(ids)
    else:
        index_key.delete()


def revoke(xom, token_id):
    """Revoke a single token by id. Returns True if existed."""
    keyfs = xom.keyfs
    with keyfs.write_transaction(allow_restart=True):
        meta_key = keyfs.get_key(KEY_TOKEN)(token_id=token_id)
        if not meta_key.exists():
            return False
        meta = dict(meta_key.get())
        meta_key.delete()
        _remove_from_user_set(keyfs, meta.get("user", ""), token_id)
        _remove_from_index_set(keyfs, meta.get("index", ""), token_id)
        log.info(
            "admin token revoked: id=%s user=%s index=%s",
            token_id[:8], meta.get("user"), meta.get("index"))
        return True


def list_for_user(xom, user, *, include_expired=False):
    """Return list of (token_id, metadata) for a user, sorted by expiry asc.

    Lazily prunes records of tokens whose target user no longer exists or
    whose entry is missing — orphan cleanup happens during read.
    Metadata returned to the caller does NOT contain ``secret_hash`` —
    the view layer only needs identity/expiry info.

    Legacy tokens (no ``index`` or no valid ``scope``) are filtered out so
    they never appear in UI listings even before the startup cleanup runs.
    """
    keyfs = xom.keyfs
    user_key_pattern = keyfs.get_key(KEY_USER_TOKENS)
    if user_key_pattern is None:
        return []
    now = time.time()
    out = []
    orphan_ids = []
    with keyfs.read_transaction(allow_reuse=True):
        user_key = user_key_pattern(user=user)
        if not user_key.exists():
            return []
        ids = list(user_key.get())
        for tid in ids:
            meta_key = keyfs.get_key(KEY_TOKEN)(token_id=tid)
            if not meta_key.exists():
                orphan_ids.append(tid)
                continue
            meta = dict(meta_key.get())
            meta.pop("secret_hash", None)
            if not include_expired and meta.get("expires_at", 0) < now:
                continue
            if not meta.get("index") or meta.get("scope") not in VALID_SCOPES:
                continue
            out.append((tid, meta))
    if orphan_ids and getattr(xom.config, "role", "primary") != "replica":
        # cleanup outside the read transaction; skip on replicas (keyfs
        # is read-only there — the next list on the primary will prune)
        try:
            with keyfs.write_transaction(allow_restart=True):
                user_key = user_key_pattern(user=user)
                if user_key.exists():
                    cleaned = set(user_key.get()) - set(orphan_ids)
                    if cleaned:
                        user_key.set(cleaned)
                    else:
                        user_key.delete()
        except Exception:
            log.warning("orphan cleanup failed for user %s", user, exc_info=True)
    out.sort(key=lambda kv: kv[1].get("expires_at", 0))
    return out


def list_for_index(xom, idx_user, idx_name, *, include_expired=False):
    """Return list of (token_id, metadata) for tokens bound to an index.

    Same shape and filtering as ``list_for_user``. Used by the per-index
    token listing endpoint and the pre-delete UX check on the frontend.
    """
    keyfs = xom.keyfs
    index_key_pattern = keyfs.get_key(KEY_INDEX_TOKENS)
    if index_key_pattern is None:
        return []
    now = time.time()
    out = []
    orphan_ids = []
    with keyfs.read_transaction(allow_reuse=True):
        index_key = index_key_pattern(user=idx_user, index=idx_name)
        if not index_key.exists():
            return []
        ids = list(index_key.get())
        for tid in ids:
            meta_key = keyfs.get_key(KEY_TOKEN)(token_id=tid)
            if not meta_key.exists():
                orphan_ids.append(tid)
                continue
            meta = dict(meta_key.get())
            meta.pop("secret_hash", None)
            if not include_expired and meta.get("expires_at", 0) < now:
                continue
            if not meta.get("index") or meta.get("scope") not in VALID_SCOPES:
                continue
            out.append((tid, meta))
    if orphan_ids and getattr(xom.config, "role", "primary") != "replica":
        try:
            with keyfs.write_transaction(allow_restart=True):
                index_key = index_key_pattern(user=idx_user, index=idx_name)
                if index_key.exists():
                    cleaned = set(index_key.get()) - set(orphan_ids)
                    if cleaned:
                        index_key.set(cleaned)
                    else:
                        index_key.delete()
        except Exception:
            log.warning(
                "orphan cleanup failed for index %s/%s",
                idx_user, idx_name, exc_info=True)
    out.sort(key=lambda kv: kv[1].get("expires_at", 0))
    return out


def cleanup_legacy_tokens(xom):
    """One-shot migration: wipe admin token records that cannot authenticate.

    Legacy criteria (any one is enough):
    * No ``secret_hash`` field — pre-hash storage; the plaintext was the
      lookup key and is unrecoverable.
    * No ``index`` or no valid ``scope`` — pre-bound storage; cannot be
      safely scoped to an index after the fact.

    These records can no longer authenticate (lookup() rejects them), they
    just sit in keyfs as zombies. Called once at primary startup; idempotent.
    """
    keyfs = xom.keyfs
    user_pattern = keyfs.get_key(KEY_USER_TOKENS)
    token_pattern = keyfs.get_key(KEY_TOKEN)
    if user_pattern is None or token_pattern is None:
        return 0
    wiped = 0
    try:
        # get_userlist() reads xom.keyfs.tx, which is only attached inside
        # a transaction. At plugin-configure time we are not in one yet.
        with keyfs.read_transaction(allow_reuse=True):
            users = [u.name for u in xom.model.get_userlist()]
    except Exception:
        log.warning("cleanup_legacy_tokens: cannot list users", exc_info=True)
        return 0
    for username in users:
        try:
            with keyfs.read_transaction(allow_reuse=True):
                user_key = user_pattern(user=username)
                if not user_key.exists():
                    continue
                ids = list(user_key.get())
                stale = []
                for tid in ids:
                    meta_key = token_pattern(token_id=tid)
                    if not meta_key.exists():
                        stale.append(tid)
                        continue
                    meta = dict(meta_key.get())
                    if not meta.get("secret_hash"):
                        stale.append(tid)
                        continue
                    if (not meta.get("index")
                            or meta.get("scope") not in VALID_SCOPES):
                        stale.append(tid)
            if not stale:
                continue
            with keyfs.write_transaction(allow_restart=True):
                for tid in stale:
                    meta_key = token_pattern(token_id=tid)
                    if meta_key.exists():
                        meta = dict(meta_key.get())
                        meta_key.delete()
                        # also drop from index set if the legacy record had
                        # one; new records always do, old ones never did
                        _remove_from_index_set(
                            keyfs, meta.get("index", ""), tid)
                user_key = user_pattern(user=username)
                if user_key.exists():
                    cleaned = set(user_key.get()) - set(stale)
                    if cleaned:
                        user_key.set(cleaned)
                    else:
                        user_key.delete()
            wiped += len(stale)
            log.info(
                "cleanup_legacy_tokens: wiped %d legacy token(s) for user=%s",
                len(stale), username)
        except Exception:
            log.warning(
                "cleanup_legacy_tokens: failure for user=%s",
                username, exc_info=True)
    if wiped:
        log.info("cleanup_legacy_tokens: wiped %d legacy token(s) total", wiped)
    return wiped


# Backwards-compatible alias — older docs / scripts may import this name.
cleanup_pre_hash_tokens = cleanup_legacy_tokens


def reset_for_user(xom, user):
    """Delete all tokens belonging to a user. Returns count deleted.

    Also removes each token from its bound index set so the index-tokens
    bookkeeping stays consistent.
    """
    keyfs = xom.keyfs
    user_key_pattern = keyfs.get_key(KEY_USER_TOKENS)
    if user_key_pattern is None:
        return 0
    with keyfs.write_transaction(allow_restart=True):
        user_key = user_key_pattern(user=user)
        if not user_key.exists():
            return 0
        ids = list(user_key.get())
        for tid in ids:
            meta_key = keyfs.get_key(KEY_TOKEN)(token_id=tid)
            if meta_key.exists():
                meta = dict(meta_key.get())
                meta_key.delete()
                _remove_from_index_set(keyfs, meta.get("index", ""), tid)
        user_key.delete()
    log.info("admin tokens reset for user=%s count=%d", user, len(ids))
    return len(ids)


def reset_for_index(xom, idx_user, idx_name):
    """Delete all tokens bound to ``idx_user/idx_name``. Returns count.

    Symmetrical to ``reset_for_user``: walks the index-tokens set and
    cleans each token from the per-user set as well.
    """
    keyfs = xom.keyfs
    index_key_pattern = keyfs.get_key(KEY_INDEX_TOKENS)
    if index_key_pattern is None:
        return 0
    with keyfs.write_transaction(allow_restart=True):
        index_key = index_key_pattern(user=idx_user, index=idx_name)
        if not index_key.exists():
            return 0
        ids = list(index_key.get())
        for tid in ids:
            meta_key = keyfs.get_key(KEY_TOKEN)(token_id=tid)
            if meta_key.exists():
                meta = dict(meta_key.get())
                meta_key.delete()
                _remove_from_user_set(keyfs, meta.get("user", ""), tid)
        index_key.delete()
    log.info(
        "admin tokens reset for index=%s/%s count=%d",
        idx_user, idx_name, len(ids))
    return len(ids)
