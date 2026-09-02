"""PostgreSQL persistence for saved meeting sessions."""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from meeting_entity import Meeting
from storage import MeetingConflictError, MeetingStorageError

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - exercised by deployments without PostgreSQL
    psycopg = None
    dict_row = None


class PostgresMeetingRepository:
    """A small, connection-per-operation PostgreSQL MeetingStore."""

    def __init__(self, database_url: str | None):
        if not database_url:
            raise ValueError("PostgreSQL meeting storage requires a database URL")
        self.database_url = database_url

    def initialize(self) -> None:
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS meetings (
                        id TEXT PRIMARY KEY CHECK (length(btrim(id)) > 0),
                        source_key TEXT NOT NULL UNIQUE
                            CHECK (length(btrim(source_key)) > 0),
                        filename TEXT NOT NULL CHECK (length(btrim(filename)) > 0),
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
                cursor.execute(
                    """
                    CREATE INDEX IF NOT EXISTS meetings_created_at_idx
                    ON meetings (created_at DESC, id DESC)
                    """
                )
                cursor.execute(
                    """
                    CREATE INDEX IF NOT EXISTS meetings_search_idx
                    ON meetings
                    USING GIN (
                        to_tsvector(
                            'simple',
                            filename || ' ' || cleaned_text || ' ' || notes
                        )
                    )
                    """
                )
        except Exception as error:
            raise self._storage_error(
                "Unable to initialize meeting storage", error
            ) from error

    def create(self, meeting: Meeting) -> Meeting:
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO meetings (
                        id, source_key, filename, created_at, updated_at,
                        meeting_type, raw_text, cleaned_text, source_type, notes
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
        except Exception as error:
            self._raise_write_error("Unable to create meeting", error)

        created = self.get(meeting.id)
        if created is None:
            raise MeetingStorageError("Created meeting could not be retrieved")
        return created

    def list(self) -> list[Meeting]:
        return self._query_meetings(
            "SELECT * FROM meetings ORDER BY created_at DESC, id DESC"
        )

    def get(self, meeting_id: str) -> Meeting | None:
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute("SELECT * FROM meetings WHERE id = %s", (meeting_id,))
                row = cursor.fetchone()
        except Exception as error:
            raise self._storage_error("Unable to retrieve meeting", error) from error

        return self._row_to_meeting(row) if row else None

    def search(self, query: str) -> list[Meeting]:
        tsquery = self._to_tsquery(query)
        if not tsquery:
            return []

        search_vector = (
            "to_tsvector('simple', filename || ' ' || cleaned_text || ' ' || notes)"
        )
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    f"""
                    SELECT * FROM meetings
                    WHERE {search_vector} @@ to_tsquery('simple', %s)
                    ORDER BY ts_rank({search_vector}, to_tsquery('simple', %s)) DESC,
                             created_at DESC,
                             id DESC
                    """,
                    (tsquery, tsquery),
                )
                rows = cursor.fetchall()
        except Exception as error:
            raise self._storage_error("Unable to search meetings", error) from error

        return [self._row_to_meeting(row) for row in rows]

    def update(self, meeting_id: str, changes: Mapping[str, str]) -> Meeting | None:
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

        assignments = [f"{column} = %s" for column in changes]
        values = [changes[column] for column in changes]
        assignments.append("updated_at = %s")
        values.append(datetime.now(UTC).isoformat())
        values.append(meeting_id)

        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    f"UPDATE meetings SET {', '.join(assignments)} WHERE id = %s",
                    values,
                )
                updated = cursor.rowcount > 0
        except Exception as error:
            self._raise_write_error("Unable to update meeting", error)

        return self.get(meeting_id) if updated else None

    def delete(self, meeting_id: str) -> bool:
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute("DELETE FROM meetings WHERE id = %s", (meeting_id,))
                return cursor.rowcount > 0
        except Exception as error:
            raise self._storage_error("Unable to delete meeting", error) from error

    def _query_meetings(self, query: str) -> list[Meeting]:
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(query)
                rows = cursor.fetchall()
        except Exception as error:
            raise self._storage_error("Unable to list meetings", error) from error

        return [self._row_to_meeting(row) for row in rows]

    def _connect(self):
        if psycopg is None or dict_row is None:
            raise MeetingStorageError(
                "PostgreSQL meeting storage requires the optional 'postgres' dependency"
            )
        return psycopg.connect(self.database_url, row_factory=dict_row)

    @staticmethod
    def _to_tsquery(query: str) -> str:
        terms = re.findall(r"\w+", query, flags=re.UNICODE)
        return " & ".join(f"'{term}':*" for term in terms)

    @staticmethod
    def _row_to_meeting(row: Mapping[str, Any]) -> Meeting:
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

    @staticmethod
    def _storage_error(message: str, error: Exception) -> MeetingStorageError:
        if isinstance(error, MeetingStorageError):
            return error
        return MeetingStorageError(message)

    @staticmethod
    def _raise_write_error(message: str, error: Exception) -> None:
        if psycopg is not None and isinstance(error, psycopg.IntegrityError):
            raise MeetingConflictError(
                "Meeting ID or source key already exists"
            ) from error
        raise PostgresMeetingRepository._storage_error(message, error) from error
