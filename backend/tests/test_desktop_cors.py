from __future__ import annotations

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
