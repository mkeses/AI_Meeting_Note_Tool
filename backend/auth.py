"""Password and opaque-session helpers for the optional remote auth mode."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta


def hash_password(password: str) -> str:
    """Hash a password with pwdlib's recommended Argon2 configuration."""
    from pwdlib import PasswordHash

    return PasswordHash.recommended().hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a password without exposing the hash or failure details."""
    from pwdlib import PasswordHash

    try:
        return PasswordHash.recommended().verify(password, password_hash)
    except Exception:
        return False


def create_session_token() -> str:
    """Create a high-entropy opaque token suitable for an HttpOnly cookie."""
    return secrets.token_urlsafe(32)


def hash_session_token(token: str, secret: str) -> str:
    """Store only an HMAC of an opaque session token."""
    return hmac.new(
        secret.encode("utf-8"), token.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def session_expiration(now: datetime, lifetime_seconds: int) -> datetime:
    return now + timedelta(seconds=lifetime_seconds)


def utc_now() -> datetime:
    return datetime.now(UTC)
