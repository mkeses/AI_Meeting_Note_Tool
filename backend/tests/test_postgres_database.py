import pytest

from postgres_database import PostgresMeetingRepository
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
