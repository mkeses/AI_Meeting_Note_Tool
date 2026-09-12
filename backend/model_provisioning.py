"""Small, provider-neutral model availability status types."""

from dataclasses import dataclass
from enum import StrEnum


class ModelProvider(StrEnum):
    HUGGINGFACE = "huggingface"
    OLLAMA = "ollama"


class ModelProvisioningState(StrEnum):
    NOT_REQUIRED = "not_required"
    CHECKING = "checking"
    AVAILABLE = "available"
    MISSING = "missing"
    PROVISIONING = "provisioning"
    READY = "ready"
    FAILED = "failed"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True, slots=True)
class ModelProvisioningStatus:
    """Safe status information suitable for diagnostics and API responses."""

    model_id: str
    provider: ModelProvider
    storage_location: str | None
    state: ModelProvisioningState
    progress: float | None = None
    error: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "model": self.model_id,
            "provider": self.provider.value,
            "state": self.state.value,
            "progress": self.progress,
            "error": self.error,
        }


def whisper_ready_status(
    model_id: str, storage_location: str | None = None
) -> ModelProvisioningStatus:
    """Faster-Whisper owns cache discovery; successful construction is authoritative."""
    return ModelProvisioningStatus(
        model_id=model_id,
        provider=ModelProvider.HUGGINGFACE,
        storage_location=storage_location,
        state=ModelProvisioningState.READY,
    )


def whisper_failed_status(
    model_id: str, error: str, storage_location: str | None = None
) -> ModelProvisioningStatus:
    return ModelProvisioningStatus(
        model_id=model_id,
        provider=ModelProvider.HUGGINGFACE,
        storage_location=storage_location,
        state=ModelProvisioningState.FAILED,
        error=error,
    )


def ollama_status(
    model_id: str,
    state: ModelProvisioningState,
    storage_location: str | None = None,
    error: str | None = None,
) -> ModelProvisioningStatus:
    return ModelProvisioningStatus(
        model_id=model_id,
        provider=ModelProvider.OLLAMA,
        storage_location=storage_location,
        state=state,
        error=error,
    )
