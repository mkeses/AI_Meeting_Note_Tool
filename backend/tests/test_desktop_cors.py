from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from app import ELECTRON_RENDERER_ORIGIN, VITE_CORS_ORIGINS, get_allowed_cors_origins


def test_browser_origins_remain_allowed_without_desktop_mode(monkeypatch) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "0")
    monkeypatch.delenv("ELECTRON_DESKTOP_MODE", raising=False)
    monkeypatch.delenv("REMOTE_CORS_ORIGINS", raising=False)

    assert get_allowed_cors_origins() == VITE_CORS_ORIGINS


def test_desktop_mode_allows_only_the_packaged_renderer_origin(monkeypatch) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "0")
    monkeypatch.setenv("ELECTRON_DESKTOP_MODE", "1")
    monkeypatch.setenv("ELECTRON_RENDERER_ORIGIN", ELECTRON_RENDERER_ORIGIN)
    monkeypatch.delenv("REMOTE_CORS_ORIGINS", raising=False)

    assert get_allowed_cors_origins() == [
        *VITE_CORS_ORIGINS,
        ELECTRON_RENDERER_ORIGIN,
    ]


def test_desktop_mode_does_not_trust_an_arbitrary_renderer_origin(monkeypatch) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "0")
    monkeypatch.setenv("ELECTRON_DESKTOP_MODE", "1")
    monkeypatch.setenv("ELECTRON_RENDERER_ORIGIN", "https://untrusted.example")
    monkeypatch.delenv("REMOTE_CORS_ORIGINS", raising=False)

    assert get_allowed_cors_origins() == VITE_CORS_ORIGINS


def test_configured_remote_origins_are_allowed_for_cookie_requests(monkeypatch) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "0")
    remote_origin = "https://app.example.test"
    monkeypatch.setenv("REMOTE_CORS_ORIGINS", f"{remote_origin}, {remote_origin}")

    cors_test_app = FastAPI()
    cors_test_app.add_middleware(
        CORSMiddleware,
        allow_origins=get_allowed_cors_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @cors_test_app.get("/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    with TestClient(cors_test_app) as client:
        allowed = client.get("/health", headers={"Origin": remote_origin})
        denied = client.get("/health", headers={"Origin": "https://untrusted.example"})
        csrf_preflight = client.options(
            "/health",
            headers={
                "Origin": remote_origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "X-CSRF-Token",
            },
        )

    assert get_allowed_cors_origins() == [*VITE_CORS_ORIGINS, remote_origin]
    assert allowed.headers["access-control-allow-origin"] == remote_origin
    assert allowed.headers["access-control-allow-credentials"] == "true"
    assert "access-control-allow-origin" not in denied.headers
    assert csrf_preflight.headers["access-control-allow-origin"] == remote_origin
    assert (
        "x-csrf-token" in csrf_preflight.headers["access-control-allow-headers"].lower()
    )


def test_authenticated_mode_does_not_add_unconfigured_development_origins(
    monkeypatch,
) -> None:
    remote_origin = "https://app.example.test"
    monkeypatch.setenv("AUTH_ENABLED", "1")
    monkeypatch.setenv("REMOTE_CORS_ORIGINS", remote_origin)

    assert get_allowed_cors_origins() == [remote_origin]


def test_remote_cors_origins_reject_wildcards_and_non_origin_values(
    monkeypatch,
) -> None:
    monkeypatch.setenv(
        "REMOTE_CORS_ORIGINS", "*,https://user:password@app.example.test"
    )

    with pytest.raises(RuntimeError, match="exact http or https origins"):
        get_allowed_cors_origins()
