"""Backend-neutral meeting persistence contract."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import TYPE_CHECKING, Protocol, cast

from meeting_entity import Meeting
from user_entity import User

LOCAL_OWNER_ID = "local"

if TYPE_CHECKING:
    from settings import Settings


class MeetingStorageError(RuntimeError):
    """Raised when meeting storage cannot complete an operation."""


class MeetingConflictError(MeetingStorageError):
    """Raised when a unique meeting identity already exists."""


class AuthenticationStorageError(RuntimeError):
    """Raised when authentication storage cannot complete an operation."""


class UserConflictError(AuthenticationStorageError):
    """Raised when a login identifier already exists."""


class MeetingStore(Protocol):
    """CRUD/search boundary implemented by desktop and future remote stores."""

    def initialize(self) -> None: ...

    def create(self, meeting: Meeting) -> Meeting: ...

    def list(self) -> list[Meeting]: ...

    def get(self, meeting_id: str) -> Meeting | None: ...

    def search(self, query: str) -> list[Meeting]: ...

    def update(self, meeting_id: str, changes: Mapping[str, str]) -> Meeting | None: ...

    def delete(self, meeting_id: str) -> bool: ...

    def for_owner(self, owner_id: str) -> MeetingStore: ...


class AuthenticationStore(Protocol):
    def create_user(self, login: str, password_hash: str) -> User: ...

    def get_user_by_login(self, login: str) -> tuple[User, str] | None: ...

    def get_user_by_session(
        self, session_token_hash: str, now: datetime
    ) -> User | None: ...

    def create_session(
        self, user_id: str, session_token_hash: str, expires_at: datetime
    ) -> None: ...

    def delete_session(self, session_token_hash: str) -> None: ...


def create_meeting_store(settings: Settings) -> MeetingStore:
    """Build the configured persistence implementation at the application edge."""
    if settings.storage_backend == "sqlite":
        from database import MeetingRepository

        return MeetingRepository(settings.database_path)

    if settings.storage_backend == "postgresql":
        from postgres_database import PostgresMeetingRepository

        return PostgresMeetingRepository(settings.postgres_database_url)

    raise MeetingStorageError(
        f"Unsupported meeting storage backend: {settings.storage_backend}"
    )


def create_authentication_store(
    settings: Settings, meeting_store: MeetingStore
) -> AuthenticationStore | None:
    """Return remote authentication storage only when authentication is enabled."""
    if not settings.auth_enabled:
        return None

    return cast(AuthenticationStore, meeting_store)
