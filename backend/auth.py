"""Password and opaque-session helpers for the optional remote auth mode."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
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


def create_csrf_token(secret: str) -> str:
    """Create a signed, browser-readable token for unsafe REST requests."""
    issued_at = str(int(time.time()))
    nonce = secrets.token_urlsafe(32)
    payload = f"{issued_at}.{nonce}"
    signature = hmac.new(
        secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"{payload}.{signature}"


def verify_csrf_token(token: str, secret: str, lifetime_seconds: int) -> bool:
    """Validate a bounded signed CSRF token without storing it server-side."""
    if len(token) > 512:
        return False

    try:
        issued_at, nonce, signature = token.split(".")
        issued_at_seconds = int(issued_at)
    except (TypeError, ValueError):
        return False

    if not nonce or issued_at_seconds > time.time() + 60:
        return False
    if time.time() - issued_at_seconds > lifetime_seconds:
        return False

    payload = f"{issued_at}.{nonce}"
    expected_signature = hmac.new(
        secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected_signature)


def session_expiration(now: datetime, lifetime_seconds: int) -> datetime:
    return now + timedelta(seconds=lifetime_seconds)


def utc_now() -> datetime:
    return datetime.now(UTC)
