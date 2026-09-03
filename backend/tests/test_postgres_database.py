from types import SimpleNamespace

import pytest

import postgres_database
from postgres_database import (
    POSTGRES_CONNECT_TIMEOUT_SECONDS,
    PostgresMeetingRepository,
)
from storage import MeetingStorageError


def test_postgres_search_query_uses_safe_prefix_terms() -> None:
    assert PostgresMeetingRepository._to_tsquery("Architecture review") == (
        "'Architecture':* & 'review':*"
    )
    assert PostgresMeetingRepository._to_tsquery('***" OR') == "'OR':*"
    assert PostgresMeetingRepository._to_tsquery("   ") == ""


def test_postgres_startup_errors_do_not_retain_connection_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = "postgresql://user:private-password@database.example/meetings"
    repository = PostgresMeetingRepository(database_url)

    def fail_to_connect():
        raise RuntimeError(f"Could not connect to {database_url}")

    monkeypatch.setattr(repository, "_connect", fail_to_connect)

    with pytest.raises(MeetingStorageError) as error:
        repository.initialize()

    assert str(error.value) == "Unable to initialize meeting storage"
    assert database_url not in str(error.value)
    assert error.value.__cause__ is None


def test_postgres_connections_use_an_explicit_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, object, int]] = []
    row_factory = object()
    monkeypatch.setattr(
        postgres_database,
        "psycopg",
        SimpleNamespace(
            connect=lambda url, *, row_factory, connect_timeout: calls.append(
                (url, row_factory, connect_timeout)
            )
        ),
    )
    monkeypatch.setattr(postgres_database, "dict_row", row_factory)

    PostgresMeetingRepository("postgresql://database/meetings")._connect()

    assert calls == [
        (
            "postgresql://database/meetings",
            row_factory,
            POSTGRES_CONNECT_TIMEOUT_SECONDS,
        )
    ]
