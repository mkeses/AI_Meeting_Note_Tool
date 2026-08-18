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


class TranscriptionService:
    def __init__(
        self, whisper_model: str, llm_base_url: str, llm_api_key: str, llm_model: str
    ):
        print(f"🔄 Loading Whisper model '{whisper_model}'...")

        self.whisper_device = "cpu"
        self.whisper_compute_type = "int8"

        try:
            self.whisper = WhisperModel(
                whisper_model,
                device="cuda",
                compute_type="float16",
            )
            self.whisper_device = "cuda"
            self.whisper_compute_type = "float16"
            print("✅ Faster-Whisper loaded with CUDA (float16)")
        except Exception as gpu_error:
            print(f"⚠️ CUDA Whisper load failed: {gpu_error}")
            print("↩️ Falling back to CPU Whisper (int8)...")

            self.whisper = WhisperModel(
                whisper_model,
                device="cpu",
                compute_type="int8",
            )
            self.whisper_device = "cpu"
            self.whisper_compute_type = "int8"
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
Meeting type: General engineering meeting.

Produce output with exactly these sections:
1. Summary
2. Key decisions
3. Action items
4. Open questions

Rules:
- Use bullet points under each section.
- Keep points specific and concise.
- Only include information supported by the transcript.
- If no items exist for a section, write "None noted."
- For action items, include owner and deadline when mentioned.
- If owner or deadline is missing, say "owner not specified" or "deadline not specified".
""".strip(),
            "design_review": """
Meeting type: Design review.

Produce output with exactly these sections:
1. Design under review
2. Decisions made
3. Tradeoffs and constraints
4. Risks
5. Open technical questions
6. Action items

Rules:
- Use bullet points under each section.
- Focus on architecture, implementation choices, and technical reasoning.
- Do not include filler or small talk.
- Do not guess missing details.
- If no items exist for a section, write "None noted."
""".strip(),
            "debug_sync": """
Meeting type: Debug sync.

Produce output with exactly these sections:
1. Problem being investigated
2. Suspected causes
3. Evidence and tests run
4. Blockers
5. Next debugging steps
6. Action items

Rules:
- Use bullet points under each section.
- Focus on root cause analysis and concrete next steps.
- Do not include filler or repeated discussion.
- Do not guess missing technical details.
- If no items exist for a section, write "None noted."
""".strip(),
            "standup": """
Meeting type: Standup.

Produce output with exactly these sections:
1. Progress updates
2. Current priorities
3. Blockers
4. Action items

Rules:
- Use bullet points under each section.
- Keep the summary brief and operational.
- If speakers are identifiable, group updates by person.
- If speakers are not identifiable, summarize without guessing names.
- For action items, include owner and deadline when mentioned.
- If no items exist for a section, write "None noted."
""".strip(),
        }

        extra = meeting_instructions.get(meeting_type, meeting_instructions["general"])
        return f"{base_prompt}\n\nAdditional instructions:\n{extra}"

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
            max_tokens=400,
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
