import asyncio
from types import SimpleNamespace

import pytest

import app as backend_app
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


def configure_cuda(
    monkeypatch: pytest.MonkeyPatch,
    *,
    device_count: int = 1,
    compute_types: set[str] | None = None,
) -> None:
    monkeypatch.setattr(
        transcription.ctranslate2,
        "get_cuda_device_count",
        lambda: device_count,
    )
    monkeypatch.setattr(
        transcription.ctranslate2,
        "get_supported_compute_types",
        lambda _device: compute_types or {"float16"},
    )


def build_service(**overrides):
    llm_provider = overrides.pop("llm_provider", FakeMeetingIntelligence())
    return transcription.TranscriptionService(
        whisper_model="base.en",
        llm_base_url="http://unused.test/v1",
        llm_api_key="unused",
        llm_model="unused",
        llm_provider=llm_provider,
        **overrides,
    )


def test_transcription_service_forces_cpu_int8_when_requested(
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
        whisper_device="cpu",
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


def test_transcription_service_reports_whisper_model_failure(monkeypatch):
    def fail_to_load(*_args, **_kwargs):
        raise OSError("model unavailable")

    monkeypatch.setattr(transcription, "WhisperModel", fail_to_load)

    with pytest.raises(RuntimeError, match="Whisper model 'missing.en' is unavailable"):
        transcription.TranscriptionService(
            whisper_model="missing.en",
            llm_base_url="http://unused.test/v1",
            llm_api_key=None,
            llm_model="unused",
            whisper_device="cpu",
        )


def test_transcription_service_accepts_an_injected_intelligence_provider(
    monkeypatch,
) -> None:
    monkeypatch.setattr(transcription, "WhisperModel", FakeWhisperModel)

    service = transcription.TranscriptionService(
        whisper_model="base.en",
        llm_base_url="http://unused.test/v1",
        llm_api_key="unused",
        llm_model="unused",
        whisper_device="cpu",
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
        whisper_device="cpu",
    )

    assert FakeOpenAI.calls == [
        {
            "base_url": "http://127.0.0.1:11434/v1",
            "api_key": "ollama",
            "timeout": 12.5,
        }
    ]


def test_auto_uses_cpu_when_no_cuda_device_is_visible(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeWhisperModel.calls.clear()
    monkeypatch.setattr(transcription, "WhisperModel", FakeWhisperModel)
    configure_cuda(monkeypatch, device_count=0)

    service = build_service()

    assert FakeWhisperModel.calls == [
        {"model_name": "base.en", "device": "cpu", "compute_type": "int8"}
    ]
    assert service.whisper_fallback_reason == "cuda_not_detected"


def test_forced_cpu_never_probes_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeWhisperModel.calls.clear()
    monkeypatch.setattr(transcription, "WhisperModel", FakeWhisperModel)
    monkeypatch.setattr(
        transcription.ctranslate2,
        "get_cuda_device_count",
        lambda: pytest.fail("CPU mode must not probe CUDA"),
    )

    service = build_service(whisper_device="cpu")

    assert service.whisper_device == "cpu"
    assert service.whisper_fallback_reason is None


def test_auto_attempts_cuda_float16_when_ctranslate2_supports_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeWhisperModel.calls.clear()
    monkeypatch.setattr(transcription, "WhisperModel", FakeWhisperModel)
    configure_cuda(monkeypatch)

    service = build_service()

    assert FakeWhisperModel.calls == [
        {"model_name": "base.en", "device": "cuda", "compute_type": "float16"}
    ]
    assert service.whisper_runtime_status() == {
        "device": "cuda",
        "compute_type": "float16",
        "requested_device": "auto",
        "fallback_reason": None,
    }


def test_cuda_without_float16_support_uses_cpu_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeWhisperModel.calls.clear()
    monkeypatch.setattr(transcription, "WhisperModel", FakeWhisperModel)
    configure_cuda(monkeypatch, compute_types={"float32"})

    service = build_service(whisper_device="cuda")

    assert service.whisper_device == "cpu"
    assert service.whisper_compute_type == "int8"
    assert service.whisper_fallback_reason == "cuda_capability_unsupported"


def test_cuda_capability_probe_failure_uses_safe_cpu_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeWhisperModel.calls.clear()
    monkeypatch.setattr(transcription, "WhisperModel", FakeWhisperModel)
    monkeypatch.setattr(
        transcription.ctranslate2,
        "get_cuda_device_count",
        lambda: (_ for _ in ()).throw(OSError("CUDA loader failure")),
    )

    service = build_service()

    assert service.whisper_device == "cpu"
    assert service.whisper_fallback_reason == "cuda_runtime_unavailable"


def test_cuda_initialization_failure_falls_back_to_cpu_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str]] = []

    def whisper_model(_model_name: str, *, device: str, compute_type: str):
        calls.append((device, compute_type))
        if device == "cuda":
            raise OSError("CUDA loader failure")
        return FakeWhisperModel(_model_name, device=device, compute_type=compute_type)

    monkeypatch.setattr(transcription, "WhisperModel", whisper_model)
    configure_cuda(monkeypatch)

    service = build_service()

    assert calls == [("cuda", "float16"), ("cpu", "int8")]
    assert service.whisper_fallback_reason == "cuda_initialization_failed"


class TranscriptModel:
    def __init__(self, result) -> None:
        self.result = result
        self.calls = 0

    def transcribe(self, *_args, **_kwargs):
        self.calls += 1
        if isinstance(self.result, Exception):
            raise self.result
        return self.result() if callable(self.result) else self.result


def successful_transcript(text: str = "transcript"):
    return iter([SimpleNamespace(text=text)]), SimpleNamespace(
        language="en", language_probability=1.0
    )


def test_gpu_inference_failure_retries_once_on_cpu_and_stays_on_cpu(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gpu_model = TranscriptModel(RuntimeError("out of memory"))
    cpu_model = TranscriptModel(successful_transcript)
    created: list[str] = []

    def whisper_model(_model_name: str, *, device: str, compute_type: str):
        created.append(device)
        assert compute_type == ("float16" if device == "cuda" else "int8")
        return gpu_model if device == "cuda" else cpu_model

    monkeypatch.setattr(transcription, "WhisperModel", whisper_model)
    configure_cuda(monkeypatch)
    service = build_service()

    segments, _info = service.transcribe_segments("audio")
    next_segments, _next_info = service.transcribe_segments("next-audio")

    assert [segment.text for segment in segments] == ["transcript"]
    assert [segment.text for segment in next_segments] == ["transcript"]
    assert created == ["cuda", "cpu"]
    assert gpu_model.calls == 1
    assert cpu_model.calls == 2
    assert service.whisper_runtime_status()["fallback_reason"] == (
        "cuda_inference_failed"
    )


def test_successful_gpu_transcription_remains_on_gpu(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gpu_model = TranscriptModel(successful_transcript)
    monkeypatch.setattr(
        transcription,
        "WhisperModel",
        lambda _model_name, *, device, compute_type: gpu_model,
    )
    configure_cuda(monkeypatch)
    service = build_service()

    segments, _info = service.transcribe_segments("audio")

    assert [segment.text for segment in segments] == ["transcript"]
    assert service.whisper_device == "cuda"
    assert service.whisper_compute_type == "float16"
    assert service.whisper_fallback_reason is None


def test_failed_cpu_retry_propagates_without_another_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gpu_model = TranscriptModel(RuntimeError("GPU failed"))
    cpu_model = TranscriptModel(RuntimeError("CPU failed"))

    def whisper_model(_model_name: str, *, device: str, compute_type: str):
        return gpu_model if device == "cuda" else cpu_model

    monkeypatch.setattr(transcription, "WhisperModel", whisper_model)
    configure_cuda(monkeypatch)
    service = build_service()

    with pytest.raises(RuntimeError, match="CPU failed"):
        service.transcribe_segments("audio")

    assert gpu_model.calls == 1
    assert cpu_model.calls == 1


def test_status_includes_safe_whisper_runtime_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeWhisperModel.calls.clear()
    monkeypatch.setattr(transcription, "WhisperModel", FakeWhisperModel)
    configure_cuda(monkeypatch, device_count=0)
    service = build_service()
    monkeypatch.setattr(backend_app, "service", service)
    monkeypatch.setattr(
        backend_app, "application_settings", SimpleNamespace(auth_enabled=False)
    )
    monkeypatch.setattr(backend_app, "meeting_repository", object())

    status = asyncio.run(backend_app.get_status())

    assert status["whisper"] == {
        "model": "base.en",
        "provider": "huggingface",
        "state": "ready",
        "progress": None,
        "error": None,
        "device": "cpu",
        "compute_type": "int8",
        "requested_device": "auto",
        "fallback_reason": "cuda_not_detected",
    }
