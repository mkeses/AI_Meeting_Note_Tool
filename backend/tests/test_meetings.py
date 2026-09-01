from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app as backend_app
from database import Meeting, MeetingRepository


class StubTranscriptionService:
    """Avoid loading local AI models while exercising the REST API boundary."""

    def __init__(self, **_kwargs: str) -> None:
        pass


def meeting_payload(**overrides: object) -> dict[str, object]:
    return {
        "id": "meeting-1",
        "sourceKey": "recording:source-1",
        "filename": "recording.webm",
        "createdAt": "2026-09-01T12:00:00.000Z",
        "meetingType": "general",
        "rawText": "Raw transcript",
        "cleanedText": "Cleaned transcript",
        "sourceType": "recording",
        "notes": "Follow up with the design team.",
        **overrides,
    }


@pytest.fixture
def api_client(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[TestClient]:
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "meetings.db"))
    monkeypatch.setenv("WHISPER_MODEL", "test-model")
    monkeypatch.setenv("LLM_BASE_URL", "http://llm.test/v1")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "test-model")
    monkeypatch.setattr(
        backend_app,
        "TranscriptionService",
        StubTranscriptionService,
    )

    with TestClient(backend_app.app) as client:
        yield client


def test_repository_initialization_persists_across_instances(tmp_path: Path) -> None:
    database_path = tmp_path / "persistent-meetings.db"
    first_repository = MeetingRepository(database_path)
    first_repository.initialize()

    meeting = Meeting(
        id="persisted-meeting",
        source_key="text:persisted-meeting",
        filename="Pasted transcript",
        created_at="2026-09-01T12:00:00+00:00",
        updated_at="2026-09-01T12:00:00+00:00",
        meeting_type="general",
        raw_text="Raw transcript",
        cleaned_text="",
        source_type="text",
        notes="",
    )
    first_repository.create(meeting)

    second_repository = MeetingRepository(database_path)
    second_repository.initialize()

    assert database_path.exists()
    assert second_repository.get(meeting.id) == meeting


def test_create_list_and_retrieve_meetings(api_client: TestClient) -> None:
    payload = meeting_payload()

    create_response = api_client.post("/api/meetings", json=payload)

    assert create_response.status_code == 201
    created = create_response.json()
    assert created["id"] == payload["id"]
    assert created["sourceKey"] == payload["sourceKey"]
    assert created["notes"] == payload["notes"]
    assert created["updatedAt"] == created["createdAt"]

    list_response = api_client.get("/api/meetings")
    get_response = api_client.get("/api/meetings/meeting-1")

    assert list_response.status_code == 200
    assert list_response.json() == [created]
    assert get_response.status_code == 200
    assert get_response.json() == created


def test_partial_update_preserves_unspecified_fields_and_other_meetings(
    api_client: TestClient,
) -> None:
    first_payload = meeting_payload()
    second_payload = meeting_payload(
        id="meeting-2",
        sourceKey="text:source-2",
        filename="Pasted transcript",
        sourceType="text",
        notes="Keep this note.",
    )
    original_first = api_client.post("/api/meetings", json=first_payload).json()
    api_client.post("/api/meetings", json=second_payload)

    update_response = api_client.patch(
        "/api/meetings/meeting-1",
        json={
            "filename": "Updated meeting",
            "rawText": "Edited transcript",
            "notes": "Updated notes.",
        },
    )

    assert update_response.status_code == 200
    updated = update_response.json()
    assert updated["filename"] == "Updated meeting"
    assert updated["rawText"] == "Edited transcript"
    assert updated["notes"] == "Updated notes."
    assert updated["cleanedText"] == first_payload["cleanedText"]
    assert updated["meetingType"] == first_payload["meetingType"]
    assert updated["sourceKey"] == first_payload["sourceKey"]
    assert updated["updatedAt"] != original_first["updatedAt"]

    meetings = api_client.get("/api/meetings").json()
    assert {meeting["id"] for meeting in meetings} == {"meeting-1", "meeting-2"}
    assert (
        api_client.get("/api/meetings/meeting-2").json()["notes"] == "Keep this note."
    )


def test_delete_meeting_removes_only_requested_record(api_client: TestClient) -> None:
    api_client.post("/api/meetings", json=meeting_payload())
    api_client.post(
        "/api/meetings",
        json=meeting_payload(
            id="meeting-2", sourceKey="text:source-2", sourceType="text"
        ),
    )

    delete_response = api_client.delete("/api/meetings/meeting-1")

    assert delete_response.status_code == 204
    assert delete_response.content == b""
    assert api_client.get("/api/meetings/meeting-1").status_code == 404
    assert [meeting["id"] for meeting in api_client.get("/api/meetings").json()] == [
        "meeting-2"
    ]


def test_missing_meetings_return_not_found(api_client: TestClient) -> None:
    assert api_client.get("/api/meetings/missing").status_code == 404
    assert (
        api_client.patch("/api/meetings/missing", json={"notes": "Note"}).status_code
        == 404
    )
    assert api_client.delete("/api/meetings/missing").status_code == 404


def test_duplicate_ids_and_malformed_payloads_are_rejected(
    api_client: TestClient,
) -> None:
    assert api_client.post("/api/meetings", json=meeting_payload()).status_code == 201

    duplicate_response = api_client.post(
        "/api/meetings",
        json=meeting_payload(sourceKey="text:another-source", sourceType="text"),
    )
    invalid_response = api_client.post(
        "/api/meetings",
        json=meeting_payload(id="meeting-3", meetingType="invalid"),
    )
    empty_update_response = api_client.patch("/api/meetings/meeting-1", json={})

    assert duplicate_response.status_code == 409
    assert invalid_response.status_code == 422
    assert empty_update_response.status_code == 422
