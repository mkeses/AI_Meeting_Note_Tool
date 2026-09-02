from types import SimpleNamespace

import httpx
import pytest
from openai import APIStatusError, AuthenticationError, NotFoundError

from llm import (
    MEETING_NOTES_MAX_TOKENS,
    SYSTEM_PROMPT,
    MeetingIntelligenceError,
    OpenAICompatibleMeetingIntelligence,
)
from transcription import TranscriptionService


class FakeCompletions:
    def __init__(self, result: object = None, error: Exception | None = None) -> None:
        self.result = result
        self.error = error
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.result


class FakeClient:
    def __init__(self, result: object = None, error: Exception | None = None) -> None:
        self.completions = FakeCompletions(result, error)
        self.chat = SimpleNamespace(completions=self.completions)


def completion(content: object) -> object:
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
    )


def provider_with_client(client: FakeClient) -> OpenAICompatibleMeetingIntelligence:
    return OpenAICompatibleMeetingIntelligence(
        base_url="https://provider.example.test/v1",
        api_key="server-side-key",
        model="meeting-model",
        timeout_seconds=12.5,
        client=client,
    )


def test_openai_compatible_provider_preserves_the_existing_request_contract() -> None:
    client = FakeClient(completion("  ## Meeting Overview\nNotes  "))
    provider = provider_with_client(client)

    cleaned = provider.clean("Raw transcript", meeting_type="standup")

    assert cleaned == "## Meeting Overview\nNotes"
    assert client.completions.calls == [
        {
            "model": "meeting-model",
            "messages": [
                {
                    "role": "system",
                    "content": provider.build_prompt(SYSTEM_PROMPT, "standup"),
                },
                {"role": "user", "content": "Transcript:\nRaw transcript"},
            ],
            "temperature": 0.2,
            "max_tokens": MEETING_NOTES_MAX_TOKENS,
        }
    ]


def provider_error(message: str, status_code: int) -> APIStatusError:
    request = httpx.Request("POST", "https://provider.example.test/v1/chat")
    response = httpx.Response(status_code, request=request)
    return APIStatusError(message, response=response, body=None)


@pytest.mark.parametrize(
    ("error", "expected_message"),
    [
        (ConnectionError("provider unavailable"), "provider is unavailable"),
        (TimeoutError("timed out"), "timed out"),
        (
            AuthenticationError(
                "server-side-key rejected",
                response=httpx.Response(
                    401,
                    request=httpx.Request(
                        "POST", "https://provider.example.test/v1/chat"
                    ),
                ),
                body=None,
            ),
            "authentication failed",
        ),
        (
            NotFoundError(
                "meeting-model missing",
                response=httpx.Response(
                    404,
                    request=httpx.Request(
                        "POST", "https://provider.example.test/v1/chat"
                    ),
                ),
                body=None,
            ),
            "model is unavailable",
        ),
        (provider_error("invalid upstream response", 500), "request failed"),
        (RuntimeError("unexpected provider failure"), "Meeting intelligence failed"),
    ],
)
def test_provider_errors_are_translated_without_sensitive_details(
    error: Exception,
    expected_message: str,
) -> None:
    provider = provider_with_client(FakeClient(error=error))

    with pytest.raises(MeetingIntelligenceError, match=expected_message) as raised:
        provider.clean("Sensitive transcript")

    assert "Sensitive transcript" not in str(raised.value)
    assert "server-side-key" not in str(raised.value)


@pytest.mark.parametrize(
    "result",
    [
        SimpleNamespace(choices=[]),
        completion(None),
        completion("   "),
    ],
)
def test_provider_rejects_malformed_or_empty_responses(result: object) -> None:
    provider = provider_with_client(FakeClient(result=result))

    with pytest.raises(MeetingIntelligenceError) as raised:
        provider.clean("Sensitive transcript")

    assert "Sensitive transcript" not in str(raised.value)


def test_transcribe_file_preserves_raw_text_when_cleanup_fails() -> None:
    service = object.__new__(TranscriptionService)
    service.transcribe = lambda _audio_file: "Raw transcript"
    service.llm_provider = SimpleNamespace(
        clean=lambda *_args: (_ for _ in ()).throw(
            MeetingIntelligenceError("Meeting intelligence provider is unavailable")
        )
    )

    result = service.transcribe_file("recording.webm")

    assert result == {
        "raw_text": "Raw transcript",
        "cleaned_text": "Raw transcript",
        "cleanup_error": "Meeting intelligence provider is unavailable",
    }


def test_transcribe_file_keeps_successful_cleanup_unchanged() -> None:
    service = object.__new__(TranscriptionService)
    service.transcribe = lambda _audio_file: "Raw transcript"
    service.llm_provider = SimpleNamespace(clean=lambda *_args: "Cleaned notes")

    assert service.transcribe_file("recording.webm") == {
        "raw_text": "Raw transcript",
        "cleaned_text": "Cleaned notes",
    }
