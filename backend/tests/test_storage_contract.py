from pathlib import Path

import pytest

from database import LOCAL_OWNER_ID, MeetingRepository
from storage import MeetingStorageError
from tests.meeting_store_contract import assert_meeting_store_contract


def test_sqlite_repository_implements_the_meeting_store_contract(
    tmp_path: Path,
) -> None:
    assert_meeting_store_contract(MeetingRepository(tmp_path / "meetings.db"))


def test_sqlite_preserves_the_local_owner_scope(tmp_path: Path) -> None:
    repository = MeetingRepository(tmp_path / "meetings.db")
    repository.initialize()

    assert repository.for_owner(LOCAL_OWNER_ID).list() == []
    with pytest.raises(MeetingStorageError, match="local ownership only"):
        repository.for_owner("remote-user")
