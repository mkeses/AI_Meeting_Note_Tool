"""SQLite persistence for saved meeting sessions.

The repository owns SQLite-specific details so FastAPI handlers can remain
thin and a future database implementation can preserve the same CRUD boundary.
"""

from __future__ import annotations

import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

DEFAULT_DATABASE_PATH = Path("data") / "meetings.db"


class MeetingStorageError(RuntimeError):
    """Raised when SQLite storage cannot complete an operation."""


class MeetingConflictError(MeetingStorageError):
    """Raised when a unique meeting identity already exists."""


@dataclass(frozen=True, slots=True)
class Meeting:
    """Database representation of one saved meeting."""

    id: str
    source_key: str
    filename: str
    created_at: str
    updated_at: str
    meeting_type: str
    raw_text: str
    cleaned_text: str
    source_type: str
    notes: str


class MeetingRepository:
    """A small, connection-per-operation SQLite repository."""

    def __init__(self, database_path: str | Path):
        self.database_path = Path(database_path)

    @classmethod
    def from_environment(cls) -> MeetingRepository:
        return cls(os.getenv("DATABASE_PATH", DEFAULT_DATABASE_PATH))

    def initialize(self) -> None:
        """Create the current schema when the database is first used."""
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
                        notes TEXT NOT NULL DEFAULT ''
                    )
                    """
                )
                connection.execute(
                    """
                    CREATE INDEX IF NOT EXISTS meetings_created_at_idx
                    ON meetings (created_at DESC)
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

    def create(self, meeting: Meeting) -> Meeting:
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO meetings (
                        id, source_key, filename, created_at, updated_at,
                        meeting_type, raw_text, cleaned_text, source_type, notes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    ),
                )
        except sqlite3.IntegrityError as error:
            raise MeetingConflictError(
                "Meeting ID or source key already exists"
            ) from error
        except sqlite3.Error as error:
            raise MeetingStorageError("Unable to create meeting") from error

        created = self.get(meeting.id)
        if created is None:
            raise MeetingStorageError("Created meeting could not be retrieved")
        return created

    def list(self) -> list[Meeting]:
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    "SELECT * FROM meetings ORDER BY created_at DESC, id DESC"
                ).fetchall()
        except sqlite3.Error as error:
            raise MeetingStorageError("Unable to list meetings") from error

        return [self._row_to_meeting(row) for row in rows]

    def get(self, meeting_id: str) -> Meeting | None:
        try:
            with self._connect() as connection:
                row = connection.execute(
                    "SELECT * FROM meetings WHERE id = ?", (meeting_id,)
                ).fetchone()
        except sqlite3.Error as error:
            raise MeetingStorageError("Unable to retrieve meeting") from error

        return self._row_to_meeting(row) if row else None

    def search(self, query: str) -> list[Meeting]:
        """Return meetings that match title, cleaned transcript, or notes."""
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
                    WHERE meetings_fts MATCH ?
                    ORDER BY bm25(meetings_fts), meetings.created_at DESC, meetings.id DESC
                    """,
                    (fts_query,),
                ).fetchall()
        except sqlite3.Error as error:
            raise MeetingStorageError("Unable to search meetings") from error

        return [self._row_to_meeting(row) for row in rows]

    def update(self, meeting_id: str, changes: dict[str, str]) -> Meeting | None:
        if not changes:
            return self.get(meeting_id)

        allowed_columns = {
            "source_key",
            "filename",
            "meeting_type",
            "raw_text",
            "cleaned_text",
            "source_type",
            "notes",
        }
        invalid_columns = set(changes) - allowed_columns
        if invalid_columns:
            raise MeetingStorageError("Unsupported meeting update fields")

        assignments = [f"{column} = ?" for column in changes]
        values = [changes[column] for column in changes]
        assignments.append("updated_at = ?")
        values.append(datetime.now(UTC).isoformat())
        values.append(meeting_id)

        try:
            with self._connect() as connection:
                cursor = connection.execute(
                    f"UPDATE meetings SET {', '.join(assignments)} WHERE id = ?",
                    values,
                )
        except sqlite3.IntegrityError as error:
            raise MeetingConflictError(
                "Meeting ID or source key already exists"
            ) from error
        except sqlite3.Error as error:
            raise MeetingStorageError("Unable to update meeting") from error

        if cursor.rowcount == 0:
            return None
        return self.get(meeting_id)

    def delete(self, meeting_id: str) -> bool:
        try:
            with self._connect() as connection:
                cursor = connection.execute(
                    "DELETE FROM meetings WHERE id = ?", (meeting_id,)
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
        """Build a safe, prefix-capable FTS query from user-entered text."""
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
