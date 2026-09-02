import asyncio
import json
from collections.abc import Sequence
from types import SimpleNamespace

import numpy as np
import pytest

import app as backend_app


class FakeWebSocket:
    """Minimal WebSocket boundary for deterministic handler tests."""

    def __init__(self, messages: Sequence[dict[str, object]]):
        self._messages = iter(messages)
        self.accepted = False
        self.closed: tuple[int, str] | None = None
        self.peer_disconnected = False
        self.sent_messages: list[dict[str, object]] = []

    async def accept(self) -> None:
        self.accepted = True

    async def receive(self) -> dict[str, object]:
        await asyncio.sleep(0)

        try:
            message = next(self._messages)
        except StopIteration:
            self.peer_disconnected = True
            return {"type": "websocket.disconnect"}

        if message.get("type") == "websocket.disconnect":
            self.peer_disconnected = True

        return message

    async def send_json(self, message: dict[str, object]) -> None:
        if self.peer_disconnected:
            raise backend_app.WebSocketDisconnect()

        self.sent_messages.append(message)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)


def start_message() -> dict[str, object]:
    return {
        "text": json.dumps(
            {
                "type": "start",
                "sample_rate": 48_000,
                "channels": 1,
                "include_microphone": True,
                "language": "en",
            }
        )
    }


def stop_message() -> dict[str, object]:
    return {"text": json.dumps({"type": "stop"})}


def audio_message(data: bytes) -> dict[str, object]:
    return {"bytes": data}


def run_websocket(messages: Sequence[dict[str, object]]) -> FakeWebSocket:
    websocket = FakeWebSocket(messages)
    asyncio.run(backend_app.transcribe_websocket(websocket))
    return websocket


def word(start: float, end: float, text: str) -> dict[str, float | str]:
    return {"start": start, "end": end, "text": text}


def transcript_messages(websocket: FakeWebSocket) -> list[dict[str, object]]:
    return [
        message
        for message in websocket.sent_messages
        if message["type"] == "transcript"
    ]


@pytest.fixture(autouse=True)
def configured_service(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep tests at the handler boundary without loading local AI models."""
    monkeypatch.setattr(backend_app, "service", object())
    monkeypatch.setattr(
        backend_app,
        "application_settings",
        SimpleNamespace(auth_enabled=False),
    )


def test_chunk_has_speech_uses_pcm_rms_threshold() -> None:
    silence = np.zeros(16, dtype=np.int16).tobytes()
    quiet = np.full(16, 349, dtype=np.int16).tobytes()
    threshold = np.full(16, 350, dtype=np.int16).tobytes()

    assert not backend_app.chunk_has_speech(b"")
    assert not backend_app.chunk_has_speech(silence)
    assert not backend_app.chunk_has_speech(quiet)
    assert backend_app.chunk_has_speech(threshold)


def test_live_transcription_emits_provisional_text_then_final_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def transcribe_window(
        _audio_chunks: list[bytes],
    ) -> tuple[list[dict[str, float | str]], list[dict[str, float | str]]]:
        return (
            [{"start": 0.0, "end": 0.4, "text": "alpha beta"}],
            [word(0.0, 0.2, "alpha"), word(0.2, 0.4, "beta")],
        )

    async def transcribe_final(_audio_chunks: list[bytes]) -> str:
        return "alpha beta"

    monkeypatch.setattr(backend_app, "LIVE_TRIGGER_BYTES", 1)
    monkeypatch.setattr(backend_app, "chunk_has_speech", lambda _chunk: True)
    monkeypatch.setattr(backend_app, "transcribe_chunk_words", transcribe_window)
    monkeypatch.setattr(backend_app, "transcribe_chunks", transcribe_final)

    websocket = run_websocket(
        [
            start_message(),
            audio_message(b"speech"),
            {"text": json.dumps({"type": "ignored"})},
            stop_message(),
        ]
    )

    assert websocket.accepted
    assert websocket.sent_messages == [
        {"type": "ready", "message": "Live transcription is ready"},
        {
            "type": "transcript",
            "committed_text": "",
            "partial_text": "alpha beta",
            "segments": [{"start": 0.0, "end": 0.4, "text": "alpha beta"}],
        },
        {
            "type": "final",
            "text": "alpha beta",
            "committed_text": "alpha beta",
            "partial_text": "",
        },
    ]
    assert websocket.closed == (1000, "Final transcript sent")


def test_oversized_audio_frame_is_closed_without_transcription(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(backend_app, "MAX_WEBSOCKET_AUDIO_CHUNK_BYTES", 4)

    websocket = run_websocket([start_message(), audio_message(b"oversized")])

    assert websocket.accepted
    assert websocket.closed == (1009, "WebSocket message too large")
    assert websocket.sent_messages == [
        {"type": "ready", "message": "Live transcription is ready"}
    ]


def test_pause_commits_only_new_words_from_an_overlapping_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recognition_results = iter(
        [
            (
                [],
                [word(0.0, 0.2, "alpha"), word(0.3, 0.4, "beta")],
            ),
            (
                [],
                [
                    word(0.0, 0.2, "alpha"),
                    word(0.3, 0.4, "beta"),
                    word(0.4, 0.6, "gamma"),
                ],
            ),
        ]
    )

    async def transcribe_window(
        _audio_chunks: list[bytes],
    ) -> tuple[list[dict[str, float | str]], list[dict[str, float | str]]]:
        return next(recognition_results)

    async def transcribe_final(_audio_chunks: list[bytes]) -> str:
        return "alpha beta gamma"

    monkeypatch.setattr(backend_app, "BYTES_PER_SECOND", 10)
    monkeypatch.setattr(backend_app, "LIVE_TRIGGER_BYTES", 10_000)
    monkeypatch.setattr(backend_app, "PAUSE_FLUSH_CHUNKS", 1)
    monkeypatch.setattr(backend_app, "LONG_PAUSE_FLUSH_CHUNKS", 10)
    monkeypatch.setattr(backend_app, "MIN_COMMIT_BYTES", 1)
    monkeypatch.setattr(backend_app, "OVERLAP_BYTES", 4)
    monkeypatch.setattr(
        backend_app,
        "chunk_has_speech",
        lambda chunk: chunk.startswith(b"speech"),
    )
    monkeypatch.setattr(backend_app, "transcribe_chunk_words", transcribe_window)
    monkeypatch.setattr(backend_app, "transcribe_chunks", transcribe_final)

    websocket = run_websocket(
        [
            start_message(),
            audio_message(b"speech-a"),
            audio_message(b"silence-a"),
            {"text": json.dumps({"type": "ignored"})},
            audio_message(b"speech-b"),
            audio_message(b"silence-b"),
            {"text": json.dumps({"type": "ignored"})},
            stop_message(),
        ]
    )

    assert transcript_messages(websocket) == [
        {
            "type": "transcript",
            "committed_text": "alpha beta",
            "partial_text": "",
            "segments": [],
        },
        {
            "type": "transcript",
            "committed_text": "alpha beta gamma",
            "partial_text": "",
            "segments": [],
        },
    ]


def test_later_shrinking_provisional_result_replaces_only_provisional_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recognition_results = iter(
        [
            ([], [word(0.0, 0.2, "alpha"), word(0.2, 0.4, "beta")]),
            ([], [word(0.0, 0.2, "alpha")]),
        ]
    )

    async def transcribe_window(
        _audio_chunks: list[bytes],
    ) -> tuple[list[dict[str, float | str]], list[dict[str, float | str]]]:
        return next(recognition_results)

    async def transcribe_final(_audio_chunks: list[bytes]) -> str:
        return "alpha"

    monkeypatch.setattr(backend_app, "LIVE_TRIGGER_BYTES", 1)
    monkeypatch.setattr(backend_app, "chunk_has_speech", lambda _chunk: True)
    monkeypatch.setattr(backend_app, "transcribe_chunk_words", transcribe_window)
    monkeypatch.setattr(backend_app, "transcribe_chunks", transcribe_final)

    websocket = run_websocket(
        [
            start_message(),
            audio_message(b"first"),
            {"text": json.dumps({"type": "ignored"})},
            audio_message(b"second"),
            {"text": json.dumps({"type": "ignored"})},
            stop_message(),
        ]
    )

    assert transcript_messages(websocket) == [
        {
            "type": "transcript",
            "committed_text": "",
            "partial_text": "alpha beta",
            "segments": [],
        },
        {
            "type": "transcript",
            "committed_text": "",
            "partial_text": "alpha",
            "segments": [],
        },
    ]


def test_force_commits_advance_the_next_whisper_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recognition_results = iter(
        [
            ([], [word(0.0, 0.8, "alpha")]),
            ([], [word(0.0, 1.6, "beta")]),
            ([], [word(0.0, 0.4, "gamma")]),
        ]
    )
    windows: list[list[bytes]] = []

    async def transcribe_window(
        audio_chunks: list[bytes],
    ) -> tuple[list[dict[str, float | str]], list[dict[str, float | str]]]:
        windows.append(audio_chunks)
        return next(recognition_results)

    async def transcribe_final(_audio_chunks: list[bytes]) -> str:
        return "alpha beta gamma"

    first_speech = b"speech-1"
    first_silence = b"silence-1"
    second_speech = b"speech-2"
    second_silence = b"silence-2"
    third_speech = b"speech-3"
    third_silence = b"silence-3"

    monkeypatch.setattr(backend_app, "BYTES_PER_SECOND", 10)
    monkeypatch.setattr(backend_app, "LIVE_CHUNK_BYTES", 8)
    monkeypatch.setattr(backend_app, "LIVE_TRIGGER_BYTES", 10_000)
    monkeypatch.setattr(backend_app, "PAUSE_FLUSH_CHUNKS", 1)
    monkeypatch.setattr(backend_app, "LONG_PAUSE_FLUSH_CHUNKS", 10)
    monkeypatch.setattr(backend_app, "MIN_COMMIT_BYTES", 1)
    monkeypatch.setattr(backend_app, "OVERLAP_BYTES", 0)
    monkeypatch.setattr(
        backend_app,
        "chunk_has_speech",
        lambda chunk: chunk.startswith(b"speech"),
    )
    monkeypatch.setattr(backend_app, "transcribe_chunk_words", transcribe_window)
    monkeypatch.setattr(backend_app, "transcribe_chunks", transcribe_final)

    run_websocket(
        [
            start_message(),
            audio_message(first_speech),
            audio_message(first_silence),
            {"text": json.dumps({"type": "ignored"})},
            audio_message(second_speech),
            audio_message(second_silence),
            {"text": json.dumps({"type": "ignored"})},
            audio_message(third_speech),
            audio_message(third_silence),
            {"text": json.dumps({"type": "ignored"})},
            stop_message(),
        ]
    )

    assert first_speech in windows[0]
    assert first_speech not in windows[1]
    assert second_speech not in windows[2]


def test_short_pause_does_not_trigger_a_commit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def transcribe_window(
        _audio_chunks: list[bytes],
    ) -> tuple[list[dict[str, float | str]], list[dict[str, float | str]]]:
        nonlocal calls
        calls += 1
        return [], []

    async def transcribe_final(_audio_chunks: list[bytes]) -> str:
        return "final transcript"

    monkeypatch.setattr(backend_app, "LIVE_TRIGGER_BYTES", 10_000)
    monkeypatch.setattr(backend_app, "PAUSE_FLUSH_CHUNKS", 3)
    monkeypatch.setattr(backend_app, "MIN_COMMIT_BYTES", 1)
    monkeypatch.setattr(
        backend_app,
        "chunk_has_speech",
        lambda chunk: chunk == b"speech",
    )
    monkeypatch.setattr(backend_app, "transcribe_chunk_words", transcribe_window)
    monkeypatch.setattr(backend_app, "transcribe_chunks", transcribe_final)

    run_websocket(
        [
            start_message(),
            audio_message(b"speech"),
            audio_message(b"silence"),
            audio_message(b"silence"),
            stop_message(),
        ]
    )

    assert calls == 0


def test_silence_without_speech_does_not_schedule_live_transcription(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def transcribe_window(
        _audio_chunks: list[bytes],
    ) -> tuple[list[dict[str, float | str]], list[dict[str, float | str]]]:
        nonlocal calls
        calls += 1
        return [], [word(0.0, 0.2, "hallucination")]

    async def transcribe_final(_audio_chunks: list[bytes]) -> str:
        return ""

    monkeypatch.setattr(backend_app, "LIVE_TRIGGER_BYTES", 1)
    monkeypatch.setattr(backend_app, "PAUSE_FLUSH_CHUNKS", 1)
    monkeypatch.setattr(backend_app, "MIN_COMMIT_BYTES", 1)
    monkeypatch.setattr(backend_app, "chunk_has_speech", lambda _chunk: False)
    monkeypatch.setattr(backend_app, "transcribe_chunk_words", transcribe_window)
    monkeypatch.setattr(backend_app, "transcribe_chunks", transcribe_final)

    websocket = run_websocket(
        [
            start_message(),
            audio_message(b"silence"),
            audio_message(b"silence"),
            audio_message(b"silence"),
            stop_message(),
        ]
    )

    assert calls == 0
    assert transcript_messages(websocket) == []


def test_websocket_ignores_malformed_and_unknown_text_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def transcribe_final(_audio_chunks: list[bytes]) -> str:
        return "unused"

    monkeypatch.setattr(backend_app, "transcribe_chunks", transcribe_final)

    websocket = run_websocket(
        [
            audio_message(b"before-start"),
            {"text": "not-json"},
            {"text": json.dumps(["not", "an", "object"])},
            {"text": json.dumps({"type": "unknown"})},
            start_message(),
            {"text": json.dumps({"type": "unknown"})},
            stop_message(),
        ]
    )

    assert websocket.sent_messages == [
        {"type": "ready", "message": "Live transcription is ready"},
    ]


def test_live_transcription_failure_falls_back_to_final_transcription(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def transcribe_window(
        _audio_chunks: list[bytes],
    ) -> tuple[list[dict[str, float | str]], list[dict[str, float | str]]]:
        raise RuntimeError("Whisper window failed")

    async def transcribe_final(_audio_chunks: list[bytes]) -> str:
        return "recovered final transcript"

    monkeypatch.setattr(backend_app, "LIVE_TRIGGER_BYTES", 1)
    monkeypatch.setattr(backend_app, "chunk_has_speech", lambda _chunk: True)
    monkeypatch.setattr(backend_app, "transcribe_chunk_words", transcribe_window)
    monkeypatch.setattr(backend_app, "transcribe_chunks", transcribe_final)

    websocket = run_websocket(
        [
            start_message(),
            audio_message(b"speech"),
            {"text": json.dumps({"type": "ignored"})},
            stop_message(),
        ]
    )

    assert websocket.sent_messages[-1] == {
        "type": "final",
        "text": "recovered final transcript",
        "committed_text": "recovered final transcript",
        "partial_text": "",
    }


def test_disconnect_cancels_an_active_live_transcription_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_cancelled = False
    transcription_started = asyncio.Event()

    async def slow_transcribe_window(
        _audio_chunks: list[bytes],
    ) -> tuple[list[dict[str, float | str]], list[dict[str, float | str]]]:
        nonlocal task_cancelled
        transcription_started.set()

        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            task_cancelled = True
            raise

    async def transcribe_final(_audio_chunks: list[bytes]) -> str:
        return "ignored after disconnect"

    monkeypatch.setattr(backend_app, "LIVE_TRIGGER_BYTES", 1)
    monkeypatch.setattr(backend_app, "chunk_has_speech", lambda _chunk: True)
    monkeypatch.setattr(
        backend_app,
        "transcribe_chunk_words",
        slow_transcribe_window,
    )
    monkeypatch.setattr(backend_app, "transcribe_chunks", transcribe_final)

    websocket = run_websocket(
        [
            start_message(),
            audio_message(b"speech"),
            {"type": "websocket.disconnect"},
        ]
    )

    assert transcription_started.is_set()
    assert task_cancelled
    assert websocket.sent_messages == [
        {"type": "ready", "message": "Live transcription is ready"},
    ]
