"""Backend-neutral meeting persistence contract."""

from collections.abc import Mapping
from typing import Protocol

from meeting_entity import Meeting


class MeetingStore(Protocol):
    """CRUD/search boundary implemented by desktop and future remote stores."""

    def initialize(self) -> None: ...

    def create(self, meeting: Meeting) -> Meeting: ...

    def list(self) -> list[Meeting]: ...

    def get(self, meeting_id: str) -> Meeting | None: ...

    def search(self, query: str) -> list[Meeting]: ...

    def update(
        self, meeting_id: str, changes: Mapping[str, str]
    ) -> Meeting | None: ...

    def delete(self, meeting_id: str) -> bool: ...
