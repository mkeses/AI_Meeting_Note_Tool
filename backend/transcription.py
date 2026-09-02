#!/usr/bin/env python3
"""
Uses OpenAI API format, compatible with Ollama, OpenAI, LM Studio, and other providers.
Configuration is loaded from .env file.
"""

from pathlib import Path

from faster_whisper import WhisperModel
from openai import OpenAI

PROMPT_FILE = Path(__file__).parent / "system_prompt.txt"
SYSTEM_PROMPT = PROMPT_FILE.read_text().strip()
MEETING_NOTES_MAX_TOKENS = 1200


class TranscriptionService:
    def __init__(
        self, whisper_model: str, llm_base_url: str, llm_api_key: str, llm_model: str
    ):
        print(f"🔄 Loading Whisper model '{whisper_model}'...")

        self.whisper_device = "cpu"
        self.whisper_compute_type = "int8"
        self.whisper = WhisperModel(
            whisper_model,
            device="cpu",
            compute_type="int8",
        )
        print("✅ Faster-Whisper loaded on CPU (int8)")

        print(
            f"✅ Whisper model '{whisper_model}' loaded on {self.whisper_device} "
            f"with compute_type={self.whisper_compute_type}"
        )

        print(f"🔄 Connecting to LLM at {llm_base_url}...")
        self.llm_client = OpenAI(base_url=llm_base_url, api_key=llm_api_key)
        self.llm_model = llm_model

        try:
            self.llm_client.models.list()
            print("✅ Connected to LLM API!")
        except Exception as e:
            print(f"⚠️  Warning: Could not connect to LLM: {e}")
            print(f"   Make sure your LLM server is running at {llm_base_url}")

    def transcribe(self, audio_file):
        print(
            f"🔄 Transcribing with Faster-Whisper "
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
            f"📝 Detected language: {info.language} "
            f"(p={info.language_probability:.2f})"
        )
        print(f"📝 Raw: {text}")
        return text

    def get_default_system_prompt(self):
        return SYSTEM_PROMPT

    def build_meeting_prompt(self, base_prompt: str, meeting_type: str) -> str:
        meeting_instructions = {
            "general": """
Meeting type context: General meeting.

Use balanced coverage of purpose, discussion, conclusions, decisions, action
items, open questions, risks, and important details. Keep the common output
structure.
""".strip(),
            "design_review": """
Meeting type context: Design review.

Give particular attention to alternatives, tradeoffs, constraints, risks,
decisions, and important technical details. Keep the common output structure.
""".strip(),
            "debug_sync": """
Meeting type context: Debug sync.

Give particular attention to the problem, evidence, hypotheses, tests,
blockers, and next steps. Keep the common output structure.
""".strip(),
            "standup": """
Meeting type context: Standup.

Give particular attention to progress, priorities, blockers, and action items.
Group updates by person only when speakers are explicitly identifiable. Keep the
common output structure.
""".strip(),
        }

        extra = meeting_instructions.get(meeting_type, meeting_instructions["general"])
        return f"{base_prompt}\n\nMeeting-type emphasis:\n{extra}"

    def clean_with_llm(self, text, system_prompt=None, meeting_type="general"):
        if not text:
            return ""

        prompt_to_use = system_prompt if system_prompt else SYSTEM_PROMPT
        prompt_to_use = self.build_meeting_prompt(prompt_to_use, meeting_type)

        print("FINAL PROMPT:\n", prompt_to_use)
        print("🤖 Cleaning with LLM...")

        response = self.llm_client.chat.completions.create(
            model=self.llm_model,
            messages=[
                {"role": "system", "content": prompt_to_use},
                {"role": "user", "content": f"Transcript:\n{text}"},
            ],
            temperature=0.2,
            max_tokens=MEETING_NOTES_MAX_TOKENS,
        )

        cleaned = response.choices[0].message.content.strip()
        print(f"✨ Cleaned: {cleaned}")
        return cleaned

    def transcribe_file(self, audio_file_path: str, use_llm: bool = True) -> dict:
        raw_text = self.transcribe(audio_file_path)

        result = {"raw_text": raw_text}

        if use_llm and raw_text:
            cleaned_text = self.clean_with_llm(raw_text)
            result["cleaned_text"] = cleaned_text
        else:
            result["cleaned_text"] = raw_text

        return result
