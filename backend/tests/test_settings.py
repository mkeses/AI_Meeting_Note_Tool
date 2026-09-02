import pytest

from settings import Settings


def test_settings_reads_deployment_values_without_making_them_global(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WHISPER_MODEL", "base.en")
    monkeypatch.setenv("LLM_BASE_URL", "https://llm.example.test/v1")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "model")
    monkeypatch.setenv("DATABASE_PATH", "/data/meetings.db")
    monkeypatch.setenv("ELECTRON_DESKTOP_MODE", "1")
    monkeypatch.setenv("ELECTRON_RENDERER_ORIGIN", "meeting://renderer")

    settings = Settings.from_environment()

    assert settings.whisper_model == "base.en"
    assert settings.llm_base_url == "https://llm.example.test/v1"
    assert settings.database_path == "/data/meetings.db"
    assert settings.electron_desktop_mode is True
    assert settings.electron_renderer_origin == "meeting://renderer"


def test_local_ollama_settings_do_not_require_an_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WHISPER_MODEL", "base.en")
    monkeypatch.setenv("LLM_BASE_URL", "http://127.0.0.1:11434/v1")
    monkeypatch.setenv("LLM_MODEL", "gemma3:4b")
    monkeypatch.delenv("LLM_API_KEY", raising=False)

    settings = Settings.from_environment()

    assert settings.llm_api_key is None


def test_settings_reports_all_missing_model_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("WHISPER_MODEL", "LLM_BASE_URL", "LLM_MODEL"):
        monkeypatch.delenv(name, raising=False)

    with pytest.raises(RuntimeError, match="WHISPER_MODEL, LLM_BASE_URL"):
        Settings.from_environment()


def test_authentication_requires_postgresql_and_a_session_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WHISPER_MODEL", "base.en")
    monkeypatch.setenv("LLM_BASE_URL", "http://127.0.0.1:11434/v1")
    monkeypatch.setenv("LLM_MODEL", "gemma3:4b")
    monkeypatch.setenv("AUTH_ENABLED", "1")
    monkeypatch.delenv("AUTH_SESSION_SECRET", raising=False)

    with pytest.raises(RuntimeError, match="AUTH_ENABLED requires"):
        Settings.from_environment()


def test_remote_authentication_configuration_is_opt_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WHISPER_MODEL", "base.en")
    monkeypatch.setenv("LLM_BASE_URL", "https://provider.example.test/v1")
    monkeypatch.setenv("LLM_API_KEY", "remote-provider-key")
    monkeypatch.setenv("LLM_MODEL", "remote-model")
    monkeypatch.setenv("MEETING_STORAGE_BACKEND", "postgresql")
    monkeypatch.setenv("POSTGRES_DATABASE_URL", "postgresql://test")
    monkeypatch.setenv("AUTH_ENABLED", "1")
    monkeypatch.setenv("AUTH_SESSION_SECRET", "s" * 32)

    settings = Settings.from_environment()

    assert settings.auth_enabled is True
    assert settings.auth_cookie_secure is True


def test_remote_authentication_requires_an_llm_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WHISPER_MODEL", "base.en")
    monkeypatch.setenv("LLM_BASE_URL", "https://provider.example.test/v1")
    monkeypatch.setenv("LLM_MODEL", "remote-model")
    monkeypatch.setenv("MEETING_STORAGE_BACKEND", "postgresql")
    monkeypatch.setenv("POSTGRES_DATABASE_URL", "postgresql://test")
    monkeypatch.setenv("AUTH_ENABLED", "1")
    monkeypatch.setenv("AUTH_SESSION_SECRET", "s" * 32)
    monkeypatch.delenv("LLM_API_KEY", raising=False)

    with pytest.raises(RuntimeError, match="AUTH_ENABLED requires LLM_API_KEY"):
        Settings.from_environment()


def test_llm_timeout_is_configured_server_side(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WHISPER_MODEL", "base.en")
    monkeypatch.setenv("LLM_BASE_URL", "https://provider.example.test/v1")
    monkeypatch.setenv("LLM_MODEL", "remote-model")
    monkeypatch.setenv("LLM_TIMEOUT_SECONDS", "12.5")

    settings = Settings.from_environment()

    assert settings.llm_timeout_seconds == 12.5
