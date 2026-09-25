import sqlite3
from pathlib import Path

import pytest

from database import LOCAL_OWNER_ID, MeetingRepository
from meeting_entity import Meeting
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


def test_sqlite_upgrades_legacy_fts_index_without_losing_meetings(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "meetings.db"
    repository = MeetingRepository(database_path)
    repository.initialize()
    meeting = Meeting(
        id="legacy-meeting",
        source_key="text:legacy-meeting",
        filename="Legacy title",
        created_at="2026-09-01T12:00:00+00:00",
        updated_at="2026-09-01T12:00:00+00:00",
        meeting_type="general",
        raw_text="rawonlymigrationterm",
        cleaned_text="Existing cleaned text",
        source_type="text",
        notes="Existing meeting notes",
    )
    repository.create(meeting)

    with sqlite3.connect(database_path) as connection:
        connection.execute("DROP TRIGGER meetings_fts_after_insert")
        connection.execute("DROP TRIGGER meetings_fts_after_delete")
        connection.execute("DROP TRIGGER meetings_fts_after_update")
        connection.execute("DROP TABLE meetings_fts")
        connection.execute(
            """
            CREATE VIRTUAL TABLE meetings_fts
            USING fts5(
                filename,
                cleaned_text,
                notes,
                content='meetings',
                content_rowid='rowid'
            )
            """
        )
        connection.execute(
            """
            CREATE TRIGGER meetings_fts_after_insert
            AFTER INSERT ON meetings BEGIN
                INSERT INTO meetings_fts(rowid, filename, cleaned_text, notes)
                VALUES (new.rowid, new.filename, new.cleaned_text, new.notes);
            END
            """
        )
        connection.execute(
            """
            CREATE TRIGGER meetings_fts_after_delete
            AFTER DELETE ON meetings BEGIN
                INSERT INTO meetings_fts(
                    meetings_fts, rowid, filename, cleaned_text, notes
                ) VALUES (
                    'delete', old.rowid, old.filename,
                    old.cleaned_text, old.notes
                );
            END
            """
        )
        connection.execute(
            """
            CREATE TRIGGER meetings_fts_after_update
            AFTER UPDATE OF filename, cleaned_text, notes ON meetings BEGIN
                INSERT INTO meetings_fts(
                    meetings_fts, rowid, filename, cleaned_text, notes
                ) VALUES (
                    'delete', old.rowid, old.filename,
                    old.cleaned_text, old.notes
                );
                INSERT INTO meetings_fts(rowid, filename, cleaned_text, notes)
                VALUES (new.rowid, new.filename, new.cleaned_text, new.notes);
            END
            """
        )
        connection.execute("INSERT INTO meetings_fts(meetings_fts) VALUES ('rebuild')")

    repository.initialize()

    assert repository.get(meeting.id) == meeting
    assert repository.search("rawonlymigrationterm") == [meeting]
    assert repository.search("Existing") == [meeting]
