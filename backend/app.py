import asyncio
import contextlib
import json
import os
import tempfile
from contextlib import asynccontextmanager
from typing import Annotated

import numpy as np
from dotenv import load_dotenv
from fastapi import (
    FastAPI,
    File,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from scipy.signal import resample_poly

from transcription import TranscriptionService

load_dotenv()


class CleanRequest(BaseModel):
    text: str
    system_prompt: str | None = None
    meeting_type: str = "general"


Segment = dict[str, float | str]

service: TranscriptionService | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize the local Whisper and LLM-backed transcription service."""
    global service

    print("🚀 Starting AI Transcript App...")

    service = TranscriptionService(
        whisper_model=os.getenv("WHISPER_MODEL"),
        llm_base_url=os.getenv("LLM_BASE_URL"),
        llm_api_key=os.getenv("LLM_API_KEY"),
        llm_model=os.getenv("LLM_MODEL"),
    )

    print("✅ Ready!")
    yield


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

    with tempfile.NamedTemporaryFile(
        delete=False,
        suffix=suffix,
    ) as tmp:
        content = await audio.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        raw_text = service.transcribe(tmp_path)
        return {"success": True, "text": raw_text}
    except Exception as error:
        print(f"❌ Transcription error: {error}")
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {error}",
        ) from error
    finally:
        if os.path.exists(tmp_path):
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
        return {"success": True, "text": cleaned_text}
    except Exception as error:
        print(f"❌ LLM cleaning failed: {error}")
        raise HTTPException(
            status_code=502,
            detail="LLM cleaning failed. Check the backend terminal for details.",
        ) from error


async def transcribe_chunks(audio_chunks: list[bytes]) -> str:
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
            vad_filter=False,
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


async def transcribe_chunk_segments(
    audio_chunks: list[bytes],
) -> list[Segment]:
    if service is None or not audio_chunks:
        return []

    pcm_bytes = b"".join(audio_chunks)

    def transcribe_pcm_segments() -> list[Segment]:
        if service is None:
            return []

        audio_48k = (
            np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        )
        audio_16k = resample_poly(audio_48k, 1, 3).astype(np.float32)

        segments, _info = service.whisper.transcribe(
            audio_16k,
            language="en",
            beam_size=1,
            best_of=1,
            condition_on_previous_text=False,
            vad_filter=False,
        )

        results: list[Segment] = []

        for segment in segments:
            text = segment.text.strip()

            if not text:
                continue

            results.append(
                {
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": text,
                }
            )

        return results

    return await asyncio.to_thread(transcribe_pcm_segments)


def normalized_segment_text(segment: Segment) -> str:
    return " ".join(str(segment["text"]).split()).lower().strip()


def segments_match(left: Segment, right: Segment) -> bool:
    return (
        normalized_segment_text(left) == normalized_segment_text(right)
        and abs(float(left["start"]) - float(right["start"])) <= 0.25
    )


@app.websocket("/ws/transcribe")
async def transcribe_websocket(websocket: WebSocket):
    await websocket.accept()

    audio_chunks: list[bytes] = []
    total_bytes = 0
    started = False
    last_live_transcription_bytes = 0

    live_transcription_task: (
        asyncio.Task[tuple[list[Segment], list[Segment]]] | None
    ) = None

    previous_live_segments: list[Segment] = []
    committed_live_segments: list[Segment] = []

    async def send_live_transcript(
        chunks: list[bytes],
        previous_segments: list[Segment],
        committed_segments: list[Segment],
    ) -> tuple[list[Segment], list[Segment]]:
        try:
            segments = await transcribe_chunk_segments(chunks)

            if not segments:
                return previous_segments, committed_segments

            def normalized_text(segment: Segment) -> str:
                return " ".join(str(segment["text"]).split()).lower().strip(" .,!?;:")

            def matches(
                left: Segment,
                right: Segment,
            ) -> bool:
                return (
                    normalized_text(left) == normalized_text(right)
                    and abs(float(left["start"]) - float(right["start"])) <= 0.35
                )

            previous_count = len(previous_segments)
            committed_count = len(committed_segments)

            stable_count = 0

            for previous, current in zip(
                previous_segments,
                segments,
            ):
                if matches(previous, current):
                    stable_count += 1
                else:
                    break

            committed_prefix_is_present = committed_count <= len(segments) and all(
                matches(
                    committed_segment,
                    segments[index],
                )
                for index, committed_segment in enumerate(committed_segments)
            )

            if committed_count == 0:
                next_committed_segments = segments[:stable_count]
            elif committed_prefix_is_present:
                next_committed_count = max(
                    committed_count,
                    stable_count,
                )

                next_committed_segments = segments[:next_committed_count]
            else:
                # Whisper changed an already committed prefix.
                # Preserve the old committed state and do not
                # expose the rewritten prefix as partial text.
                next_committed_segments = committed_segments

            committed_count = len(next_committed_segments)

            if committed_count <= len(segments):
                partial_segments = segments[committed_count:]
            else:
                # The current Whisper result no longer contains
                # the committed prefix. Preserve committed output
                # and expose no potentially duplicated partial.
                partial_segments = []

            committed_text = " ".join(
                str(segment["text"]).strip() for segment in next_committed_segments
            ).strip()

            partial_text = " ".join(
                str(segment["text"]).strip() for segment in partial_segments
            ).strip()

            print(
                "📌 BACKEND OUTPUT",
                {
                    "committed_text": committed_text,
                    "partial_text": partial_text,
                    "previous_count": previous_count,
                    "stable_count": stable_count,
                    "committed_count": committed_count,
                    "partial_count": len(partial_segments),
                    "committed_prefix_is_present": (committed_prefix_is_present),
                },
            )

            await websocket.send_json(
                {
                    "type": "transcript",
                    "committed_text": committed_text,
                    "partial_text": partial_text,
                    "segments": segments,
                }
            )

            return segments, next_committed_segments

        except Exception as error:
            print(f"Live transcription failed: {error}")
            return previous_segments, committed_segments

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

                if payload.get("type") == "start":
                    started = True
                    audio_chunks.clear()
                    total_bytes = 0
                    last_live_transcription_bytes = 0
                    previous_live_segments = []
                    committed_live_segments = []

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

                elif payload.get("type") == "stop":
                    print("Stop received; transcribing buffered audio")
                    break

            elif audio_data is not None and started:
                audio_chunks.append(audio_data)
                total_bytes += len(audio_data)

                print(f"Received PCM bytes: {len(audio_data)} (total: {total_bytes})")

                bytes_since_last_live = total_bytes - last_live_transcription_bytes

                if bytes_since_last_live >= 160_000:
                    last_live_transcription_bytes = total_bytes

                    if (
                        live_transcription_task is None
                        or live_transcription_task.done()
                    ):
                        if live_transcription_task is not None:
                            (
                                previous_live_segments,
                                committed_live_segments,
                            ) = live_transcription_task.result()

                        live_transcription_task = asyncio.create_task(
                            send_live_transcript(
                                audio_chunks.copy(),
                                previous_live_segments,
                                committed_live_segments,
                            )
                        )

    except WebSocketDisconnect:
        print("Live transcription client disconnected")
    except Exception as error:
        print(f"Live transcription connection closed: {error}")

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
            }
        )

        print("Final transcript sent successfully")

        await websocket.close(
            code=1000,
            reason="Final transcript sent",
        )

        print("WebSocket closed after final transcript")

    except Exception as error:
        print("Could not send final transcript or close WebSocket: " f"{error}")
