"""Provider boundary for meeting intelligence generation."""

from pathlib import Path
from typing import Protocol

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AuthenticationError,
    NotFoundError,
    OpenAI,
)

PROMPT_FILE = Path(__file__).parent / "system_prompt.txt"
SYSTEM_PROMPT = PROMPT_FILE.read_text().strip()
MEETING_NOTES_MAX_TOKENS = 1200


class MeetingIntelligenceError(RuntimeError):
    """A stable, safe failure from a meeting-intelligence provider."""


class MeetingIntelligenceProvider(Protocol):
    def clean(
        self,
        text: str,
        system_prompt: str | None = None,
        meeting_type: str = "general",
    ) -> str: ...


class OpenAICompatibleMeetingIntelligence:
    """OpenAI-compatible implementation, including Ollama support."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None,
        model: str,
        timeout_seconds: float = 30.0,
        client: OpenAI | None = None,
    ) -> None:
        self.client = client or OpenAI(
            base_url=base_url,
            api_key=api_key or "ollama",
            timeout=timeout_seconds,
        )
        self.model = model
        if client is None:
            try:
                self.client.models.list()
                print("Connected to LLM API!")
            except Exception:
                print(
                    "LLM provider is unavailable at startup; cleanup will be unavailable"
                )

    @staticmethod
    def build_prompt(base_prompt: str, meeting_type: str) -> str:
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

    def clean(
        self,
        text: str,
        system_prompt: str | None = None,
        meeting_type: str = "general",
    ) -> str:
        if not text:
            return ""
        prompt = self.build_prompt(system_prompt or SYSTEM_PROMPT, meeting_type)
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": f"Transcript:\n{text}"},
                ],
                temperature=0.2,
                max_tokens=MEETING_NOTES_MAX_TOKENS,
            )
        except (APITimeoutError, TimeoutError) as error:
            raise MeetingIntelligenceError("Meeting intelligence timed out") from error
        except AuthenticationError as error:
            raise MeetingIntelligenceError(
                "Meeting intelligence authentication failed"
            ) from error
        except NotFoundError as error:
            raise MeetingIntelligenceError(
                "Configured LLM model is unavailable"
            ) from error
        except (APIConnectionError, ConnectionError) as error:
            raise MeetingIntelligenceError(
                "Meeting intelligence provider is unavailable"
            ) from error
        except APIStatusError as error:
            raise MeetingIntelligenceError(
                "Meeting intelligence provider request failed"
            ) from error
        except Exception as error:
            raise MeetingIntelligenceError("Meeting intelligence failed") from error

        try:
            content = response.choices[0].message.content
        except (AttributeError, IndexError, TypeError) as error:
            raise MeetingIntelligenceError(
                "Meeting intelligence provider returned an invalid response"
            ) from error

        if not isinstance(content, str) or not content.strip():
            raise MeetingIntelligenceError(
                "Meeting intelligence provider returned no meeting notes"
            )
        return content.strip()
