# AI Meeting Note Tool

A local-first AI meeting transcription and note-taking application built around real-time audio processing, editable live transcription, and structured AI-generated meeting notes.

The project is designed as an engineering-focused application rather than a simple transcription demo. It combines browser audio capture, WebSocket streaming, rolling-window speech recognition, frontend state management, user-edit protection, SQLite-backed meeting persistence, and automated testing.

## Project Status

**Current status:** Core transcription, persistent meeting workspaces, and database-backed full-text search are implemented and covered by frontend Vitest and backend pytest suites. The application currently runs locally using a containerized development environment.

The next development phase focuses on export workflows before moving toward desktop packaging and remote deployment.

---

## Architecture

```text
┌──────────────────────────────┐
│        React Frontend        │
│          TypeScript          │
│            Vite              │
│                              │
│  ┌────────────────────────┐  │
│  │ Browser Audio Capture  │  │
│  └────────────┬───────────┘  │
│               │ WebSocket    │
│               ▼              │
│  ┌────────────────────────┐  │
│  │ Live Transcript Editor │  │
│  │                        │  │
│  │ Committed text         │  │
│  │ Provisional text       │  │
│  │ User-edit protection   │  │
│  └────────────┬───────────┘  │
│               │ REST         │
│               ▼              │
│  ┌────────────────────────┐  │
│  │ Meeting Workspace      │  │
│  │ Titles, Notes, Search  │  │
│  └────────────────────────┘  │
└──────────────┬───────────────┘
               │
        WebSocket / REST
               │
               ▼
┌──────────────────────────────┐
│       Python Backend         │
│           FastAPI            │
│                              │
│  ┌────────────────────────┐  │
│  │ Audio / PCM processing │  │
│  └────────────┬───────────┘  │
│               ▼              │
│  ┌────────────────────────┐  │
│  │ Windowed Whisper       │  │
│  │ Transcription          │  │
│  └────────────┬───────────┘  │
│               ▼              │
│  ┌────────────────────────┐  │
│  │ Local LLM Cleanup      │  │
│  │ / Structured Notes     │  │
│  └────────────────────────┘  │
│               │              │
│               ▼              │
│  ┌────────────────────────┐  │
│  │ SQLite Meetings + FTS5 │  │
│  │ REST CRUD and Search   │  │
│  └────────────────────────┘  │
└──────────────────────────────┘
```

### Technology Stack

| Layer                        | Technology                      |
| ---------------------------- | ------------------------------- |
| Frontend                     | React + TypeScript + Vite       |
| Backend                      | Python + FastAPI                |
| Live communication           | WebSocket                       |
| Speech recognition           | Faster-Whisper                  |
| AI note generation           | OpenAI-compatible local LLM API |
| Local LLM runtime            | Ollama-compatible               |
| Meeting persistence/search   | SQLite + FTS5                   |
| Frontend testing             | Vitest + React Testing Library  |
| Backend testing              | pytest                          |
| Python dependency management | `uv`                            |
| Development environment      | Docker / Dev Container          |
| GPU acceleration             | NVIDIA CUDA                     |

---

## Engineering Highlights

### 1. Windowed real-time transcription

Live transcription does not repeatedly process the entire recording.

Instead, the backend advances a word-level commit boundary and sends only audio after that boundary (with a small overlap) to live Whisper passes.

This avoids repeatedly transcribing already committed leading speech during live updates.

```text
Incoming audio
      │
      ▼
┌───────────────┐
│ Rolling audio │
│    window     │
└───────┬───────┘
        │
        ▼
     Whisper
        │
        ▼
┌────────────────────┐
│ Word-level commit  │
│     boundary       │
└─────────┬──────────┘
          │
          ▼
Frontend committed text
```

Commit boundaries are advanced only to recognized word boundaries rather than arbitrary character positions, reducing the chance of producing partial or corrupted words.

### 2. Pause-aware transcription commits

The backend monitors PCM audio energy to detect periods of silence.

During a pause, recognized speech can be force-committed instead of waiting indefinitely for additional audio.

The pause logic is gated on detected speech so that silence by itself does not cause Whisper to produce unnecessary hallucinated text.

### 3. Editable live transcription

The live transcript is intentionally divided into two regions:

- **Committed text** — editable by the user.
- **Provisional text** — temporary recognition output that can change as more audio arrives.

When the user edits committed text, incoming transcription updates must not simply replace the user's changes.

The frontend therefore maintains protected user-edited text and merges compatible backend updates using word/suffix-based comparison.

This is one of the highest-risk state-management boundaries in the application and is covered by automated tests.

### 4. Cursor and selection preservation

Live transcription updates can cause React-controlled textareas to re-render while a user is actively editing.

The application explicitly preserves the user's selection/cursor position when live committed text changes.

This prevents a common failure mode where incoming transcription causes the caret to jump to the end of the text or destroys an active selection.

### 5. Resource lifecycle management

Audio capture involves several independently acquired resources:

- Display capture stream
- Microphone stream
- `MediaRecorder`
- `AudioContext`
- Audio worklet
- WebSocket
- Recording timers

The capture hook tracks these resources so that partial initialization failures also release resources correctly.

For example, if microphone initialization fails after screen capture has already succeeded, the previously acquired screen stream is still cleaned up.

Recorder failures also terminate the recording timer and send the existing WebSocket stop message exactly once.

### 6. Persistent meeting workspace and full-text search

Saved meetings are persisted by the FastAPI backend in SQLite; the browser uses the meeting REST API as its source of truth. A selected meeting restores its editable title, raw and cleaned transcript, type, metadata, and user notes.

SQLite FTS5 indexes meeting titles (`filename`), cleaned transcripts, and notes. The frontend submits an explicit search request to `GET /api/meetings/search`, receives matching meeting records from the backend, and can open a result in the existing workspace. The browser does not filter the full meeting collection in memory.

The FTS index is an external-content index over the authoritative `meetings` table. SQLite triggers keep it synchronized when searchable fields are created, updated, or deleted.

### 7. Containerized development environment

Development is performed inside a Linux Docker/Dev Container environment.

Frontend dependencies are stored in a Docker-managed Linux volume rather than the Windows workspace:

```text
Windows workspace
       │
       ├── source code ───────────────► bind mount
       │
       └── frontend/node_modules ────► Linux Docker volume
```

This prevents platform-specific native packages such as Rollup binaries from being contaminated by installing Linux dependencies into a Windows-visible `node_modules` directory.

The environment uses:

- Node.js
- Python
- `uv`
- NVIDIA CUDA support
- Docker-managed frontend dependencies

---

## Testing

The frontend Vitest suite and backend pytest suite focus on the application's highest-risk state and resource boundaries rather than attempting to test every UI component independently.

### Current coverage includes

#### Live transcription

- Committed transcript updates
- Provisional transcript updates
- User edits during live transcription
- Backend commits after user edits
- Equal/shrinking backend commits
- Final transcript handling
- Malformed WebSocket messages
- Binary/unknown messages
- Edited final transcript behavior

#### Cursor preservation

- Focused textarea editing
- Selection preservation during live transcript updates
- Selection clamping when text changes

#### Audio capture

- WebSocket startup/shutdown
- WebSocket error and close handling
- Recording lifecycle
- Timer cleanup
- Stream cleanup
- AudioContext cleanup
- Microphone permission failures
- Missing microphone tracks
- MediaRecorder construction/start failures
- MediaRecorder error cleanup

#### Session persistence

- Backend meeting API loading and failure recovery
- Creation, partial updates, duplicate-source handling, and deletion
- Editable meeting title and persisted notes
- Meeting workspace restoration from persisted data
- Backend/database-backed search requests, results, empty states, and failures

#### AI cleanup

- Request payload construction
- Meeting type
- Custom system prompts
- Empty input handling
- Backend failure handling
- Loading/processing state
- Regeneration
- Unmount safety

#### Push-to-talk

- Press/release behavior
- Repeated key protection
- Recording/processing guards
- Input/textarea/contenteditable protection
- Listener cleanup

#### Backend live transcription

- Word-boundary commit progression and overlapping-window deduplication
- Provisional transcript changes and final-transcript fallback
- PCM RMS speech/silence gating and pause-triggered commits
- Malformed control messages, disconnect cancellation, and live-model failures

### Validation

The project uses automated checks for:

```text
TypeScript type checking
        │
        ▼
ESLint
        │
        ▼
Prettier formatting
        │
        ▼
Vitest
        │
        ▼
Production build
```

Python development checks include:

```text
pytest
        │
        ▼
ruff
black
```

---

## Project Structure

```text
.
├── .devcontainer/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── devcontainer.json
│   └── post-create.sh
│
├── backend/
│   ├── app.py
│   ├── transcription.py
│   ├── system_prompt.txt
│   ├── Dockerfile
│   ├── compose.yml
│   ├── pyproject.toml
│   └── .env.example
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── styles/
│   │   └── types/
│   ├── package.json
│   └── vite.config.ts
│
└── README.md
```

### Important frontend modules

```text
src/
├── App.tsx
│   └── Application-level state and workflow
│
├── hooks/
│   ├── useAudioCapture.ts
│   │   └── Browser recording + WebSocket lifecycle
│   │
│   ├── useLiveTranscript.ts
│   │   └── Committed/provisional transcript state
│   │
│   ├── useTranscriptCleanup.ts
│   │   └── AI cleanup / note generation
│   │
│   ├── useMeetingSessions.ts
│   │   └── Backend meeting CRUD and search
│   │
│   └── usePushToTalk.ts
│       └── Keyboard recording control
│
└── components/
    └── Presentation and UI components
```

---

## Features

### Live transcription

- Real-time audio streaming
- Whisper-based transcription
- Rolling-window processing
- Provisional transcription
- Word-level commit boundaries
- Pause-aware commits

#### Backend meeting persistence and search

- SQLite schema and meeting CRUD API contracts
- FTS5 search by title, cleaned transcript, and notes
- Safe empty, no-match, and special-character queries
- FTS synchronization after meeting updates and deletion

### Transcript editing

- Fully editable committed transcript
- User edits protected from incoming recognition updates
- Cursor/selection preservation during live updates

### AI meeting notes

- Structured meeting summaries
- Meeting-specific types/prompts
- Configurable system prompt
- Local LLM support through an OpenAI-compatible API
- Raw transcription remains available if AI cleanup is disabled

### Meeting management

- Persist meetings in SQLite through the FastAPI REST API
- Rename meetings using the existing filename field
- Edit saved transcripts and user notes
- Restore a selected meeting workspace after reload
- Search titles, cleaned transcripts, and notes through SQLite FTS5
- Delete meetings

### Recording controls

- Start/stop recording
- Push-to-talk support
- Microphone capture
- Screen/audio capture
- Recording timer
- Error recovery and resource cleanup

---

## Backend API and WebSocket Contract

### REST API

| Method   | Path                             | Request                                                                                          | Success response                                                        | Important failures                                                                                                   |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/status`                    | None                                                                                             | `status`, `whisper_model`, `llm_model`, `llm_base_url`                  | `status` is `initializing` until the service exists.                                                                 |
| `GET`    | `/api/system-prompt`             | None                                                                                             | `{ "default_prompt": string }`                                          | `503` when the service is not ready.                                                                                 |
| `GET`    | `/api/meetings`                  | None                                                                                             | Array of persisted meeting records                                      | `503` when meeting storage is unavailable.                                                                           |
| `GET`    | `/api/meetings/search?q=<query>` | URL query                                                                                        | Matching persisted meeting records; empty/whitespace query returns `[]` | `503` when meeting storage is unavailable. Search covers `filename`, `cleanedText`, and `notes` through SQLite FTS5. |
| `POST`   | `/api/meetings`                  | JSON meeting record                                                                              | Created meeting record                                                  | `409` for duplicate ID/source key; `503` when storage is unavailable.                                                |
| `GET`    | `/api/meetings/{id}`             | None                                                                                             | Persisted meeting record                                                | `404` if missing; `503` when storage is unavailable.                                                                 |
| `PATCH`  | `/api/meetings/{id}`             | JSON with one or more changed meeting fields                                                     | Updated meeting record                                                  | `404` if missing; `409` for duplicate source key; `422` with no changes.                                             |
| `DELETE` | `/api/meetings/{id}`             | None                                                                                             | `204 No Content`                                                        | `404` if missing; `503` when storage is unavailable.                                                                 |
| `POST`   | `/api/transcribe`                | `multipart/form-data` with required `audio` file                                                 | `{ "success": true, "text": string }`                                   | `503` if unready; `500` if file transcription fails.                                                                 |
| `POST`   | `/api/clean`                     | JSON: required `text`; optional `system_prompt`; optional `meeting_type` (defaults to `general`) | `{ "success": true, "text": string }`                                   | FastAPI validation errors for invalid JSON; `503` if unready; `502` if LLM cleanup fails.                            |

### Live transcription WebSocket

Connect to `/ws/transcribe`. The server accepts the connection, then sends `ready` after a client `start` control message. The browser currently sends `sample_rate: 48000`, `channels: 1`, `include_microphone`, and `language` alongside `type: "start"`; the backend recognizes `type` and does not validate those extra fields.

Client messages:

- JSON `{ "type": "start" }` starts or resets one live session.
- Binary frames are 48 kHz, mono, signed 16-bit PCM audio chunks.
- JSON `{ "type": "stop" }` ends live capture and starts one final transcription pass.

Server messages:

- `ready` includes a human-readable `message`.
- `transcript` includes `committed_text`, provisional `partial_text`, and timed `segments`. Committed text advances only at recognized word ends; partial text may shrink or be replaced.
- `final` includes the final full-recording `text`, plus matching `committed_text` and an empty `partial_text`, then closes with code `1000`.

Malformed JSON, JSON values that are not objects, unknown control messages, and binary data before `start` are ignored. A client disconnect cancels any active live task. A live-window transcription failure is logged and the final full-recording pass is still attempted. If the final pass returns empty text, the handler currently sends no `final` message.

## Backend Configuration

Backend startup requires the first three values below. `LLM_API_KEY` is optional
for local Ollama and other providers that do not require a key:

| Variable        | Purpose                                                          |
| --------------- | ---------------------------------------------------------------- |
| `WHISPER_MODEL` | Faster-Whisper model name, for example `base.en`.                |
| `LLM_BASE_URL`  | OpenAI-compatible LLM API base URL.                              |
| `LLM_API_KEY`   | Optional API key passed to the configured LLM provider.          |
| `LLM_MODEL`     | LLM model name used for cleanup.                                 |

Copy `backend/.env.example` to `backend/.env` for the local development defaults. The backend tries the LLM connection at startup but logs a warning rather than failing if that check cannot connect.

## Local LLM Configuration

The cleanup pipeline communicates with an OpenAI-compatible API.

For example, using Ollama:

```env
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=your-model-name
```

Other OpenAI-compatible providers can also be used.

If LLM cleanup is disabled or unavailable, the application can still provide the raw Whisper transcription.

### Meeting storage

SQLite remains the default local and Electron storage backend. To use PostgreSQL
in a future server deployment, install the optional driver and configure:

```bash
cd backend
uv sync --extra postgres --extra dev
```

```env
MEETING_STORAGE_BACKEND=postgresql
POSTGRES_DATABASE_URL=postgresql://user:password@host:5432/meeting_notes
```

PostgreSQL uses native full-text search across meeting titles, cleaned
transcripts, and notes. SQLite continues to use FTS5 unchanged.

The PostgreSQL repository integration test is intentionally opt-in and never
uses the desktop SQLite database:

```bash
cd backend
POSTGRES_TEST_DATABASE_URL=postgresql://user:password@host:5432/meeting_notes uv run --extra postgres pytest tests/test_postgres_storage.py
```

### Remote authentication

Authentication is disabled by default, so the existing local browser and
Electron workflows continue to use SQLite without login. Remote authentication
requires PostgreSQL and an environment-provided session secret:

```bash
cd backend
uv sync --extra postgres --extra auth --extra dev
```

```env
MEETING_STORAGE_BACKEND=postgresql
POSTGRES_DATABASE_URL=postgresql://user:password@host:5432/meeting_notes
AUTH_ENABLED=1
AUTH_SESSION_SECRET=replace-with-a-random-secret-at-least-32-characters-long
AUTH_COOKIE_SECURE=1
```

The backend stores Argon2 password hashes and only HMAC hashes of opaque
session tokens. Login sets an HttpOnly, SameSite=Lax cookie. Set
`AUTH_COOKIE_SECURE=0` only for an HTTPS-free local remote-auth development
environment; production deployments should retain the secure-cookie default.

---

## Development

The recommended development environment is the project's Docker Dev Container.

### Backend

```bash
cd backend
uv sync --extra dev
```

Configure the environment:

```bash
cp .env.example .env
```

Start FastAPI:

```bash
uv run uvicorn app:app --reload --host 0.0.0.0 --port 8000 --timeout-keep-alive 600
```

### Backend runtime container

The Dev Container is for interactive development; `backend/Dockerfile` is a separate, non-root FastAPI runtime image. It reuses the established CUDA 12.3 + cuDNN 9, Python 3.12, and locked `uv` dependency stack. It contains no `.env`, frontend dependencies, or host GPU drivers.

Docker Desktop with WSL2 and NVIDIA container support is required for the GPU path. The runtime receives its existing configuration only from `backend/.env` and exposes FastAPI on host port `8000`:

```bash
cd backend
cp .env.example .env
docker compose up --build
```

The compose file requests the host GPU and stores downloaded Whisper models in a Docker-managed volume. It does not start an LLM service. To use the existing Dev Container Ollama service from this separate backend container, set this in `backend/.env` before starting it:

```env
LLM_BASE_URL=http://host.docker.internal:11435/v1
```

`host.docker.internal` is provided by Docker Desktop. Other OpenAI-compatible providers should use their reachable base URL instead. Stop the runtime with `docker compose down`; the named model-cache volume is retained.

The default host mapping is `8000:8000`. The active Dev Container also reserves host port `8000`; run the runtime alongside it with a different host port instead:

```bash
BACKEND_HOST_PORT=8001 docker compose up --build
```

When the Vite development server runs inside the Dev Container, configure its proxy to reach this separate runtime in `frontend/.env`, then restart Vite:

```env
VITE_BACKEND_URL=http://host.docker.internal:8000
```

The browser-facing WebSocket fallback remains `ws://<page-host>:8000/ws/transcribe`, so local browser development continues to use the published backend port. If using the parallel `8001` mapping, set `VITE_BACKEND_URL=http://host.docker.internal:8001` and `VITE_BACKEND_PORT=8001`; set `VITE_WS_URL` only when a different WebSocket base URL is needed.

### Frontend

```bash
cd frontend
npm ci
npm run dev
```

The frontend is normally available at:

```text
http://localhost:3000
```

---

## Validation Commands

### Frontend

```bash
cd frontend

npm run type-check
npm run lint
npm run format:check
npm run test:run
npm run build
```

### Backend

```bash
cd backend

uv run ruff check .
uv run black --check .
uv run pytest
```

---

## Engineering Priorities

The project is being developed incrementally, with reliability and architectural stability prioritized before adding larger product features.

The current priority order is:

```text
Testing / stabilization
        │
        ▼
Export workflows
        │
        ▼
Windows desktop packaging
        │
        ▼
Remote backend + PWA
        │
        ▼
Speaker diarization
        │
        ▼
iOS packaging
```

The goal is to establish reliable application behavior and a maintainable architecture before introducing additional deployment targets.

---

## Roadmap

### Phase 1 — Stabilization

- [x] Frontend automated test suite
- [x] Live transcription/edit-protection tests
- [x] Cursor preservation tests
- [x] Audio lifecycle/error tests
- [x] Meeting persistence tests
- [x] AI cleanup tests
- [x] Push-to-talk tests
- [x] Containerized development environment
- [x] Backend transcription, pause-detection, and WebSocket lifecycle tests

### Phase 2 — Backend delivery

- [x] Containerized FastAPI runtime image
- [x] Persisted model cache and meeting database volumes
- [x] Reproducible Dev Container validation environment

### Phase 3 — Persistent meeting workspace

- [x] SQLite meeting persistence and REST CRUD API
- [x] Persistent workspace with editable titles, notes, transcripts, and metadata
- [x] Backend/database-backed full-text meeting search
- [x] Search by title, cleaned transcript, and notes through SQLite FTS5

### Phase 4 — Meeting productivity

- [ ] Export to Markdown
- [ ] Export to PDF
- [ ] Additional meeting metadata and filtering

### Phase 5 — Desktop application

- [ ] Package frontend as a Windows application with Electron
- [ ] Integrate local backend/runtime
- [ ] Desktop-specific recording and lifecycle handling

### Phase 6 — Remote deployment

- [ ] Deploy backend remotely
- [ ] Convert frontend into a PWA
- [ ] Production WebSocket/API configuration
- [ ] Authentication and secure transport
- [ ] Production monitoring/error handling

### Phase 7 — Advanced transcription

- [ ] Speaker diarization
- [ ] Speaker-aware transcripts
- [ ] Improved transcript segmentation

### Phase 8 — Mobile

- [ ] Package application for iOS with Capacitor
- [ ] Adapt audio capture to mobile constraints
- [ ] Mobile-specific backend/network behavior

---

## Engineering Lessons / Design Goals

This project is intentionally being developed around real engineering constraints rather than only feature development.

Important design goals include:

- **Bounded processing:** avoid algorithms whose cost grows excessively with meeting length.
- **Explicit state boundaries:** separate provisional recognition state from user-owned editable state.
- **Failure-safe resource ownership:** clean up partially initialized audio resources.
- **Deterministic persistence:** treat SQLite and the meeting REST API as the source of truth, with synchronized full-text indexing.
- **Test high-risk behavior:** prioritize state transitions, asynchronous boundaries, and resource lifecycles.
- **Reproducible development:** use a containerized environment with isolated platform-specific dependencies.
- **Incremental architecture:** stabilize core behavior before adding deployment targets and advanced features.

These constraints are particularly important in a real-time application because failures often occur at the boundaries between asynchronous systems rather than in the individual components themselves.

---

## Why I Built This

This project explores the engineering challenges involved in building a real-time application that combines:

- Browser audio capture
- Streaming communication
- Speech recognition
- Asynchronous state updates
- Editable real-time data
- Local AI inference
- Persistent application state
- Resource lifecycle management
- Automated testing
- Containerized development

The primary objective is to build a practical application while demonstrating the ability to reason about **system boundaries, failure modes, performance, and maintainability**.

---

## License

This project is currently a personal portfolio project.
