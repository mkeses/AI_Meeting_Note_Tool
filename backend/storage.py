"""Backend-neutral meeting persistence contract."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Protocol

from meeting_entity import Meeting

if TYPE_CHECKING:
    from settings import Settings


class MeetingStorageError(RuntimeError):
    """Raised when meeting storage cannot complete an operation."""


class MeetingConflictError(MeetingStorageError):
    """Raised when a unique meeting identity already exists."""


class MeetingStore(Protocol):
    """CRUD/search boundary implemented by desktop and future remote stores."""

    def initialize(self) -> None: ...

    def create(self, meeting: Meeting) -> Meeting: ...

    def list(self) -> list[Meeting]: ...

    def get(self, meeting_id: str) -> Meeting | None: ...

    def search(self, query: str) -> list[Meeting]: ...

    def update(self, meeting_id: str, changes: Mapping[str, str]) -> Meeting | None: ...

    def delete(self, meeting_id: str) -> bool: ...


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
