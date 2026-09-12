from model_provisioning import (
    ModelProvider,
    ModelProvisioningState,
    ModelProvisioningStatus,
    ollama_status,
)


def test_model_status_represents_provisioning_and_failure_states() -> None:
    provisioning = ollama_status("gemma3:4b", ModelProvisioningState.PROVISIONING)
    failed = ollama_status(
        "gemma3:4b",
        ModelProvisioningState.FAILED,
        error="Model provisioning failed",
    )

    assert provisioning.provider == ModelProvider.OLLAMA
    assert provisioning.state == ModelProvisioningState.PROVISIONING
    assert failed.state == ModelProvisioningState.FAILED
    assert failed.error == "Model provisioning failed"


def test_model_status_serialization_is_safe() -> None:
    status = ModelProvisioningStatus(
        model_id="base.en",
        provider=ModelProvider.HUGGINGFACE,
        storage_location="C:\\private\\models",
        state=ModelProvisioningState.READY,
        progress=None,
    )

    assert status.as_dict() == {
        "model": "base.en",
        "provider": "huggingface",
        "state": "ready",
        "progress": None,
        "error": None,
    }
