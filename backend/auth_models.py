"""Pydantic contracts for optional remote authentication endpoints."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from user_entity import User


class AuthenticationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    login: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=1024)

    @field_validator("login")
    @classmethod
    def normalize_login(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized


class AuthenticatedUserResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    login: str
    created_at: datetime = Field(alias="createdAt")

    @classmethod
    def from_user(cls, user: User) -> AuthenticatedUserResponse:
        return cls(
            id=user.id,
            login=user.login,
            created_at=datetime.fromisoformat(user.created_at),
        )
