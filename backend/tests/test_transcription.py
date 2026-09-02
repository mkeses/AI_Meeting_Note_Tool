from types import SimpleNamespace

import transcription


class FakeWhisperModel:
    """Record the model runtime contract without loading model files."""

    calls: list[dict[str, str]] = []

    def __init__(
        self,
        model_name: str,
        *,
        device: str,
        compute_type: str,
    ) -> None:
        self.calls.append(
            {
                "model_name": model_name,
                "device": device,
                "compute_type": compute_type,
            }
        )


class FakeOpenAI:
    """Avoid reaching an LLM while constructing the transcription service."""

    def __init__(self, **_kwargs: str) -> None:
        self.models = SimpleNamespace(list=lambda: [])


def test_transcription_service_initializes_faster_whisper_for_cpu_int8(
    monkeypatch,
) -> None:
    FakeWhisperModel.calls.clear()
    monkeypatch.setattr(transcription, "WhisperModel", FakeWhisperModel)
    monkeypatch.setattr(transcription, "OpenAI", FakeOpenAI)

    service = transcription.TranscriptionService(
        whisper_model="base.en",
        llm_base_url="http://llm.test/v1",
        llm_api_key="test-key",
        llm_model="test-model",
    )

    assert FakeWhisperModel.calls == [
        {
            "model_name": "base.en",
            "device": "cpu",
            "compute_type": "int8",
        }
    ]
    assert service.whisper_device == "cpu"
    assert service.whisper_compute_type == "int8"
