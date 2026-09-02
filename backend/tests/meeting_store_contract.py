"""Reusable behavioral checks for MeetingStore implementations."""

from dataclasses import replace
from uuid import uuid4

import pytest

from meeting_entity import Meeting
from storage import MeetingConflictError, MeetingStorageError, MeetingStore


def assert_meeting_store_contract(store: MeetingStore) -> None:
    """Exercise the storage behavior visible through the MeetingStore contract."""
    suffix = uuid4().hex
    meeting_id = f"meeting-{suffix}"
    source_key = f"text:{suffix}"
    original_search_term = f"architecture{suffix}"
    updated_search_term = f"rollout{suffix}"
    meeting = Meeting(
        id=meeting_id,
        source_key=source_key,
        filename="Architecture review",
        created_at="2026-09-01T12:00:00+00:00",
        updated_at="2026-09-01T12:00:00+00:00",
        meeting_type="general",
        raw_text="Raw transcript",
        cleaned_text="Cleaned transcript",
        source_type="text",
        notes=original_search_term,
    )

    store.initialize()
    store.initialize()

    try:
        assert store.create(meeting) == meeting
        assert store.get(meeting_id) == meeting
        assert meeting in store.list()
        assert store.search(original_search_term) == [meeting]

        with pytest.raises(MeetingConflictError):
            store.create(replace(meeting, source_key=f"text:duplicate-{suffix}"))
        with pytest.raises(MeetingConflictError):
            store.create(replace(meeting, id=f"duplicate-{suffix}"))

        updated = store.update(
            meeting_id,
            {"notes": updated_search_term, "filename": "Updated review"},
        )
        assert updated is not None
        assert updated.notes == updated_search_term
        assert updated.filename == "Updated review"
        assert updated.updated_at != meeting.updated_at
        assert store.search(original_search_term) == []
        assert store.search(updated_search_term) == [updated]

        assert store.get(f"missing-{suffix}") is None
        assert store.update(f"missing-{suffix}", {"notes": "No change"}) is None
        assert store.delete(f"missing-{suffix}") is False
        with pytest.raises(MeetingStorageError):
            store.update(meeting_id, {"unsupported": "value"})

        assert store.delete(meeting_id) is True
        assert store.get(meeting_id) is None
        assert store.search(updated_search_term) == []
    finally:
        store.delete(meeting_id)
