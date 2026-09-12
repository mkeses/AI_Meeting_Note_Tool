#!/usr/bin/env python3
"""
Uses OpenAI API format, compatible with Ollama, OpenAI, LM Studio, and other providers.
Configuration is loaded from .env file.
"""

import os
from threading import Lock

import ctranslate2
from faster_whisper import WhisperModel

from llm import (
    SYSTEM_PROMPT,
    MeetingIntelligenceError,
    MeetingIntelligenceProvider,
    OpenAICompatibleMeetingIntelligence,
)
from model_provisioning import whisper_failed_status, whisper_ready_status

WHISPER_DEVICE_AUTO = "auto"
WHISPER_DEVICE_CUDA = "cuda"
WHISPER_DEVICE_CPU = "cpu"
WHISPER_CUDA_COMPUTE_TYPE = "float16"
WHISPER_CPU_COMPUTE_TYPE = "int8"

CUDA_NOT_DETECTED = "cuda_not_detected"
CUDA_CAPABILITY_UNSUPPORTED = "cuda_capability_unsupported"
CUDA_RUNTIME_UNAVAILABLE = "cuda_runtime_unavailable"
CUDA_INITIALIZATION_FAILED = "cuda_initialization_failed"
CUDA_INFERENCE_FAILED = "cuda_inference_failed"


def cuda_availability() -> tuple[bool, str | None]:
    """Return whether CTranslate2 can attempt CUDA without exposing internals."""
    try:
        if ctranslate2.get_cuda_device_count() < 1:
            return False, CUDA_NOT_DETECTED
    except Exception:
        return False, CUDA_RUNTIME_UNAVAILABLE

    try:
        compute_types = ctranslate2.get_supported_compute_types("cuda")
    except Exception:
        return False, CUDA_RUNTIME_UNAVAILABLE

    if WHISPER_CUDA_COMPUTE_TYPE not in compute_types:
        return False, CUDA_CAPABILITY_UNSUPPORTED

    return True, None


class TranscriptionService:
    def __init__(
        self,
        whisper_model: str,
        llm_base_url: str,
        llm_api_key: str | None,
        llm_model: str,
        whisper_device: str = WHISPER_DEVICE_AUTO,
        llm_timeout_seconds: float = 30.0,
        ollama_model_directory: str | None = None,
        llm_provider: MeetingIntelligenceProvider | None = None,
    ):
        print(f"Loading Whisper model '{whisper_model}'...")

        if whisper_device not in {
            WHISPER_DEVICE_AUTO,
            WHISPER_DEVICE_CUDA,
            WHISPER_DEVICE_CPU,
        }:
            raise ValueError("Unsupported Whisper device preference")

        self.whisper_model = whisper_model
        self.whisper_requested_device = whisper_device
        self.whisper_device = WHISPER_DEVICE_CPU
        self.whisper_compute_type = WHISPER_CPU_COMPUTE_TYPE
        self.whisper_fallback_reason: str | None = None
        self._whisper_runtime_lock = Lock()

        self._initialize_whisper_runtime()
        self.whisper_model_status = whisper_ready_status(
            whisper_model, os.getenv("HF_HOME")
        )

        print(
            f"Whisper model '{whisper_model}' loaded on {self.whisper_device} "
            f"with compute_type={self.whisper_compute_type}"
        )

        print("Connecting to LLM provider...")
        self.llm_provider = llm_provider or OpenAICompatibleMeetingIntelligence(
            base_url=llm_base_url,
            api_key=llm_api_key,
            model=llm_model,
            timeout_seconds=llm_timeout_seconds,
            model_storage_location=ollama_model_directory,
        )

    def _load_whisper_model(self, device: str, compute_type: str) -> None:
        self.whisper = WhisperModel(
            self.whisper_model,
            device=device,
            compute_type=compute_type,
        )
        self.whisper_device = device
        self.whisper_compute_type = compute_type

    def _initialize_cpu_whisper(self) -> None:
        try:
            self._load_whisper_model(WHISPER_DEVICE_CPU, WHISPER_CPU_COMPUTE_TYPE)
        except Exception as error:
            self.whisper_model_status = whisper_failed_status(
                self.whisper_model,
                "Whisper model is unavailable",
                os.getenv("HF_HOME"),
            )
            raise RuntimeError(
                f"Whisper model '{self.whisper_model}' is unavailable"
            ) from error

    def _initialize_whisper_runtime(self) -> None:
        if self.whisper_requested_device != WHISPER_DEVICE_CPU:
            cuda_available, fallback_reason = cuda_availability()
            if cuda_available:
                try:
                    self._load_whisper_model(
                        WHISPER_DEVICE_CUDA, WHISPER_CUDA_COMPUTE_TYPE
                    )
                    return
                except Exception:
                    self.whisper_fallback_reason = CUDA_INITIALIZATION_FAILED
            else:
                self.whisper_fallback_reason = fallback_reason

            print("Faster-Whisper CUDA is unavailable; using the CPU/int8 fallback.")

        self._initialize_cpu_whisper()

    def _activate_cpu_fallback(self, fallback_reason: str) -> None:
        with self._whisper_runtime_lock:
            if self.whisper_device == WHISPER_DEVICE_CUDA:
                self.whisper_fallback_reason = fallback_reason
                self._initialize_cpu_whisper()

    def whisper_runtime_status(self) -> dict[str, str | None]:
        return {
            "device": self.whisper_device,
            "compute_type": self.whisper_compute_type,
            "requested_device": self.whisper_requested_device,
            "fallback_reason": self.whisper_fallback_reason,
        }

    def transcribe_segments(self, audio_file, **kwargs):
        """Run one transcription, falling back from CUDA to CPU once if needed."""
        attempted_device = self.whisper_device
        try:
            segments, info = self.whisper.transcribe(audio_file, **kwargs)
            return list(segments), info
        except Exception:
            if attempted_device != WHISPER_DEVICE_CUDA:
                raise

            self._activate_cpu_fallback(CUDA_INFERENCE_FAILED)
            segments, info = self.whisper.transcribe(audio_file, **kwargs)
            return list(segments), info

    def transcribe(self, audio_file):
        print(
            f"Transcribing with Faster-Whisper "
            f"({self.whisper_device}, {self.whisper_compute_type})..."
        )

        segments, info = self.transcribe_segments(
            audio_file,
            beam_size=5,
            language="en",
            condition_on_previous_text=False,
            vad_filter=True,
        )

        text = " ".join(segment.text for segment in segments).strip()
        print(
            f"Detected language: {info.language} "
            f"(p={info.language_probability:.2f})"
        )
        return text

    def get_default_system_prompt(self):
        return SYSTEM_PROMPT

    def build_meeting_prompt(self, base_prompt: str, meeting_type: str) -> str:
        return OpenAICompatibleMeetingIntelligence.build_prompt(
            base_prompt, meeting_type
        )

    def clean_with_llm(self, text, system_prompt=None, meeting_type="general"):
        print("Cleaning with LLM...")
        try:
            return self.llm_provider.clean(text, system_prompt, meeting_type)
        except MeetingIntelligenceError:
            raise
        except Exception as error:
            raise MeetingIntelligenceError("Meeting intelligence failed") from error

    def transcribe_file(self, audio_file_path: str, use_llm: bool = True) -> dict:
        raw_text = self.transcribe(audio_file_path)

        result = {"raw_text": raw_text}

        if use_llm and raw_text:
            try:
                result["cleaned_text"] = self.clean_with_llm(raw_text)
            except MeetingIntelligenceError as error:
                result["cleaned_text"] = raw_text
                result["cleanup_error"] = str(error)
        else:
            result["cleaned_text"] = raw_text

        return result
