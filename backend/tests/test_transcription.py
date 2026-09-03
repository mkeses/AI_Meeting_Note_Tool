from types import SimpleNamespace

import llm
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

    calls: list[dict[str, object]] = []

    def __init__(self, **_kwargs: str) -> None:
        self.calls.append(_kwargs)
        self.models = SimpleNamespace(list=lambda: [])


class FakeMeetingIntelligence:
    def clean(self, text: str, system_prompt=None, meeting_type="general") -> str:
        return f"cleaned:{text}:{meeting_type}"


def test_transcription_service_initializes_faster_whisper_for_cpu_int8(
    monkeypatch,
    capsys,
) -> None:
    FakeWhisperModel.calls.clear()
    monkeypatch.setattr(transcription, "WhisperModel", FakeWhisperModel)
    monkeypatch.setattr(llm, "OpenAI", FakeOpenAI)

    service = transcription.TranscriptionService(
        whisper_model="base.en",
        llm_base_url="https://private-key@llm.test/v1",
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
    assert "private-key" not in capsys.readouterr().out


def test_transcription_service_accepts_an_injected_intelligence_provider(
    monkeypatch,
) -> None:
    monkeypatch.setattr(transcription, "WhisperModel", FakeWhisperModel)

    service = transcription.TranscriptionService(
        whisper_model="base.en",
        llm_base_url="http://unused.test/v1",
        llm_api_key="unused",
        llm_model="unused",
        llm_provider=FakeMeetingIntelligence(),
    )

    assert service.clean_with_llm("raw", meeting_type="standup") == (
        "cleaned:raw:standup"
    )


def test_local_ollama_provider_uses_a_safe_sdk_placeholder_for_a_missing_key(
    monkeypatch,
) -> None:
    FakeWhisperModel.calls.clear()
    FakeOpenAI.calls.clear()
    monkeypatch.setattr(transcription, "WhisperModel", FakeWhisperModel)
    monkeypatch.setattr(llm, "OpenAI", FakeOpenAI)

    transcription.TranscriptionService(
        whisper_model="base.en",
        llm_base_url="http://127.0.0.1:11434/v1",
        llm_api_key=None,
        llm_model="gemma3:4b",
        llm_timeout_seconds=12.5,
    )

    assert FakeOpenAI.calls == [
        {
            "base_url": "http://127.0.0.1:11434/v1",
            "api_key": "ollama",
            "timeout": 12.5,
        }
    ]
