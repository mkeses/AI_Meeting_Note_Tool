import asyncio
import contextlib
import json
import math
import os
import tempfile
import time
from contextlib import asynccontextmanager
from typing import Annotated

import numpy as np
from dotenv import load_dotenv
from fastapi import (
    FastAPI,
    File,
    HTTPException,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from scipy.signal import resample_poly

from database import MeetingConflictError, MeetingRepository, MeetingStorageError
from meeting_models import MeetingCreate, MeetingResponse, MeetingUpdate
from transcription import TranscriptionService

load_dotenv()


class CleanRequest(BaseModel):
    text: str
    system_prompt: str | None = None
    meeting_type: str = "general"


Segment = dict[str, float | str]
Word = dict[str, float | str]

service: TranscriptionService | None = None
meeting_repository: MeetingRepository | None = None

# --- Live transcription windowing constants ---

SAMPLE_RATE = 48_000
BYTES_PER_SAMPLE = 2
BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE  # 96_000

LIVE_CHUNK_BYTES = 16_000

OVERLAP_SECONDS = 1.5
OVERLAP_BYTES = int(OVERLAP_SECONDS * BYTES_PER_SECOND)

MAX_PARTIAL_SECONDS = 12.0
MAX_PARTIAL_BYTES = int(MAX_PARTIAL_SECONDS * BYTES_PER_SECOND)

LIVE_TRIGGER_BYTES = 160_000

PAUSE_FLUSH_CHUNKS = 4

MIN_COMMIT_SECONDS = 0.8
MIN_COMMIT_BYTES = int(MIN_COMMIT_SECONDS * BYTES_PER_SECOND)

LONG_PAUSE_FLUSH_CHUNKS = 12  # roughly 2 seconds of silence

# Faster-Whisper's default VAD requires ~250ms of continuous speech
# before treating something as real speech. Short function words (e.g.
# "to", "a", "is") spoken quickly - especially when isolated by nearby
# pauses - can fall under that threshold and get silently dropped
# before Whisper ever sees them. Lowering this makes VAD more permissive
# about short words while leaving silence-detection settings untouched
# (those are what prevent hallucination during long pauses).
LIVE_VAD_PARAMETERS = {"min_speech_duration_ms": 100}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize the local Whisper and LLM-backed transcription service."""
    global meeting_repository, service

    print("🚀 Starting AI Transcript App...")

    whisper_model = os.getenv("WHISPER_MODEL")
    llm_base_url = os.getenv("LLM_BASE_URL")
    llm_api_key = os.getenv("LLM_API_KEY")
    llm_model = os.getenv("LLM_MODEL")

    missing_values = [
        name
        for name, value in {
            "WHISPER_MODEL": whisper_model,
            "LLM_BASE_URL": llm_base_url,
            "LLM_API_KEY": llm_api_key,
            "LLM_MODEL": llm_model,
        }.items()
        if not value
    ]

    if missing_values:
        raise RuntimeError(
            "Missing required environment variables: " + ", ".join(missing_values)
        )

    service = TranscriptionService(
        whisper_model=whisper_model,
        llm_base_url=llm_base_url,
        llm_api_key=llm_api_key,
        llm_model=llm_model,
    )
    meeting_repository = MeetingRepository.from_environment()
    meeting_repository.initialize()

    print("✅ Ready!")

    try:
        yield
    finally:
        meeting_repository = None
        service = None


app = FastAPI(title="AI Transcript App", lifespan=lifespan)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/status")
async def get_status():
    return {
        "status": "ready" if service else "initializing",
        "whisper_model": os.getenv("WHISPER_MODEL"),
        "llm_model": os.getenv("LLM_MODEL"),
        "llm_base_url": os.getenv("LLM_BASE_URL"),
    }


def get_meeting_repository() -> MeetingRepository:
    if meeting_repository is None:
        raise HTTPException(status_code=503, detail="Meeting storage is not ready")
    return meeting_repository


def raise_storage_http_error(error: MeetingStorageError) -> None:
    print(f"❌ Meeting storage error: {error}")
    raise HTTPException(
        status_code=503, detail="Meeting storage is unavailable"
    ) from error


@app.get("/api/meetings", response_model=list[MeetingResponse])
def list_meetings() -> list[MeetingResponse]:
    try:
        meetings = get_meeting_repository().list()
    except MeetingStorageError as error:
        raise_storage_http_error(error)

    return [MeetingResponse.from_record(meeting) for meeting in meetings]


@app.post("/api/meetings", response_model=MeetingResponse, status_code=201)
def create_meeting(meeting: MeetingCreate) -> MeetingResponse:
    try:
        created_meeting = get_meeting_repository().create(meeting.to_record())
    except MeetingConflictError as error:
        raise HTTPException(status_code=409, detail="Meeting already exists") from error
    except MeetingStorageError as error:
        raise_storage_http_error(error)

    return MeetingResponse.from_record(created_meeting)


@app.get("/api/meetings/{meeting_id}", response_model=MeetingResponse)
def get_meeting(meeting_id: str) -> MeetingResponse:
    try:
        meeting = get_meeting_repository().get(meeting_id)
    except MeetingStorageError as error:
        raise_storage_http_error(error)

    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return MeetingResponse.from_record(meeting)


@app.patch("/api/meetings/{meeting_id}", response_model=MeetingResponse)
def update_meeting(meeting_id: str, update: MeetingUpdate) -> MeetingResponse:
    changes = update.to_changes()
    if not changes:
        raise HTTPException(status_code=422, detail="At least one field is required")

    try:
        meeting = get_meeting_repository().update(meeting_id, changes)
    except MeetingConflictError as error:
        raise HTTPException(status_code=409, detail="Meeting already exists") from error
    except MeetingStorageError as error:
        raise_storage_http_error(error)

    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return MeetingResponse.from_record(meeting)


@app.delete("/api/meetings/{meeting_id}", status_code=204)
def delete_meeting(meeting_id: str) -> Response:
    try:
        deleted = get_meeting_repository().delete(meeting_id)
    except MeetingStorageError as error:
        raise_storage_http_error(error)

    if not deleted:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return Response(status_code=204)


@app.get("/api/system-prompt")
async def get_system_prompt():
    if service is None:
        raise HTTPException(status_code=503, detail="Service not ready")

    return {"default_prompt": service.get_default_system_prompt()}


@app.post("/api/transcribe")
async def transcribe_audio(audio: Annotated[UploadFile, File()]):
    if service is None:
        raise HTTPException(
            status_code=503,
            detail="Service not ready, still initializing models",
        )

    suffix = os.path.splitext(audio.filename or "")[1] or ".webm"
    tmp_path: str | None = None

    try:
        with tempfile.NamedTemporaryFile(
            delete=False,
            suffix=suffix,
        ) as tmp:
            content = await audio.read()
            tmp.write(content)
            tmp_path = tmp.name

        raw_text = service.transcribe(tmp_path)

        return {
            "success": True,
            "text": raw_text,
        }

    except Exception as error:
        print(f"❌ Transcription error: {error}")

        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {error}",
        ) from error

    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


@app.post("/api/clean")
async def clean_text(request: CleanRequest):
    if service is None:
        raise HTTPException(status_code=503, detail="Service not ready")

    try:
        cleaned_text = service.clean_with_llm(
            request.text,
            system_prompt=request.system_prompt,
            meeting_type=request.meeting_type,
        )

        return {
            "success": True,
            "text": cleaned_text,
        }

    except Exception as error:
        print(f"❌ LLM cleaning failed: {error}")

        raise HTTPException(
            status_code=502,
            detail="LLM cleaning failed. Check the backend terminal for details.",
        ) from error


async def transcribe_chunks(audio_chunks: list[bytes]) -> str:
    """Full, one-time transcription of the entire recording, used only
    once at the end of a session."""
    if service is None or not audio_chunks:
        return ""

    pcm_bytes = b"".join(audio_chunks)

    def transcribe_pcm() -> str:
        if service is None:
            return ""

        audio_48k = (
            np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        )
        audio_16k = resample_poly(audio_48k, 1, 3).astype(np.float32)

        segments, info = service.whisper.transcribe(
            audio_16k,
            language="en",
            beam_size=1,
            best_of=1,
            condition_on_previous_text=False,
            vad_filter=True,
            vad_parameters=LIVE_VAD_PARAMETERS,
        )

        text = " ".join(
            segment.text.strip() for segment in segments if segment.text.strip()
        ).strip()

        print(
            f"📝 Detected language: {info.language} "
            f"(p={info.language_probability:.2f})"
        )
        print(f"📝 Raw: {text!r}")

        return text

    return await asyncio.to_thread(transcribe_pcm)


async def transcribe_chunk_words(
    audio_chunks: list[bytes],
) -> tuple[list[Segment], list[Word]]:
    """Transcribe a small, windowed list of PCM chunks. Returns both
    whole segments (kept for the outgoing message / debugging) and a
    flat list of individual words with their own start/end timestamps,
    used for precise boundary cropping in send_live_transcript."""
    if service is None or not audio_chunks:
        return [], []

    pcm_bytes = b"".join(audio_chunks)

    def transcribe_pcm_segments() -> tuple[list[Segment], list[Word]]:
        if service is None:
            return [], []

        resample_start = time.monotonic()

        audio_48k = (
            np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        )
        audio_16k = resample_poly(audio_48k, 1, 3).astype(np.float32)

        resample_elapsed = time.monotonic() - resample_start

        whisper_start = time.monotonic()

        segments, _info = service.whisper.transcribe(
            audio_16k,
            language="en",
            beam_size=1,
            best_of=1,
            condition_on_previous_text=False,
            vad_filter=True,
            vad_parameters=LIVE_VAD_PARAMETERS,
            word_timestamps=True,
        )

        segments = list(segments)

        whisper_elapsed = time.monotonic() - whisper_start

        buffer_seconds = len(pcm_bytes) / BYTES_PER_SECOND

        print(
            "⏱️ LIVE TRANSCRIBE TIMING "
            f"window={buffer_seconds:.1f}s "
            f"resample={resample_elapsed:.2f}s "
            f"whisper={whisper_elapsed:.2f}s "
            f"total={resample_elapsed + whisper_elapsed:.2f}s"
        )

        result_segments: list[Segment] = []
        result_words: list[Word] = []

        for segment in segments:
            text = segment.text.strip()

            if text:
                result_segments.append(
                    {
                        "start": float(segment.start),
                        "end": float(segment.end),
                        "text": text,
                    }
                )

            if segment.words:
                for word in segment.words:
                    word_text = word.word.strip()

                    if not word_text:
                        continue

                    result_words.append(
                        {
                            "start": float(word.start),
                            "end": float(word.end),
                            "text": word_text,
                        }
                    )

        return result_segments, result_words

    return await asyncio.to_thread(transcribe_pcm_segments)


def chunk_has_speech(
    audio_data: bytes,
    threshold: float = 350.0,
) -> bool:
    samples = np.frombuffer(audio_data, dtype=np.int16)

    if samples.size == 0:
        return False

    samples_float = samples.astype(np.float32)
    rms = float(np.sqrt(np.mean(np.square(samples_float))))

    return math.isfinite(rms) and rms >= threshold


def words_text(words: list[Word]) -> str:
    return " ".join(
        str(word["text"]).strip() for word in words if str(word["text"]).strip()
    ).strip()


def join_non_empty(*parts: str) -> str:
    return " ".join(part.strip() for part in parts if part.strip()).strip()


@app.websocket("/ws/transcribe")
async def transcribe_websocket(websocket: WebSocket):
    await websocket.accept()

    audio_chunks: list[bytes] = []
    total_bytes = 0
    started = False
    last_live_transcription_bytes = 0

    committed_text = ""
    committed_audio_bytes = 0

    live_transcription_task: asyncio.Task[tuple[str, int]] | None = None

    last_audio_was_speech = False
    silent_chunks = 0
    pending_speech_since_last_live = False
    pause_checked_this_silence = False

    async def send_live_transcript(
        chunks_snapshot: list[bytes],
        current_committed_text: str,
        current_committed_audio_bytes: int,
        force_commit: bool,
        total_bytes_snapshot: int,
    ) -> tuple[str, int]:
        try:
            window_start_bytes = max(
                0,
                current_committed_audio_bytes - OVERLAP_BYTES,
            )
            start_chunk_index = window_start_bytes // LIVE_CHUNK_BYTES
            window_chunks = chunks_snapshot[start_chunk_index:]

            if not window_chunks:
                return current_committed_text, current_committed_audio_bytes

            window_start_seconds = (
                start_chunk_index * LIVE_CHUNK_BYTES
            ) / BYTES_PER_SECOND

            segments, words = await transcribe_chunk_words(window_chunks)

            if not words:
                return current_committed_text, current_committed_audio_bytes

            committed_audio_seconds = current_committed_audio_bytes / BYTES_PER_SECOND

            new_words = [
                word
                for word in words
                if (float(word["end"]) + window_start_seconds) > committed_audio_seconds
            ]

            new_text = words_text(new_words)

            uncommitted_bytes = total_bytes_snapshot - current_committed_audio_bytes
            should_force_commit = force_commit or uncommitted_bytes >= MAX_PARTIAL_BYTES

            if should_force_commit and new_words:
                # Only advance the committed boundary to the END of the
                # last fully-recognized word, never to the raw edge of
                # the window. A force-commit (especially the
                # elapsed-time-based MAX_PARTIAL one) can otherwise cut
                # off mid-word; advancing only as far as confirmed
                # speech leaves any trailing, possibly-incomplete audio
                # "pending" so the next window gets a full, uncut
                # attempt at it instead of losing it permanently.
                last_word_end_seconds = (
                    float(new_words[-1]["end"]) + window_start_seconds
                )
                last_word_end_bytes = int(last_word_end_seconds * BYTES_PER_SECOND)

                next_committed_text = join_non_empty(
                    current_committed_text,
                    new_text,
                )
                next_committed_audio_bytes = max(
                    current_committed_audio_bytes,
                    last_word_end_bytes,
                )
                partial_text = ""
            elif should_force_commit:
                # Force-commit requested but nothing new was actually
                # recognized (e.g. trailing silence only) - nothing to
                # advance, leave the boundary where it is.
                next_committed_text = current_committed_text
                next_committed_audio_bytes = current_committed_audio_bytes
                partial_text = ""
            else:
                next_committed_text = current_committed_text
                next_committed_audio_bytes = current_committed_audio_bytes
                partial_text = new_text

            print(
                "📌 BACKEND OUTPUT",
                {
                    "committed_text": next_committed_text,
                    "partial_text": partial_text,
                    "new_word_count": len(new_words),
                    "force_commit": force_commit,
                    "max_partial_forced": (should_force_commit and not force_commit),
                },
            )

            await websocket.send_json(
                {
                    "type": "transcript",
                    "committed_text": next_committed_text,
                    "partial_text": partial_text,
                    "segments": segments,
                }
            )

            return next_committed_text, next_committed_audio_bytes

        except WebSocketDisconnect:
            raise

        except Exception as error:
            print(f"Live transcription failed: {error}")
            return current_committed_text, current_committed_audio_bytes

    async def finish_live_task() -> None:
        nonlocal live_transcription_task
        nonlocal committed_text
        nonlocal committed_audio_bytes

        if live_transcription_task is None:
            return

        if not live_transcription_task.done():
            await live_transcription_task

        try:
            committed_text, committed_audio_bytes = live_transcription_task.result()
        except asyncio.CancelledError:
            pass
        except Exception as error:
            print(f"Live transcription task failed: {error}")
        finally:
            live_transcription_task = None

    async def schedule_live_transcription(force_commit: bool = False) -> bool:
        nonlocal live_transcription_task
        nonlocal last_live_transcription_bytes
        nonlocal pending_speech_since_last_live

        if live_transcription_task is not None:
            if not live_transcription_task.done():
                print("⏭️ SKIPPED live transcription — previous task still running")
                return False

            await finish_live_task()

        last_live_transcription_bytes = total_bytes
        pending_speech_since_last_live = False

        live_transcription_task = asyncio.create_task(
            send_live_transcript(
                audio_chunks.copy(),
                committed_text,
                committed_audio_bytes,
                force_commit,
                total_bytes,
            )
        )

        return True

    try:
        while True:
            message = await websocket.receive()

            if message.get("type") == "websocket.disconnect":
                break

            text_data = message.get("text")
            audio_data = message.get("bytes")

            if text_data is not None:
                print(f"WebSocket message: {text_data}")

                try:
                    payload = json.loads(text_data)
                except json.JSONDecodeError:
                    continue

                if not isinstance(payload, dict):
                    continue

                message_type = payload.get("type")

                if message_type == "start":
                    started = True
                    audio_chunks.clear()
                    total_bytes = 0
                    last_live_transcription_bytes = 0
                    committed_text = ""
                    committed_audio_bytes = 0
                    last_audio_was_speech = False
                    silent_chunks = 0
                    pending_speech_since_last_live = False
                    pause_checked_this_silence = False

                    if live_transcription_task is not None:
                        live_transcription_task.cancel()

                        with contextlib.suppress(asyncio.CancelledError):
                            await live_transcription_task

                        live_transcription_task = None

                    await websocket.send_json(
                        {
                            "type": "ready",
                            "message": "Live transcription is ready",
                        }
                    )

                elif message_type == "stop":
                    print("Stop received; transcribing buffered audio")
                    break

            elif audio_data is not None and started:
                audio_chunks.append(audio_data)
                total_bytes += len(audio_data)

                has_speech = chunk_has_speech(audio_data)

                if has_speech:
                    last_audio_was_speech = True
                    silent_chunks = 0
                    pending_speech_since_last_live = True
                    pause_checked_this_silence = False
                else:
                    silent_chunks += 1

                bytes_since_last_live = total_bytes - last_live_transcription_bytes
                uncommitted_bytes = total_bytes - committed_audio_bytes

                pause_detected = (
                    last_audio_was_speech and silent_chunks >= PAUSE_FLUSH_CHUNKS
                )

                should_force_commit_now = pause_detected and (
                    uncommitted_bytes >= MIN_COMMIT_BYTES
                    or silent_chunks >= LONG_PAUSE_FLUSH_CHUNKS
                )

                routine_trigger = (
                    bytes_since_last_live >= LIVE_TRIGGER_BYTES
                    and pending_speech_since_last_live
                )

                pause_trigger = pause_detected and (
                    not pause_checked_this_silence
                    or silent_chunks >= LONG_PAUSE_FLUSH_CHUNKS
                )

                should_transcribe_live = routine_trigger or pause_trigger

                if should_transcribe_live:
                    was_scheduled = await schedule_live_transcription(
                        force_commit=should_force_commit_now,
                    )

                    if was_scheduled and pause_detected:
                        pause_checked_this_silence = True

                    if should_force_commit_now and was_scheduled:
                        last_audio_was_speech = False
                        silent_chunks = 0
                        pause_checked_this_silence = False

    except WebSocketDisconnect:
        print("Live transcription client disconnected")
        return

    except Exception as error:
        print(f"Live transcription connection closed: {error}")

    finally:
        if live_transcription_task is not None:
            live_transcription_task.cancel()

            with contextlib.suppress(asyncio.CancelledError):
                await live_transcription_task

    print(
        "Receive loop ended: "
        f"audio_chunks={len(audio_chunks)}, total_bytes={total_bytes}"
    )

    if not audio_chunks:
        print("No audio chunks received; nothing to transcribe")
        return

    print("Starting final transcription")

    result = await transcribe_chunks(audio_chunks)

    print(f"Transcription function returned: {result!r}")

    if not result:
        print("Transcription result was empty; nothing sent to frontend")
        return

    print(f"Sending final transcript to frontend: {result}")

    try:
        await websocket.send_json(
            {
                "type": "final",
                "text": result,
                "committed_text": result,
                "partial_text": "",
            }
        )

        print("Final transcript sent successfully")

        await websocket.close(
            code=1000,
            reason="Final transcript sent",
        )

        print("WebSocket closed after final transcript")

    except WebSocketDisconnect:
        print("Client disconnected before final transcript was sent")

    except Exception as error:
        print(f"Could not send final transcript or close WebSocket: {error}")
