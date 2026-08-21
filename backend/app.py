import asyncio
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


service = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Uses OpenAI-compatible API (Ollama, OpenAI, LM Studio, etc.). Configure via .env file."""
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

# CORS for localhost development
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",  # React dev server (Vite)
        "http://localhost:5173",  # React dev server (Vite alternative port)
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
    if not service:
        raise HTTPException(status_code=503, detail="Service not ready")

    return {"default_prompt": service.get_default_system_prompt()}


@app.post("/api/transcribe")
async def transcribe_audio(audio: Annotated[UploadFile, File()]):
    if not service:
        raise HTTPException(
            status_code=503, detail="Service not ready, still initializing models"
        )

    suffix = os.path.splitext(audio.filename)[1] or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await audio.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        raw_text = service.transcribe(tmp_path)
        return {"success": True, "text": raw_text}

    except Exception as e:
        print(f"❌ Transcription error: {e}")
        raise HTTPException(
            status_code=500, detail=f"Transcription failed: {str(e)}"
        ) from e

    finally:
        # Always clean up temp file
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


@app.post("/api/clean")
async def clean_text(request: CleanRequest):
    if not service:
        raise HTTPException(status_code=503, detail="Service not ready")

    try:
        cleaned_text = service.clean_with_llm(
            request.text,
            system_prompt=request.system_prompt,
            meeting_type=request.meeting_type,
        )
        return {"success": True, "text": cleaned_text}

    except Exception as e:
        # Log the full error to the backend terminal; keep the response generic so no
        # raw error detail leaks to the frontend.
        print(f"❌ LLM cleaning failed: {e}")
        raise HTTPException(
            status_code=502,
            detail="LLM cleaning failed. Check the backend terminal for details.",
        ) from e


async def transcribe_chunks(audio_chunks: list[bytes]) -> str:
    if not service or not audio_chunks:
        return ""

    pcm_bytes = b"".join(audio_chunks)

    def transcribe_pcm() -> str:
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


@app.websocket("/ws/transcribe")
async def transcribe_websocket(websocket: WebSocket):
    await websocket.accept()

    audio_chunks: list[bytes] = []
    total_bytes = 0
    started = False

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

    except WebSocketDisconnect:
        print("Live transcription client disconnected")

    except Exception as e:
        print(f"Live transcription connection closed: {e}")

    print(
        f"Receive loop ended: "
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

    except Exception as e:
        print(f"Could not send final transcript: {e}")
