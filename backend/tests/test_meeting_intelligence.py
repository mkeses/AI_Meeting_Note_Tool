import pytest

from llm import MEETING_NOTES_MAX_TOKENS, OpenAICompatibleMeetingIntelligence
from transcription import (
    SYSTEM_PROMPT,
    TranscriptionService,
)

MEETING_TRANSCRIPTS = {
    "normal_conclusion": (
        "The group reviewed the customer onboarding delays. After comparing "
        "the two options, they agreed to simplify the approval step."
    ),
    "explicit_decision": (
        "We decided to use the revised onboarding flow for the October release."
    ),
    "action_items": (
        "John will update the rollout checklist by Friday. Someone should "
        "prepare the customer announcement next week."
    ),
    "open_question": (
        "We still do not know whether the legal review can finish before launch."
    ),
    "important_details": (
        "The budget is capped at $50,000, and the pilot starts on October 15 "
        "with 12 customers."
    ),
    "proposal_not_decision": (
        "Priya suggested moving the launch to November, but the group did not "
        "make a decision."
    ),
    "missing_owner_and_deadline": (
        "Someone needs to verify the contract terms before the next review."
    ),
    "filler_and_repetition": (
        "Um, so, as I said earlier, the migration is delayed. Right, the "
        "migration is delayed because the vendor data is incomplete."
    ),
    "no_decisions_or_actions": (
        "The team shared research findings and agreed that more discussion is "
        "needed. No tasks or decisions were assigned."
    ),
    "long_conversation": (
        "Maya described the support team's repeated customer complaints about "
        "slow reports. Leo presented evidence from 47 support tickets and noted "
        "that the delay appears after data imports larger than 2 GB. The group "
        "considered indexing and scheduled reports, but agreed that more load "
        "testing is needed before choosing an approach. Maya will coordinate a "
        "test plan with support by next Tuesday. The remaining question is "
        "whether the current hosting plan can support the projected volume."
    ),
}

POLICY_ADDENDUM_DISCUSSION = (
    "The committee discussed adding a remote-work exception to the policy "
    "addendum. Olivia recommended the exception, and the group began weighing "
    "its scope. The transcript ends before the committee reaches a decision."
)


class FakeMeetingIntelligence:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def clean(
        self,
        text: str,
        system_prompt: str | None = None,
        meeting_type: str = "general",
    ) -> str:
        self.calls.append(
            {
                "model": "test-ollama-model",
                "messages": [
                    {
                        "role": "system",
                        "content": OpenAICompatibleMeetingIntelligence.build_prompt(
                            system_prompt or SYSTEM_PROMPT, meeting_type
                        ),
                    },
                    {"role": "user", "content": f"Transcript:\n{text}"},
                ],
                "temperature": 0.2,
                "max_tokens": MEETING_NOTES_MAX_TOKENS,
            }
        )
        return "## Meeting Overview\nNotes"


@pytest.fixture
def service() -> TranscriptionService:
    service = object.__new__(TranscriptionService)
    service.llm_provider = FakeMeetingIntelligence()
    return service


def test_default_prompt_defines_the_general_meeting_notes_contract() -> None:
    expected_sections = [
        "## Meeting Overview",
        "## Key Discussion Points",
        "## Decisions",
        "## Action Items",
        "## Open Questions",
        "## Blockers / Risks",
        "## Important Details",
    ]

    for section in expected_sections:
        assert section in SYSTEM_PROMPT

    normalized_prompt = " ".join(SYSTEM_PROMPT.split())

    assert "## Technical Terms" not in SYSTEM_PROMPT
    assert "discussion, not a decision" in normalized_prompt
    assert "Owner not specified" in SYSTEM_PROMPT
    assert "No deadline mentioned" in SYSTEM_PROMPT


def test_unfinished_policy_addendum_discussion_cannot_be_reported_as_a_decision(
    service: TranscriptionService,
) -> None:
    prompt = service.build_meeting_prompt(SYSTEM_PROMPT, "general")
    normalized_prompt = " ".join(prompt.split())

    assert (
        "recommendations, and an apparent direction as discussion, not a decision"
        in normalized_prompt
    )
    assert (
        "If the transcript ends while an item is still being discussed, do not "
        "infer any later outcome" in normalized_prompt
    )
    assert (
        "Do not assign an owner or deadline unless the transcript explicitly "
        "states it." in normalized_prompt
    )

    service.clean_with_llm(POLICY_ADDENDUM_DISCUSSION, meeting_type="general")

    call = service.llm_provider.calls[-1]
    assert call["messages"][-1] == {
        "role": "user",
        "content": f"Transcript:\n{POLICY_ADDENDUM_DISCUSSION}",
    }


@pytest.mark.parametrize(
    ("meeting_type", "expected_emphasis"),
    [
        ("general", "balanced coverage"),
        ("design_review", "alternatives, tradeoffs, constraints, risks"),
        ("debug_sync", "problem, evidence, hypotheses, tests"),
        ("standup", "progress, priorities, blockers, and action items"),
    ],
)
def test_meeting_type_adds_emphasis_without_replacing_the_core_contract(
    service: TranscriptionService,
    meeting_type: str,
    expected_emphasis: str,
) -> None:
    prompt = service.build_meeting_prompt(SYSTEM_PROMPT, meeting_type)

    assert prompt.startswith(SYSTEM_PROMPT)
    assert "Meeting-type emphasis:" in prompt
    assert expected_emphasis in prompt
    assert "Keep the common output structure." in " ".join(prompt.split())

    for section in (
        "## Meeting Overview",
        "## Key Discussion Points",
        "## Decisions",
        "## Action Items",
        "## Open Questions",
        "## Blockers / Risks",
        "## Important Details",
    ):
        assert prompt.count(section) == 1


def test_unknown_meeting_type_uses_general_emphasis(
    service: TranscriptionService,
) -> None:
    prompt = service.build_meeting_prompt(SYSTEM_PROMPT, "unknown")

    assert "Meeting type context: General meeting." in prompt
    assert "balanced coverage" in prompt


@pytest.mark.parametrize("transcript", MEETING_TRANSCRIPTS.values())
def test_clean_with_llm_uses_the_shared_contract_for_representative_meetings(
    service: TranscriptionService,
    transcript: str,
) -> None:
    cleaned = service.clean_with_llm(transcript, meeting_type="general")

    assert cleaned == "## Meeting Overview\nNotes"

    call = service.llm_provider.calls[-1]
    assert call["model"] == "test-ollama-model"
    assert call["temperature"] == 0.2
    assert call["max_tokens"] == MEETING_NOTES_MAX_TOKENS == 1200
    assert call["messages"] == [
        {
            "role": "system",
            "content": service.build_meeting_prompt(SYSTEM_PROMPT, "general"),
        },
        {"role": "user", "content": f"Transcript:\n{transcript}"},
    ]


def test_clean_with_llm_keeps_custom_prompt_support(
    service: TranscriptionService,
) -> None:
    custom_prompt = "Preserve this user-provided instruction."

    service.clean_with_llm(
        MEETING_TRANSCRIPTS["normal_conclusion"],
        system_prompt=custom_prompt,
        meeting_type="standup",
    )

    system_message = service.llm_provider.calls[-1]["messages"][0]
    assert system_message == {
        "role": "system",
        "content": service.build_meeting_prompt(custom_prompt, "standup"),
    }
