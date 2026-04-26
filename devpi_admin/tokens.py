"""Stateful opaque tokens for devpi-admin.

Tokens are random unguessable strings (``adm_<base64url>``) stored in keyfs
with their metadata. They carry only identity (a username); authorization
is delegated to devpi's own ACL system. The tween additionally blocks
user-management endpoints when the request is authenticated via such a
token, so a leaked token cannot be escalated into a password change or
``/+login`` exchange for a full devpi session token.
"""
import logging
import re
import secrets
import time


log = logging.getLogger(__name__)

TOKEN_PREFIX = "adm_"
_TOKEN_RE = re.compile(r"^adm_[A-Za-z0-9_-]{32,}$")
DEFAULT_TTL = 3600                 # 1 hour
DEFAULT_MAX_TTL = 31_536_000       # 1 year
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


def _split(token):
    """Return token_id (random part after the prefix), or None."""
    if not looks_like_token(token):
        return None
    return token[len(TOKEN_PREFIX):]


def _generate():
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def issue(xom, *, target_user, issuer, ttl_seconds, label="", client_ip=""):
    """Create and persist a new token.

    Returns ``(token_string, metadata_dict)``. Caller is responsible for
    permission checks (issuer must be the target user, or root).
    """
    now = int(time.time())
    token = _generate()
    token_id = token[len(TOKEN_PREFIX):]
    meta = {
        "user": target_user,
        "issuer": issuer,
        "issued_at": now,
        "expires_at": now + int(ttl_seconds),
        "label": label or "",
        "client_ip": client_ip or "",
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

    Validates: format, presence in keyfs, expiry, target user existence.
    """
    token_id = _split(token)
    if token_id is None:
        return None
    keyfs = xom.keyfs
    try:
        with keyfs.read_transaction(allow_reuse=True):
            key = keyfs.get_key(KEY_TOKEN)(token_id=token_id)
            if not key.exists():
                return None
            meta = dict(key.get())
    except Exception:
        log.warning("admin token lookup failed", exc_info=True)
        return None
    if meta.get("expires_at", 0) < time.time():
        return None
    if xom.model.get_user(meta.get("user", "")) is None:
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
            if not include_expired and meta.get("expires_at", 0) < now:
                continue
            out.append((tid, meta))
    if orphan_ids:
        # cleanup outside the read transaction
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
