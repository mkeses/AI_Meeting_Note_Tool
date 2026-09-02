"""SQLite persistence for local, single-user meeting sessions."""

from __future__ import annotations

import os
import re
import sqlite3
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path

from meeting_entity import Meeting
from storage import (
    LOCAL_OWNER_ID,
    MeetingConflictError,
    MeetingStorageError,
    MeetingStore,
)

DEFAULT_DATABASE_PATH = Path("data") / "meetings.db"


class MeetingRepository:
    """A small, connection-per-operation SQLite repository for desktop mode."""

    def __init__(self, database_path: str | Path):
        self.database_path = Path(database_path)

    @classmethod
    def from_environment(cls) -> MeetingRepository:
        return cls(os.getenv("DATABASE_PATH", DEFAULT_DATABASE_PATH))

    def initialize(self) -> None:
        """Create or compatibility-migrate the local schema without data loss."""
        if str(self.database_path) != ":memory:":
            self.database_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            with self._connect() as connection:
                connection.execute("PRAGMA journal_mode = WAL")
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS meetings (
                        id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
                        source_key TEXT NOT NULL UNIQUE
                            CHECK (length(trim(source_key)) > 0),
                        filename TEXT NOT NULL CHECK (length(trim(filename)) > 0),
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        meeting_type TEXT NOT NULL CHECK (
                            meeting_type IN (
                                'general',
                                'design_review',
                                'debug_sync',
                                'standup'
                            )
                        ),
                        raw_text TEXT NOT NULL,
                        cleaned_text TEXT NOT NULL,
                        source_type TEXT NOT NULL CHECK (
                            source_type IN ('recording', 'audio-file', 'text')
                        ),
                        notes TEXT NOT NULL DEFAULT '',
                        owner_id TEXT NOT NULL DEFAULT 'local'
                    )
                    """
                )
                columns = {
                    row["name"]
                    for row in connection.execute("PRAGMA table_info(meetings)")
                }
                if "owner_id" not in columns:
                    connection.execute(
                        "ALTER TABLE meetings "
                        "ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'local'"
                    )
                connection.execute(
                    """
                    CREATE INDEX IF NOT EXISTS meetings_created_at_idx
                    ON meetings (created_at DESC)
                    """
                )
                connection.execute(
                    """
                    CREATE INDEX IF NOT EXISTS meetings_owner_created_at_idx
                    ON meetings (owner_id, created_at DESC)
                    """
                )
                connection.execute(
                    """
                    CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts
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
                    CREATE TRIGGER IF NOT EXISTS meetings_fts_after_insert
                    AFTER INSERT ON meetings BEGIN
                        INSERT INTO meetings_fts(
                            rowid, filename, cleaned_text, notes
                        ) VALUES (
                            new.rowid, new.filename, new.cleaned_text, new.notes
                        );
                    END
                    """
                )
                connection.execute(
                    """
                    CREATE TRIGGER IF NOT EXISTS meetings_fts_after_delete
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
                    CREATE TRIGGER IF NOT EXISTS meetings_fts_after_update
                    AFTER UPDATE OF filename, cleaned_text, notes ON meetings BEGIN
                        INSERT INTO meetings_fts(
                            meetings_fts, rowid, filename, cleaned_text, notes
                        ) VALUES (
                            'delete', old.rowid, old.filename,
                            old.cleaned_text, old.notes
                        );
                        INSERT INTO meetings_fts(
                            rowid, filename, cleaned_text, notes
                        ) VALUES (
                            new.rowid, new.filename, new.cleaned_text, new.notes
                        );
                    END
                    """
                )
                connection.execute(
                    "INSERT INTO meetings_fts(meetings_fts) VALUES ('rebuild')"
                )
        except sqlite3.Error as error:
            raise MeetingStorageError("Unable to initialize meeting storage") from error

    def for_owner(self, owner_id: str) -> MeetingStore:
        if owner_id != LOCAL_OWNER_ID:
            raise MeetingStorageError(
                "SQLite meeting storage supports local ownership only"
            )
        return _OwnedSQLiteMeetingStore(self, owner_id)

    # Direct CRUD remains available for existing local repository callers. HTTP
    # routes always use for_owner(), so they follow the same scoped boundary.
    def create(self, meeting: Meeting) -> Meeting:
        return self._create(meeting, LOCAL_OWNER_ID)

    def list(self) -> list[Meeting]:
        return self._list(LOCAL_OWNER_ID)

    def get(self, meeting_id: str) -> Meeting | None:
        return self._get(meeting_id, LOCAL_OWNER_ID)

    def search(self, query: str) -> list[Meeting]:
        return self._search(query, LOCAL_OWNER_ID)

    def update(self, meeting_id: str, changes: Mapping[str, str]) -> Meeting | None:
        return self._update(meeting_id, changes, LOCAL_OWNER_ID)

    def delete(self, meeting_id: str) -> bool:
        return self._delete(meeting_id, LOCAL_OWNER_ID)

    def _create(self, meeting: Meeting, owner_id: str) -> Meeting:
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO meetings (
                        id, source_key, filename, created_at, updated_at,
                        meeting_type, raw_text, cleaned_text, source_type, notes,
                        owner_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        meeting.id,
                        meeting.source_key,
                        meeting.filename,
                        meeting.created_at,
                        meeting.updated_at,
                        meeting.meeting_type,
                        meeting.raw_text,
                        meeting.cleaned_text,
                        meeting.source_type,
                        meeting.notes,
                        owner_id,
                    ),
                )
        except sqlite3.IntegrityError as error:
            raise MeetingConflictError(
                "Meeting ID or source key already exists"
            ) from error
        except sqlite3.Error as error:
            raise MeetingStorageError("Unable to create meeting") from error
        created = self._get(meeting.id, owner_id)
        if created is None:
            raise MeetingStorageError("Created meeting could not be retrieved")
        return created

    def _list(self, owner_id: str) -> list[Meeting]:
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    """
                    SELECT * FROM meetings
                    WHERE owner_id = ?
                    ORDER BY created_at DESC, id DESC
                    """,
                    (owner_id,),
                ).fetchall()
        except sqlite3.Error as error:
            raise MeetingStorageError("Unable to list meetings") from error
        return [self._row_to_meeting(row) for row in rows]

    def _get(self, meeting_id: str, owner_id: str) -> Meeting | None:
        try:
            with self._connect() as connection:
                row = connection.execute(
                    "SELECT * FROM meetings WHERE id = ? AND owner_id = ?",
                    (meeting_id, owner_id),
                ).fetchone()
        except sqlite3.Error as error:
            raise MeetingStorageError("Unable to retrieve meeting") from error
        return self._row_to_meeting(row) if row else None

    def _search(self, query: str, owner_id: str) -> list[Meeting]:
        fts_query = self._to_fts_query(query)
        if not fts_query:
            return []
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    """
                    SELECT meetings.*
                    FROM meetings_fts
                    JOIN meetings ON meetings.rowid = meetings_fts.rowid
                    WHERE meetings_fts MATCH ? AND meetings.owner_id = ?
                    ORDER BY bm25(meetings_fts), meetings.created_at DESC, meetings.id DESC
                    """,
                    (fts_query, owner_id),
                ).fetchall()
        except sqlite3.Error as error:
            raise MeetingStorageError("Unable to search meetings") from error
        return [self._row_to_meeting(row) for row in rows]

    def _update(
        self, meeting_id: str, changes: Mapping[str, str], owner_id: str
    ) -> Meeting | None:
        if not changes:
            return self._get(meeting_id, owner_id)
        allowed_columns = {
            "source_key",
            "filename",
            "meeting_type",
            "raw_text",
            "cleaned_text",
            "source_type",
            "notes",
        }
        if set(changes) - allowed_columns:
            raise MeetingStorageError("Unsupported meeting update fields")
        assignments = [f"{column} = ?" for column in changes]
        values = [changes[column] for column in changes]
        assignments.append("updated_at = ?")
        values.extend([datetime.now(UTC).isoformat(), meeting_id, owner_id])
        try:
            with self._connect() as connection:
                cursor = connection.execute(
                    f"""
                    UPDATE meetings SET {', '.join(assignments)}
                    WHERE id = ? AND owner_id = ?
                    """,
                    values,
                )
        except sqlite3.IntegrityError as error:
            raise MeetingConflictError(
                "Meeting ID or source key already exists"
            ) from error
        except sqlite3.Error as error:
            raise MeetingStorageError("Unable to update meeting") from error
        return self._get(meeting_id, owner_id) if cursor.rowcount else None

    def _delete(self, meeting_id: str, owner_id: str) -> bool:
        try:
            with self._connect() as connection:
                cursor = connection.execute(
                    "DELETE FROM meetings WHERE id = ? AND owner_id = ?",
                    (meeting_id, owner_id),
                )
        except sqlite3.Error as error:
            raise MeetingStorageError("Unable to delete meeting") from error
        return cursor.rowcount > 0

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.database_path), timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    @staticmethod
    def _to_fts_query(query: str) -> str:
        terms = re.findall(r"\w+", query, flags=re.UNICODE)
        return " AND ".join(f'"{term}"*' for term in terms)

    @staticmethod
    def _row_to_meeting(row: sqlite3.Row) -> Meeting:
        return Meeting(
            id=row["id"],
            source_key=row["source_key"],
            filename=row["filename"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            meeting_type=row["meeting_type"],
            raw_text=row["raw_text"],
            cleaned_text=row["cleaned_text"],
            source_type=row["source_type"],
            notes=row["notes"],
        )


class _OwnedSQLiteMeetingStore:
    def __init__(self, repository: MeetingRepository, owner_id: str):
        self._repository = repository
        self._owner_id = owner_id

    def initialize(self) -> None:
        self._repository.initialize()

    def for_owner(self, owner_id: str) -> MeetingStore:
        return self._repository.for_owner(owner_id)

    def create(self, meeting: Meeting) -> Meeting:
        return self._repository._create(meeting, self._owner_id)

    def list(self) -> list[Meeting]:
        return self._repository._list(self._owner_id)

    def get(self, meeting_id: str) -> Meeting | None:
        return self._repository._get(meeting_id, self._owner_id)

    def search(self, query: str) -> list[Meeting]:
        return self._repository._search(query, self._owner_id)

    def update(self, meeting_id: str, changes: Mapping[str, str]) -> Meeting | None:
        return self._repository._update(meeting_id, changes, self._owner_id)

    def delete(self, meeting_id: str) -> bool:
        return self._repository._delete(meeting_id, self._owner_id)
