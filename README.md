# AI Meeting Note Tool

A local-first meeting transcription and note-taking app. Records audio, transcribes it live using Whisper, and generates structured meeting notes/summaries using a local LLM.

## Architecture

```
┌─────────────────┐        WebSocket / REST        ┌──────────────────────┐
│   Frontend       │ ◄─────────────────────────────► │  Backend (FastAPI)   │
│  React + TS +    │                                 │  - Live transcription│
│  Vite            │                                 │    (Whisper, CUDA)   │
│                  │                                 │  - Summarization     │
│  - Audio capture │                                 │    (local LLM)       │
│  - Live transcript view (committed vs partial)     │  - Meeting storage   │
│  - Meeting list / edit / rename / save             └──────────────────────┘
└─────────────────┘
```

**Key design points:**

- Live transcription uses a **windowed, word-level commit architecture**: audio is processed in a bounded rolling window (not full re-transcription) to avoid quadratic slowdown on long recordings.
- Commit boundaries only advance to the end of a fully recognized word, avoiding mid-word cuts.
- Pause detection (via PCM energy) force-commits segments during silence, gated on actual detected speech to avoid Whisper hallucination.
- The frontend separates **committed (editable)** transcript text from **partial (read-only)** live text, and protects user edits from being overwritten by incoming WebSocket updates using word-count diffing.

## Project structure

```
backend/
  app.py              # FastAPI app: WebSocket + REST endpoints
  transcription.py     # Whisper-based windowed live transcription logic
  system_prompt.txt    # LLM prompt for meeting note/summary generation
  pyproject.toml       # Python deps, managed with uv
  .env.example         # Required environment variables (copy to .env)

frontend/
  src/
    App.tsx             # Main app shell
    audio/              # Audio capture / recording logic
    components/         # UI components (recording controls, transcript view, etc.)
    styles/             # Shared styles
    types/              # Shared TypeScript types
```

## Prerequisites

- Python 3.10+ with [`uv`](https://github.com/astral-sh/uv) installed
- Node.js 18+ and npm
- NVIDIA GPU + CUDA (recommended for Whisper performance; CPU fallback possible but slower)
- A local LLM runtime (e.g., Ollama or similar) for summarization — configure via `.env`

## Manual setup

### Backend

```bash
cd backend
uv sync
```

Create the backend environment file:

```bash
cp .env.example .env
```

Configure the values in `backend/.env` for your transcription and LLM setup.

Start the API:

```bash
uv run uvicorn app:app --reload --host 0.0.0.0 --port 8000 --timeout-keep-alive 600
```

### Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## LLM configuration

The cleanup pipeline uses an OpenAI-compatible API. Configure the provider in `backend/.env`:

```env
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=your-model-name
```

Common provider options include:

- Ollama for local inference.
- LM Studio for local inference.
- OpenAI or another hosted OpenAI-compatible provider.

If LLM cleanup is disabled or unavailable, the app can still return the raw Whisper transcription.

## Running a meeting

1. Start the backend and frontend as above.
2. Open the frontend in your browser (default Vite port).
3. Start a recording — audio streams to the backend over WebSocket for live transcription.
4. Edit the committed transcript text at any time; your edits are preserved as new speech is recognized.
5. Save, rename, or export the meeting once finished.

## Known limitations / in-progress areas

- `App.tsx` is currently a large single component; a component-level refactor is planned to improve maintainability.
- No automated test suite yet for the transcription window/commit logic or the frontend edit-protection diffing — planned as part of the stabilization phase.
- Backend currently runs locally only; no remote deployment or containerization yet.
- No packaged desktop (Windows) or mobile (iOS) build yet — planned next.

## Roadmap

- [ ] Add backend API/WebSocket contract docs
- [ ] Add pytest tests for transcription window/commit + pause detection
- [ ] Add Vitest tests for frontend edit-protection diffing
- [ ] Dockerize backend
- [ ] Package as Windows desktop app (Electron)
- [ ] Deploy backend remotely + convert frontend to PWA
- [ ] Package as iOS app (Capacitor)
- [ ] Speaker diarization
- [ ] Export to PDF/Markdown, meeting search/history

## Contributing / development notes

This is an actively evolving personal project. See commit history for recent fixes to live transcription pause handling and edit protection, which informed the current architecture described above.
