#!/usr/bin/env python3
"""
Uses OpenAI API format, compatible with Ollama, OpenAI, LM Studio, and other providers.
Configuration is loaded from .env file.
"""

from faster_whisper import WhisperModel

from llm import (
    SYSTEM_PROMPT,
    MeetingIntelligenceError,
    MeetingIntelligenceProvider,
    OpenAICompatibleMeetingIntelligence,
)


class TranscriptionService:
    def __init__(
        self,
        whisper_model: str,
        llm_base_url: str,
        llm_api_key: str | None,
        llm_model: str,
        llm_timeout_seconds: float = 30.0,
        llm_provider: MeetingIntelligenceProvider | None = None,
    ):
        print(f"Loading Whisper model '{whisper_model}'...")

        self.whisper_device = "cpu"
        self.whisper_compute_type = "int8"
        self.whisper = WhisperModel(
            whisper_model,
            device="cpu",
            compute_type="int8",
        )
        print("Faster-Whisper loaded on CPU (int8)")

        print(
            f"Whisper model '{whisper_model}' loaded on {self.whisper_device} "
            f"with compute_type={self.whisper_compute_type}"
        )

        print(f"Connecting to LLM at {llm_base_url}...")
        self.llm_provider = llm_provider or OpenAICompatibleMeetingIntelligence(
            base_url=llm_base_url,
            api_key=llm_api_key,
            model=llm_model,
            timeout_seconds=llm_timeout_seconds,
        )

    def transcribe(self, audio_file):
        print(
            f"Transcribing with Faster-Whisper "
            f"({self.whisper_device}, {self.whisper_compute_type})..."
        )

        segments, info = self.whisper.transcribe(
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
