import pytest

from database import MeetingRepository
from postgres_database import PostgresMeetingRepository
from settings import Settings
from storage import create_meeting_store


def set_required_model_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WHISPER_MODEL", "base.en")
    monkeypatch.setenv("LLM_BASE_URL", "http://127.0.0.1:11434/v1")
    monkeypatch.setenv("LLM_MODEL", "gemma3:4b")


def test_sqlite_is_the_default_meeting_storage(monkeypatch: pytest.MonkeyPatch) -> None:
    set_required_model_configuration(monkeypatch)
    monkeypatch.delenv("MEETING_STORAGE_BACKEND", raising=False)
    monkeypatch.setenv("AUTH_ENABLED", "0")

    settings = Settings.from_environment()

    assert settings.storage_backend == "sqlite"
    assert isinstance(create_meeting_store(settings), MeetingRepository)


def test_postgresql_storage_requires_a_database_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    set_required_model_configuration(monkeypatch)
    monkeypatch.setenv("MEETING_STORAGE_BACKEND", "postgresql")
    monkeypatch.delenv("POSTGRES_DATABASE_URL", raising=False)

    with pytest.raises(
        RuntimeError,
        match="Missing required environment variable: POSTGRES_DATABASE_URL",
    ):
        Settings.from_environment()


def test_postgresql_storage_is_selected_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    set_required_model_configuration(monkeypatch)
    monkeypatch.setenv("MEETING_STORAGE_BACKEND", "postgresql")
    monkeypatch.setenv(
        "POSTGRES_DATABASE_URL", "postgresql://user:password@localhost:5432/notes"
    )
    monkeypatch.setenv("AUTH_ENABLED", "1")
    monkeypatch.setenv("AUTH_SESSION_SECRET", "s" * 32)
    monkeypatch.setenv("LLM_API_KEY", "remote-provider-key")

    settings = Settings.from_environment()

    assert isinstance(create_meeting_store(settings), PostgresMeetingRepository)


def test_postgresql_storage_requires_authentication(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    set_required_model_configuration(monkeypatch)
    monkeypatch.setenv("MEETING_STORAGE_BACKEND", "postgresql")
    monkeypatch.setenv("POSTGRES_DATABASE_URL", "postgresql://test")
    monkeypatch.delenv("AUTH_ENABLED", raising=False)

    with pytest.raises(RuntimeError, match="requires AUTH_ENABLED=1"):
        Settings.from_environment()


def test_storage_backend_must_be_supported(monkeypatch: pytest.MonkeyPatch) -> None:
    set_required_model_configuration(monkeypatch)
    monkeypatch.setenv("MEETING_STORAGE_BACKEND", "unsupported")

    with pytest.raises(RuntimeError, match="MEETING_STORAGE_BACKEND"):
        Settings.from_environment()
