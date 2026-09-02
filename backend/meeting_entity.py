"""Storage-independent meeting entity shared by API and repositories."""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Meeting:
    """Application representation of one saved meeting."""

    id: str
    source_key: str
    filename: str
    created_at: str
    updated_at: str
    meeting_type: str
    raw_text: str
    cleaned_text: str
    source_type: str
    notes: str
