from pathlib import Path

from database import MeetingRepository
from tests.meeting_store_contract import assert_meeting_store_contract


def test_sqlite_repository_implements_the_meeting_store_contract(
    tmp_path: Path,
) -> None:
    assert_meeting_store_contract(MeetingRepository(tmp_path / "meetings.db"))
