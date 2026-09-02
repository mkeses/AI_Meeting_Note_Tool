from __future__ import annotations

import asyncio

import pytest

import app as backend_app
from app import ELECTRON_RENDERER_ORIGIN, VITE_CORS_ORIGINS, get_allowed_cors_origins


def test_browser_origins_remain_allowed_without_desktop_mode(monkeypatch) -> None:
    monkeypatch.delenv("ELECTRON_DESKTOP_MODE", raising=False)

    assert get_allowed_cors_origins() == VITE_CORS_ORIGINS


def test_desktop_mode_allows_only_the_packaged_renderer_origin(monkeypatch) -> None:
    monkeypatch.setenv("ELECTRON_DESKTOP_MODE", "1")
    monkeypatch.setenv("ELECTRON_RENDERER_ORIGIN", ELECTRON_RENDERER_ORIGIN)

    assert get_allowed_cors_origins() == [
        *VITE_CORS_ORIGINS,
        ELECTRON_RENDERER_ORIGIN,
    ]


def test_desktop_mode_does_not_trust_an_arbitrary_renderer_origin(monkeypatch) -> None:
    monkeypatch.setenv("ELECTRON_DESKTOP_MODE", "1")
    monkeypatch.setenv("ELECTRON_RENDERER_ORIGIN", "https://untrusted.example")

    assert get_allowed_cors_origins() == VITE_CORS_ORIGINS


def test_non_desktop_lifespan_requires_an_llm_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ELECTRON_DESKTOP_MODE", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.setenv("WHISPER_MODEL", "test-model")
    monkeypatch.setenv("LLM_BASE_URL", "http://127.0.0.1:11434/v1")
    monkeypatch.setenv("LLM_MODEL", "test-model")

    async def start_lifespan() -> None:
        async with backend_app.lifespan(backend_app.app):
            pass

    with pytest.raises(
        RuntimeError,
        match="Missing required environment variables: LLM_API_KEY",
    ):
        asyncio.run(start_lifespan())
