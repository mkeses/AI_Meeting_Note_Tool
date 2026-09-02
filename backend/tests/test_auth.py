from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

import app as backend_app
from auth import (
    create_session_token,
    hash_password,
    hash_session_token,
    utc_now,
    verify_password,
)
from meeting_entity import Meeting
from storage import MeetingConflictError, UserConflictError
from user_entity import User


class StubTranscriptionService:
    def __init__(self, **_kwargs: object) -> None:
        pass


class FakeRemoteStore:
    def __init__(self) -> None:
        self.users_by_login: dict[str, tuple[User, str]] = {}
        self.users_by_id: dict[str, User] = {}
        self.sessions: dict[str, tuple[str, datetime]] = {}
        self.meetings: dict[str, tuple[str, Meeting]] = {}

    def initialize(self) -> None:
        pass

    def for_owner(self, owner_id: str):
        return FakeOwnerStore(self, owner_id)

    def create_user(self, login: str, password_hash: str) -> User:
        if login in self.users_by_login:
            raise UserConflictError("Login already exists")
        user = User(
            id=f"user-{len(self.users_by_id) + 1}",
            login=login,
            created_at="2026-09-02T12:00:00+00:00",
        )
        self.users_by_login[login] = (user, password_hash)
        self.users_by_id[user.id] = user
        return user

    def get_user_by_login(self, login: str) -> tuple[User, str] | None:
        return self.users_by_login.get(login)

    def get_user_by_session(
        self, session_token_hash: str, now: datetime
    ) -> User | None:
        session = self.sessions.get(session_token_hash)
        if session is None or session[1] <= now:
            self.sessions.pop(session_token_hash, None)
            return None
        return self.users_by_id[session[0]]

    def create_session(
        self, user_id: str, session_token_hash: str, expires_at: datetime
    ) -> None:
        self.sessions[session_token_hash] = (user_id, expires_at)

    def delete_session(self, session_token_hash: str) -> None:
        self.sessions.pop(session_token_hash, None)


class FakeOwnerStore:
    def __init__(self, store: FakeRemoteStore, owner_id: str) -> None:
        self.store = store
        self.owner_id = owner_id

    def create(self, meeting: Meeting) -> Meeting:
        if meeting.id in self.store.meetings or any(
            saved.source_key == meeting.source_key and owner == self.owner_id
            for owner, saved in self.store.meetings.values()
        ):
            raise MeetingConflictError("Meeting ID or source key already exists")
        self.store.meetings[meeting.id] = (self.owner_id, meeting)
        return meeting

    def list(self) -> list[Meeting]:
        return [
            meeting
            for owner, meeting in self.store.meetings.values()
            if owner == self.owner_id
        ]

    def get(self, meeting_id: str) -> Meeting | None:
        saved = self.store.meetings.get(meeting_id)
        return saved[1] if saved and saved[0] == self.owner_id else None

    def search(self, query: str) -> list[Meeting]:
        needle = query.lower()
        return [
            meeting
            for meeting in self.list()
            if needle
            in f"{meeting.filename} {meeting.cleaned_text} {meeting.notes}".lower()
        ]

    def update(self, meeting_id: str, changes: dict[str, str]) -> Meeting | None:
        meeting = self.get(meeting_id)
        if meeting is None:
            return None
        updated = replace(meeting, **changes, updated_at=utc_now().isoformat())
        self.store.meetings[meeting_id] = (self.owner_id, updated)
        return updated

    def delete(self, meeting_id: str) -> bool:
        if self.get(meeting_id) is None:
            return False
        del self.store.meetings[meeting_id]
        return True


def meeting_payload(**overrides: object) -> dict[str, object]:
    return {
        "id": "meeting-a",
        "sourceKey": "text:meeting-a",
        "filename": "Architecture review",
        "createdAt": "2026-09-02T12:00:00.000Z",
        "meetingType": "general",
        "rawText": "Raw transcript",
        "cleanedText": "Sensitive rollout discussion",
        "sourceType": "text",
        "notes": "private-search-term",
        **overrides,
    }


@pytest.fixture
def remote_client(monkeypatch: pytest.MonkeyPatch):
    store = FakeRemoteStore()
    monkeypatch.setenv("WHISPER_MODEL", "test-model")
    monkeypatch.setenv("LLM_BASE_URL", "http://llm.test/v1")
    monkeypatch.setenv("LLM_MODEL", "test-model")
    monkeypatch.setenv("MEETING_STORAGE_BACKEND", "postgresql")
    monkeypatch.setenv("POSTGRES_DATABASE_URL", "postgresql://test")
    monkeypatch.setenv("AUTH_ENABLED", "1")
    monkeypatch.setenv("AUTH_SESSION_SECRET", "s" * 32)
    monkeypatch.setenv("AUTH_COOKIE_SECURE", "0")
    monkeypatch.setattr(backend_app, "TranscriptionService", StubTranscriptionService)
    monkeypatch.setattr(backend_app, "create_meeting_store", lambda _settings: store)

    with TestClient(backend_app.app) as client:
        yield client, store


def register(client: TestClient, login: str, password: str = "correct-password"):
    return client.post(
        "/api/auth/register", json={"login": login, "password": password}
    )


def login(client: TestClient, login: str, password: str = "correct-password"):
    return client.post("/api/auth/login", json={"login": login, "password": password})


def test_password_hashing_never_returns_the_plaintext_password() -> None:
    password_hash = hash_password("correct-password")

    assert password_hash != "correct-password"
    assert verify_password("correct-password", password_hash)
    assert not verify_password("wrong-password", password_hash)


def test_registration_login_current_user_and_logout(remote_client) -> None:
    client, store = remote_client

    registered = register(client, "Alice")
    assert registered.status_code == 201
    assert registered.json()["login"] == "alice"
    assert store.users_by_login["alice"][1] != "correct-password"
    assert register(client, "alice").status_code == 409
    assert login(client, "alice", "wrong-password").status_code == 401

    logged_in = login(client, "alice")
    assert logged_in.status_code == 200
    assert "HttpOnly" in logged_in.headers["set-cookie"]
    assert "SameSite=lax" in logged_in.headers["set-cookie"]
    assert client.get("/api/auth/me").json()["login"] == "alice"

    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/auth/me").status_code == 401


def test_invalid_and_expired_sessions_are_rejected(remote_client) -> None:
    client, store = remote_client
    register(client, "alice")

    client.cookies.set("ai_meeting_session", "invalid")
    assert client.get("/api/auth/me").status_code == 401

    expired_token = create_session_token()
    token_hash = hash_session_token(expired_token, "s" * 32)
    alice = store.users_by_login["alice"][0]
    store.create_session(
        alice.id,
        token_hash,
        utc_now() - timedelta(seconds=1),
    )
    client.cookies.set("ai_meeting_session", expired_token)
    assert client.get("/api/auth/me").status_code == 401


def test_meetings_are_scoped_to_the_authenticated_user(remote_client) -> None:
    alice_client, _store = remote_client
    bob_client = TestClient(backend_app.app)
    try:
        assert alice_client.get("/api/meetings").status_code == 401
        register(alice_client, "alice")
        login(alice_client, "alice")
        created = alice_client.post(
            "/api/meetings",
            json=meeting_payload(ownerId="user-b"),
        )
        assert created.status_code == 422
        created = alice_client.post("/api/meetings", json=meeting_payload())
        assert created.status_code == 201

        register(bob_client, "bob")
        login(bob_client, "bob")
        assert bob_client.get("/api/meetings").json() == []
        assert bob_client.get("/api/meetings/meeting-a").status_code == 404
        assert bob_client.get("/api/meetings/search?q=private-search-term").json() == []
        assert (
            bob_client.patch(
                "/api/meetings/meeting-a", json={"notes": "attacker"}
            ).status_code
            == 404
        )
        assert bob_client.delete("/api/meetings/meeting-a").status_code == 404
        assert alice_client.get("/api/meetings/meeting-a").status_code == 200
    finally:
        bob_client.close()
