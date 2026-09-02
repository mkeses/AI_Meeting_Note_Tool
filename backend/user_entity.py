"""Storage-independent authenticated user entity."""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class User:
    id: str
    login: str
    created_at: str
