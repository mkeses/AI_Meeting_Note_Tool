"""PostgreSQL persistence for remote, user-owned meeting sessions."""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from meeting_entity import Meeting
from storage import (
    AuthenticationStorageError,
    MeetingConflictError,
    MeetingStorageError,
    MeetingStore,
    UserConflictError,
)
from user_entity import User

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - deployment without PostgreSQL support
    psycopg = None
    dict_row = None


POSTGRES_CONNECT_TIMEOUT_SECONDS = 10


class PostgresMeetingRepository:
    """Connection-per-operation PostgreSQL storage with auth and owner scopes."""

    def __init__(self, database_url: str | None):
        if not database_url:
            raise ValueError("PostgreSQL meeting storage requires a database URL")
        self.database_url = database_url

    def initialize(self) -> None:
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS users (
                        id TEXT PRIMARY KEY,
                        login TEXT NOT NULL UNIQUE CHECK (length(btrim(login)) > 0),
                        password_hash TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS sessions (
                        token_hash TEXT PRIMARY KEY,
                        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        expires_at TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    )
                    """
                )
                cursor.execute(
                    """
                    CREATE INDEX IF NOT EXISTS sessions_user_id_idx
                    ON sessions (user_id)
                    """
                )
                cursor.execute(
                    """
                    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
                    ON sessions (expires_at)
                    """
                )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS meetings (
                        id TEXT PRIMARY KEY CHECK (length(btrim(id)) > 0),
                        owner_id TEXT NOT NULL
                            REFERENCES users(id) ON DELETE RESTRICT,
                        source_key TEXT NOT NULL
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
                        notes TEXT NOT NULL DEFAULT '',
                        UNIQUE (owner_id, source_key)
                    )
                    """
                )
                cursor.execute(
                    "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS owner_id TEXT"
                )
                cursor.execute(
                    """
                    DO $$ BEGIN
                        IF NOT EXISTS (
                            SELECT 1 FROM pg_constraint
                            WHERE conname = 'meetings_owner_id_required'
                        ) THEN
                            ALTER TABLE meetings
                            ADD CONSTRAINT meetings_owner_id_required
                            CHECK (owner_id IS NOT NULL) NOT VALID;
                        END IF;
                        IF NOT EXISTS (
                            SELECT 1 FROM pg_constraint
                            WHERE conname = 'meetings_owner_id_fkey'
                        ) THEN
                            ALTER TABLE meetings
                            ADD CONSTRAINT meetings_owner_id_fkey
                            FOREIGN KEY (owner_id) REFERENCES users(id)
                            ON DELETE RESTRICT NOT VALID;
                        END IF;
                    END $$;
                    """
                )
                cursor.execute(
                    """
                    CREATE INDEX IF NOT EXISTS meetings_owner_created_at_idx
                    ON meetings (owner_id, created_at DESC, id DESC)
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
            raise self._meeting_storage_error(
                "Unable to initialize meeting storage", error
            ) from None

    def for_owner(self, owner_id: str) -> MeetingStore:
        return _OwnedPostgresMeetingStore(self, owner_id)

    # Root storage deliberately fails closed for CRUD. Callers must use an
    # owner-bound view, preventing accidental unscoped remote access.
    def create(self, meeting: Meeting) -> Meeting:
        raise MeetingStorageError("Meeting storage must be scoped to an owner")

    def list(self) -> list[Meeting]:
        raise MeetingStorageError("Meeting storage must be scoped to an owner")

    def get(self, meeting_id: str) -> Meeting | None:
        raise MeetingStorageError("Meeting storage must be scoped to an owner")

    def search(self, query: str) -> list[Meeting]:
        raise MeetingStorageError("Meeting storage must be scoped to an owner")

    def update(self, meeting_id: str, changes: Mapping[str, str]) -> Meeting | None:
        raise MeetingStorageError("Meeting storage must be scoped to an owner")

    def delete(self, meeting_id: str) -> bool:
        raise MeetingStorageError("Meeting storage must be scoped to an owner")

    def create_user(self, login: str, password_hash: str) -> User:
        user = User(
            id=uuid4().hex,
            login=login,
            created_at=datetime.now(UTC).isoformat(),
        )
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO users (id, login, password_hash, created_at)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (user.id, user.login, password_hash, user.created_at),
                )
        except Exception as error:
            if psycopg is not None and isinstance(error, psycopg.IntegrityError):
                raise UserConflictError("Login already exists") from error
            raise self._authentication_storage_error(
                "Unable to create user", error
            ) from error
        return user

    def get_user_by_login(self, login: str) -> tuple[User, str] | None:
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, login, password_hash, created_at
                    FROM users
                    WHERE login = %s
                    """,
                    (login,),
                )
                row = cursor.fetchone()
        except Exception as error:
            raise self._authentication_storage_error(
                "Unable to retrieve user", error
            ) from error
        if row is None:
            return None
        return self._row_to_user(row), row["password_hash"]

    def get_user_by_session(
        self, session_token_hash: str, now: datetime
    ) -> User | None:
        now_value = now.isoformat()
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM sessions WHERE token_hash = %s AND expires_at <= %s",
                    (session_token_hash, now_value),
                )
                cursor.execute(
                    """
                    SELECT users.id, users.login, users.created_at
                    FROM sessions
                    JOIN users ON users.id = sessions.user_id
                    WHERE sessions.token_hash = %s AND sessions.expires_at > %s
                    """,
                    (session_token_hash, now_value),
                )
                row = cursor.fetchone()
        except Exception as error:
            raise self._authentication_storage_error(
                "Unable to resolve authenticated user", error
            ) from error
        return self._row_to_user(row) if row else None

    def create_session(
        self, user_id: str, session_token_hash: str, expires_at: datetime
    ) -> None:
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (
                        session_token_hash,
                        user_id,
                        expires_at.isoformat(),
                        datetime.now(UTC).isoformat(),
                    ),
                )
        except Exception as error:
            raise self._authentication_storage_error(
                "Unable to create session", error
            ) from error

    def delete_session(self, session_token_hash: str) -> None:
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM sessions WHERE token_hash = %s", (session_token_hash,)
                )
        except Exception as error:
            raise self._authentication_storage_error(
                "Unable to delete session", error
            ) from error

    def _create_meeting(self, owner_id: str, meeting: Meeting) -> Meeting:
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO meetings (
                        id, owner_id, source_key, filename, created_at, updated_at,
                        meeting_type, raw_text, cleaned_text, source_type, notes
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        meeting.id,
                        owner_id,
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
            self._raise_meeting_write_error("Unable to create meeting", error)
        created = self._get_meeting(owner_id, meeting.id)
        if created is None:
            raise MeetingStorageError("Created meeting could not be retrieved")
        return created

    def _list_meetings(self, owner_id: str) -> list[Meeting]:
        return self._query_meetings(
            """
            SELECT * FROM meetings
            WHERE owner_id = %s
            ORDER BY created_at DESC, id DESC
            """,
            (owner_id,),
            "Unable to list meetings",
        )

    def _get_meeting(self, owner_id: str, meeting_id: str) -> Meeting | None:
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM meetings WHERE id = %s AND owner_id = %s",
                    (meeting_id, owner_id),
                )
                row = cursor.fetchone()
        except Exception as error:
            raise self._meeting_storage_error(
                "Unable to retrieve meeting", error
            ) from error
        return self._row_to_meeting(row) if row else None

    def _search_meetings(self, owner_id: str, query: str) -> list[Meeting]:
        tsquery = self._to_tsquery(query)
        if not tsquery:
            return []
        search_vector = (
            "to_tsvector('simple', filename || ' ' || cleaned_text || ' ' || notes)"
        )
        return self._query_meetings(
            f"""
            SELECT * FROM meetings
            WHERE owner_id = %s
              AND {search_vector} @@ to_tsquery('simple', %s)
            ORDER BY ts_rank({search_vector}, to_tsquery('simple', %s)) DESC,
                     created_at DESC,
                     id DESC
            """,
            (owner_id, tsquery, tsquery),
            "Unable to search meetings",
        )

    def _update_meeting(
        self, owner_id: str, meeting_id: str, changes: Mapping[str, str]
    ) -> Meeting | None:
        if not changes:
            return self._get_meeting(owner_id, meeting_id)
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
        assignments = [f"{column} = %s" for column in changes]
        values = [changes[column] for column in changes]
        assignments.append("updated_at = %s")
        values.extend([datetime.now(UTC).isoformat(), meeting_id, owner_id])
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    f"""
                    UPDATE meetings SET {', '.join(assignments)}
                    WHERE id = %s AND owner_id = %s
                    """,
                    values,
                )
                updated = cursor.rowcount > 0
        except Exception as error:
            self._raise_meeting_write_error("Unable to update meeting", error)
        return self._get_meeting(owner_id, meeting_id) if updated else None

    def _delete_meeting(self, owner_id: str, meeting_id: str) -> bool:
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM meetings WHERE id = %s AND owner_id = %s",
                    (meeting_id, owner_id),
                )
                return cursor.rowcount > 0
        except Exception as error:
            raise self._meeting_storage_error(
                "Unable to delete meeting", error
            ) from error

    def _query_meetings(
        self,
        query: str,
        parameters: tuple[str, ...],
        error_message: str,
    ) -> list[Meeting]:
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                cursor.execute(query, parameters)
                rows = cursor.fetchall()
        except Exception as error:
            raise self._meeting_storage_error(error_message, error) from error
        return [self._row_to_meeting(row) for row in rows]

    def _connect(self):
        if psycopg is None or dict_row is None:
            raise MeetingStorageError(
                "PostgreSQL meeting storage requires the optional 'postgres' dependency"
            )
        return psycopg.connect(
            self.database_url,
            row_factory=dict_row,
            connect_timeout=POSTGRES_CONNECT_TIMEOUT_SECONDS,
        )

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
    def _row_to_user(row: Mapping[str, Any]) -> User:
        return User(id=row["id"], login=row["login"], created_at=row["created_at"])

    @staticmethod
    def _meeting_storage_error(message: str, error: Exception) -> MeetingStorageError:
        if isinstance(error, MeetingStorageError):
            return error
        return MeetingStorageError(message)

    @staticmethod
    def _authentication_storage_error(
        message: str, error: Exception
    ) -> AuthenticationStorageError:
        if isinstance(error, AuthenticationStorageError):
            return error
        return AuthenticationStorageError(message)

    @staticmethod
    def _raise_meeting_write_error(message: str, error: Exception) -> None:
        if psycopg is not None and isinstance(error, psycopg.IntegrityError):
            raise MeetingConflictError(
                "Meeting ID or source key already exists"
            ) from error
        raise PostgresMeetingRepository._meeting_storage_error(
            message, error
        ) from error


class _OwnedPostgresMeetingStore:
    def __init__(self, repository: PostgresMeetingRepository, owner_id: str):
        self._repository = repository
        self._owner_id = owner_id

    def initialize(self) -> None:
        self._repository.initialize()

    def for_owner(self, owner_id: str) -> MeetingStore:
        return self._repository.for_owner(owner_id)

    def create(self, meeting: Meeting) -> Meeting:
        return self._repository._create_meeting(self._owner_id, meeting)

    def list(self) -> list[Meeting]:
        return self._repository._list_meetings(self._owner_id)

    def get(self, meeting_id: str) -> Meeting | None:
        return self._repository._get_meeting(self._owner_id, meeting_id)

    def search(self, query: str) -> list[Meeting]:
        return self._repository._search_meetings(self._owner_id, query)

    def update(self, meeting_id: str, changes: Mapping[str, str]) -> Meeting | None:
        return self._repository._update_meeting(self._owner_id, meeting_id, changes)

    def delete(self, meeting_id: str) -> bool:
        return self._repository._delete_meeting(self._owner_id, meeting_id)
