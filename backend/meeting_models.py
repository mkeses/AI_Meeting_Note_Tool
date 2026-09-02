"""Pydantic contracts for the persistent meetings REST API."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from meeting_entity import Meeting

MeetingType = Literal["general", "design_review", "debug_sync", "standup"]
SourceType = Literal["recording", "audio-file", "text"]


class MeetingModel(BaseModel):
    """Common API configuration for the browser-facing meeting contract."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class MeetingCreate(MeetingModel):
    id: str = Field(min_length=1, max_length=255)
    source_key: str = Field(min_length=1, max_length=255, alias="sourceKey")
    filename: str = Field(min_length=1, max_length=255)
    created_at: datetime | None = Field(default=None, alias="createdAt")
    meeting_type: MeetingType = Field(alias="meetingType")
    raw_text: str = Field(alias="rawText")
    cleaned_text: str = Field(default="", alias="cleanedText")
    source_type: SourceType = Field(alias="sourceType")
    notes: str = ""

    @field_validator("id", "source_key", "filename")
    @classmethod
    def reject_blank_identifiers(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("created_at")
    @classmethod
    def normalize_created_at(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("must include a timezone")
        return value.astimezone(UTC)

    def to_record(self, *, created_at: datetime) -> Meeting:
        created_at_value = created_at.astimezone(UTC).isoformat()
        return Meeting(
            id=self.id,
            source_key=self.source_key,
            filename=self.filename,
            created_at=created_at_value,
            updated_at=created_at_value,
            meeting_type=self.meeting_type,
            raw_text=self.raw_text,
            cleaned_text=self.cleaned_text,
            source_type=self.source_type,
            notes=self.notes,
        )


class MeetingUpdate(MeetingModel):
    source_key: str | None = Field(
        default=None, min_length=1, max_length=255, alias="sourceKey"
    )
    filename: str | None = Field(default=None, min_length=1, max_length=255)
    meeting_type: MeetingType | None = Field(default=None, alias="meetingType")
    raw_text: str | None = Field(default=None, alias="rawText")
    cleaned_text: str | None = Field(default=None, alias="cleanedText")
    source_type: SourceType | None = Field(default=None, alias="sourceType")
    notes: str | None = None

    @field_validator("source_key", "filename")
    @classmethod
    def reject_blank_optional_identifiers(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    def to_changes(self) -> dict[str, str]:
        return self.model_dump(exclude_unset=True)


class MeetingResponse(MeetingCreate):
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")

    @classmethod
    def from_record(cls, meeting: Meeting) -> MeetingResponse:
        return cls(
            id=meeting.id,
            source_key=meeting.source_key,
            filename=meeting.filename,
            created_at=datetime.fromisoformat(meeting.created_at),
            updated_at=datetime.fromisoformat(meeting.updated_at),
            meeting_type=meeting.meeting_type,
            raw_text=meeting.raw_text,
            cleaned_text=meeting.cleaned_text,
            source_type=meeting.source_type,
            notes=meeting.notes,
        )
