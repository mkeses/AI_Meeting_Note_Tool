"""Environment-backed deployment configuration."""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Settings:
    whisper_model: str
    llm_base_url: str
    llm_api_key: str | None
    llm_model: str
    database_path: str
    storage_backend: str
    postgres_database_url: str | None
    auth_enabled: bool
    auth_session_secret: str | None
    auth_session_lifetime_seconds: int
    auth_cookie_secure: bool
    auth_cookie_name: str
    electron_desktop_mode: bool
    electron_renderer_origin: str | None

    @classmethod
    def from_environment(cls) -> "Settings":
        values = {
            "WHISPER_MODEL": os.getenv("WHISPER_MODEL"),
            "LLM_BASE_URL": os.getenv("LLM_BASE_URL"),
            "LLM_MODEL": os.getenv("LLM_MODEL"),
        }
        missing = [name for name, value in values.items() if not value]
        if missing:
            raise RuntimeError(
                "Missing required environment variables: " + ", ".join(missing)
            )

        storage_backend = os.getenv("MEETING_STORAGE_BACKEND", "sqlite").lower()
        postgres_database_url = os.getenv("POSTGRES_DATABASE_URL")
        if storage_backend not in {"sqlite", "postgresql"}:
            raise RuntimeError(
                "MEETING_STORAGE_BACKEND must be either 'sqlite' or 'postgresql'"
            )
        if storage_backend == "postgresql" and not postgres_database_url:
            raise RuntimeError(
                "Missing required environment variable: POSTGRES_DATABASE_URL"
            )

        auth_enabled = os.getenv("AUTH_ENABLED", "0") == "1"
        auth_session_secret = os.getenv("AUTH_SESSION_SECRET")
        try:
            auth_session_lifetime_seconds = int(
                os.getenv("AUTH_SESSION_LIFETIME_SECONDS", "86400")
            )
        except ValueError as error:
            raise RuntimeError(
                "AUTH_SESSION_LIFETIME_SECONDS must be an integer"
            ) from error

        if auth_enabled and storage_backend != "postgresql":
            raise RuntimeError(
                "AUTH_ENABLED requires MEETING_STORAGE_BACKEND=postgresql"
            )
        if storage_backend == "postgresql" and not auth_enabled:
            raise RuntimeError(
                "MEETING_STORAGE_BACKEND=postgresql requires AUTH_ENABLED=1"
            )
        if auth_enabled and (not auth_session_secret or len(auth_session_secret) < 32):
            raise RuntimeError(
                "AUTH_ENABLED requires an AUTH_SESSION_SECRET of at least 32 characters"
            )
        if auth_session_lifetime_seconds <= 0:
            raise RuntimeError("AUTH_SESSION_LIFETIME_SECONDS must be positive")

        return cls(
            whisper_model=values["WHISPER_MODEL"],
            llm_base_url=values["LLM_BASE_URL"],
            llm_api_key=os.getenv("LLM_API_KEY"),
            llm_model=values["LLM_MODEL"],
            database_path=os.getenv("DATABASE_PATH", str(Path("data") / "meetings.db")),
            storage_backend=storage_backend,
            postgres_database_url=postgres_database_url,
            auth_enabled=auth_enabled,
            auth_session_secret=auth_session_secret,
            auth_session_lifetime_seconds=auth_session_lifetime_seconds,
            auth_cookie_secure=os.getenv("AUTH_COOKIE_SECURE", "1") == "1",
            auth_cookie_name=os.getenv("AUTH_COOKIE_NAME", "ai_meeting_session"),
            electron_desktop_mode=os.getenv("ELECTRON_DESKTOP_MODE") == "1",
            electron_renderer_origin=os.getenv("ELECTRON_RENDERER_ORIGIN"),
        )
