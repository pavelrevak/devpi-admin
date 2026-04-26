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

Authorization is delegated to devpi's own ACL system. The tween restricts
admin-token requests to read-only access on index/archive paths so a leaked
token cannot be escalated into password change, ``/+login`` exchange, package
upload, or further token issuance.
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


def register_keyfs_keys(keyfs):
    """Idempotently register our typed keyfs keys.

    Called once at plugin init (devpiserver_pyramid_configure).
    """
    if keyfs.get_key(KEY_TOKEN) is None:
        keyfs.add_key(KEY_TOKEN, "+admin/tokens/{token_id}", dict)
    if keyfs.get_key(KEY_USER_TOKENS) is None:
        keyfs.add_key(KEY_USER_TOKENS, "+admin/user-tokens/{user}", set)


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


def issue(xom, *, target_user, issuer, ttl_seconds, label="", client_ip=""):
    """Create and persist a new token.

    Returns ``(token_string, metadata_dict)``. Caller is responsible for
    permission checks (issuer must be the target user; root must be rejected
    upstream — see view layer).

    The plaintext secret is returned to the caller and never re-readable;
    keyfs only stores the SHA-256 hash.
    """
    now = int(time.time())
    token, token_id, secret_hash = _generate()
    meta = {
        "user": target_user,
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
    log.info(
        "admin token issued: user=%s issuer=%s ttl=%ds label=%r ip=%s id=%s",
        target_user, issuer, ttl_seconds, label, client_ip, token_id[:8])
    return token, meta


def lookup(xom, token):
    """Verify a token. Return its metadata dict if valid, else None.

    Validates: format, presence in keyfs, secret hash (constant-time),
    expiry, target user existence. All failure paths are logged so an
    operator can spot misuse (wrong secret = potential bruteforce).
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
    return meta


def revoke(xom, token_id):
    """Revoke a single token by id. Returns True if existed."""
    keyfs = xom.keyfs
    with keyfs.write_transaction(allow_restart=True):
        meta_key = keyfs.get_key(KEY_TOKEN)(token_id=token_id)
        if not meta_key.exists():
            return False
        meta = dict(meta_key.get())
        meta_key.delete()
        user = meta.get("user")
        if user:
            user_key = keyfs.get_key(KEY_USER_TOKENS)(user=user)
            if user_key.exists():
                ids = set(user_key.get())
                ids.discard(token_id)
                if ids:
                    user_key.set(ids)
                else:
                    user_key.delete()
        log.info("admin token revoked: id=%s user=%s", token_id[:8], user)
        return True


def list_for_user(xom, user, *, include_expired=False):
    """Return list of (token_id, metadata) for a user, sorted by expiry asc.

    Lazily prunes records of tokens whose target user no longer exists or
    whose entry is missing — orphan cleanup happens during read.
    Metadata returned to the caller does NOT contain ``secret_hash`` —
    the view layer only needs identity/expiry info.
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


def cleanup_pre_hash_tokens(xom):
    """One-shot migration: wipe admin token records issued before hash storage.

    Pre-hash tokens stored the plaintext secret as the lookup key and had
    no ``secret_hash`` field in metadata. After the hash-storage refactor
    they can no longer authenticate (token format requires ``adm_<id>.<secret>``)
    and just sit in keyfs as zombies — visible in the listing endpoint but
    unusable. Called once at primary startup; idempotent.
    """
    keyfs = xom.keyfs
    user_pattern = keyfs.get_key(KEY_USER_TOKENS)
    token_pattern = keyfs.get_key(KEY_TOKEN)
    if user_pattern is None or token_pattern is None:
        return 0
    wiped = 0
    try:
        users = [u.name for u in xom.model.get_userlist()]
    except Exception:
        log.warning("cleanup_pre_hash_tokens: cannot list users", exc_info=True)
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
            if not stale:
                continue
            with keyfs.write_transaction(allow_restart=True):
                for tid in stale:
                    meta_key = token_pattern(token_id=tid)
                    if meta_key.exists():
                        meta_key.delete()
                user_key = user_pattern(user=username)
                if user_key.exists():
                    cleaned = set(user_key.get()) - set(stale)
                    if cleaned:
                        user_key.set(cleaned)
                    else:
                        user_key.delete()
            wiped += len(stale)
            log.info(
                "cleanup_pre_hash_tokens: wiped %d legacy token(s) for user=%s",
                len(stale), username)
        except Exception:
            log.warning(
                "cleanup_pre_hash_tokens: failure for user=%s",
                username, exc_info=True)
    if wiped:
        log.info("cleanup_pre_hash_tokens: wiped %d legacy token(s) total", wiped)
    return wiped


def reset_for_user(xom, user):
    """Delete all tokens belonging to a user. Returns count deleted."""
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
                meta_key.delete()
        user_key.delete()
    log.info("admin tokens reset for user=%s count=%d", user, len(ids))
    return len(ids)
