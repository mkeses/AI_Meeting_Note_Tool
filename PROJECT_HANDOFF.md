# Project handoff: current repository state

This document describes the implementation in this checkout as inspected on
2026-09-24. `README.md` contains broader explanatory and roadmap material; where
that differs from executable code, this handoff describes the code.

## 1. Repository structure

Generated output and dependencies are omitted here (`dist/`, build output,
`node_modules/`, virtual environments, caches, and lockfiles).

```text
.
├── .devcontainer/              Dev Container setup
├── AGENTS.md                   Repository-specific contributor instructions
├── README.md                   Architecture, development, and deployment guide
├── backend/
│   ├── app.py                  FastAPI REST/WebSocket app and lifecycle
│   ├── transcription.py        Faster-Whisper and meeting-intelligence service
│   ├── llm.py                  OpenAI-compatible meeting-intelligence client
│   ├── database.py             SQLite meeting/auth persistence
│   ├── postgres_database.py    PostgreSQL meeting/auth persistence
│   ├── storage.py              Storage protocols and repository selection
│   ├── meeting_*.py, user_entity.py, auth*.py
│   ├── settings.py             Environment validation/configuration
│   ├── model_provisioning.py   Model readiness and provisioning
│   ├── tests/                  pytest unit/contract/integration tests
│   ├── compose*.yml, Dockerfile*; nginx/; packaging/
│   └── system_prompt.txt
└── frontend/
    ├── src/App.tsx             Main workflow and workspace UI
    ├── src/components/         Auth, recording, settings, transcript UI
    ├── src/hooks/              Audio, transcript, auth, and meeting state
    ├── src/audio/              PCM AudioWorklet
    ├── src/lib/                 PDF report export
    ├── electron/               Electron shell, setup, and packaging scripts
    ├── public/                  PWA manifest, service worker, icon
    └── *.config.*, package.json, index.html
```

## 2. Frontend and state flow

- React 19, TypeScript, Vite 7; CSS Modules and global CSS. Vitest,
  Testing Library, jsdom, ESLint, and Prettier are configured.
- Browser entry is `frontend/index.html` → `frontend/src/main.tsx` →
  `frontend/src/App.tsx`. Electron starts at `frontend/electron/main.mjs` and
  loads the same renderer. `frontend/src/pwa.ts` registers the service worker
  for supported production HTTP(S) builds.
- `App.tsx` is the workflow coordinator. It renders the sign-in/register screen
  when authentication is required, otherwise the meeting workspace: settings,
  recording/upload/text-entry controls where enabled, live transcript editor,
  transcript/cleanup results, saved-meeting list/search, meeting notes, and
  report export. UI is split among `AuthScreen`, `SettingsPanel`, `RecordButton`,
  `UploadZone`, `TextInputZone`, and `TranscriptionResults`; some workspace and
  search layout remains inline in `App.tsx`.
- `useAuth` determines local/authenticated/unauthenticated/unavailable mode.
  `useAudioCapture` handles local/Electron capture and WebSocket lifecycle;
  `useBrowserAudioCapture` handles browser capture in authenticated mode;
  `useLiveTranscript` parses live messages and protects edited committed text;
  `useTranscriptCleanup` calls prompt/cleanup endpoints;
  `useMeetingSessions` loads and mutates meetings through REST. App state holds
  the selected meeting, current text, meeting type, notes, search, UI status,
  and controls. Meetings are not sourced from browser localStorage.
- Notes are held in React state and autosaved to `PATCH /api/meetings/{id}`
  after a 500 ms debounce. Transcript edits are saved through the explicit Save
  action. Live editor cursor/selection is restored after committed text updates.
- `frontend/src/config.ts` chooses API and WebSocket origins from the Electron
  bridge, `VITE_BACKEND_URL`, `VITE_WS_URL`, and local defaults. The PWA service
  worker caches the static app shell/assets only, not API or WebSocket traffic.

## 3. Backend, routes, protocol, and jobs

- Python 3.12+, FastAPI, Uvicorn, Pydantic; Faster-Whisper/CTranslate2 for
  speech recognition, OpenAI Python client for compatible LLM services.
  `backend/app.py` constructs the app and initializes model services and the
  selected repository in its lifespan. `backend/desktop_backend_entry.py`
  starts that app on loopback for the desktop build.
- REST routes in `backend/app.py`:
  - `GET /api/health`, `/api/ready`, `/api/status`
  - `GET /api/auth/csrf`, `POST /api/auth/register`, `/api/auth/login`,
    `/api/auth/logout`, `GET /api/auth/me` (auth-enabled deployments)
  - `GET/POST /api/meetings`, `GET /api/meetings/search?q=...`,
    `GET/PATCH/DELETE /api/meetings/{meeting_id}`
  - `GET /api/system-prompt`, `POST /api/transcribe`, `POST /api/clean`
  - WebSocket `/ws/transcribe`
- Local mode uses SQLite without login. Authenticated remote mode requires
  PostgreSQL and scopes meeting operations to the authenticated user. Auth uses
  an HttpOnly session cookie, CSRF protection for state-changing requests, and
  an in-memory login-attempt limiter in production.
- WebSocket client sends JSON `{"type":"start"}`, then binary PCM chunks,
  then `{"type":"stop"}`. Code and tests use 48 kHz mono signed 16-bit PCM.
  Server emits `ready`; zero or more `transcript` messages with
  `committed_text`, `partial_text`, and `segments`; and, after stop/final
  transcription, `final` with `text`, `committed_text`, and empty
  `partial_text`. Malformed control messages are ignored; size limits and
  remote live-audio limits are enforced. Disconnect cancels pending live work.
- Live Whisper runs in an `asyncio.create_task` scoped to the WebSocket and
  CPU/model work is moved through `asyncio.to_thread`; final transcription is
  run after stop. There is no durable task queue, scheduler, or independent
  background worker. The transcript cleanup endpoint makes a synchronous
  provider request. Startup provisions/loads runtime model resources.

## 4. Data model and persistence

- `Meeting` is a dataclass in `backend/meeting_entity.py`; API validation and
  camelCase JSON contracts are in `backend/meeting_models.py`. Stored fields:
  `id`, unique source key (owner-scoped in PostgreSQL), filename/title,
  created/updated timestamps, meeting type, raw transcript, cleaned transcript,
  source type, notes, and storage owner. Types are currently `general`,
  `design_review`, `debug_sync`, `standup`; source types are `recording`,
  `audio-file`, `text`.
- Default local persistence is SQLite at `DATABASE_PATH` (defaults to
  `data/meetings.db`). The repository creates tables/indexes and SQLite FTS5
  triggers at startup; it includes an in-code compatibility change for
  `owner_id` and rebuilds the FTS index. PostgreSQL schema/index creation and
  compatibility SQL are likewise in `postgres_database.py` startup. No
  standalone migration directory or migration framework was found.
- SQLite FTS5 and PostgreSQL full-text search cover filename, cleaned
  transcript, and notes. Raw transcript is not in the search index. Search
  responses are arrays and there is no pagination.
- Meetings, transcripts, and notes persist in the configured database.
  Uploaded audio is written to a temporary file for transcription and removed
  in `finally`; captured audio is streamed for transcription. Audio files are
  not stored as meeting records. There are no separate note or settings tables.
  The edited system prompt, cleanup toggle, capture preferences, and other UI
  controls are in-memory frontend state; their persistence across reloads is
  not implemented in the inspected code.
- Authenticated PostgreSQL additionally stores users (password hashes) and
  sessions (hashed opaque tokens and expiry). Secret values are deliberately
  omitted here.

## 5. Audio-to-meeting data flow

1. User records through a browser/Electron capture hook, uploads an audio file,
   or enters text. Recording capture streams PCM chunks on `/ws/transcribe`;
   file upload posts multipart audio to `/api/transcribe`; text bypasses
   Whisper.
2. Backend transcribes with Faster-Whisper. Live mode maintains a rolling
   buffer, checks audio energy/pause conditions, recognizes word timestamps,
   and emits committed plus provisional text. Stop triggers final
   transcription. Upload mode uses a temporary file that is deleted after use.
3. Frontend displays/edit-protects live committed text. Once a final transcript
   is available, `App.tsx` invokes `/api/clean` through
   `useTranscriptCleanup` when the LLM toggle is enabled. Meeting type and the
   current editable system prompt are sent with the request. If cleanup fails,
   the raw transcript remains available; the cleanup hook returns an empty
   cleaned value and surfaces an error.
4. Frontend creates or updates a meeting through the meeting REST API with raw
   text, cleaned text, type, source metadata, and notes. Recordings are first
   created as an empty meeting during capture and updated after finalization.
   Selected meeting data is restored from the API into React state. Notes are
   separately autosaved through meeting patches.
5. UI presents the saved meeting, offers transcript editing, notes, search,
   deletion, clipboard use, and PDF report export. The PDF is generated in the
   renderer; the database remains the persisted source of truth.

## 6. Implemented, partial, and absent features

**Implemented in code:** local recording and WebSocket transcription, uploaded
audio transcription, text input, live committed/provisional transcript
handling and edit protection, LLM transcript cleanup/meeting-type prompt,
SQLite meeting CRUD and search, notes autosave, transcript edits, auth-backed
PostgreSQL API, registration/login/logout, PWA static-shell service worker,
Electron shell/runtime support, and PDF report export. Test files cover major
frontend lifecycle/state paths and backend transcription, storage, auth, and
route contracts.

**Partially implemented / boundaries:** Authenticated remote workspace has
meeting CRUD/search and account UI but the README explicitly says recording,
audio upload, text transcription, and live controls are omitted in this mode.
The service worker provides an app shell, not offline meeting data or capture.
Settings and custom prompts are not saved. PDF export exists; broader export
workflows are still described as a development priority in README. Actual GPU
use depends on runtime availability/configuration; the service can fall back to
CPU/int8.

**Not present in the inspected source:** cross-meeting conversational chatbot,
speaker diarization, persisted audio, meeting pagination, and an independent
background-job system. `README.md` roadmap also names iOS packaging as future
work. Do not infer behavior from roadmap claims alone.

## 7. Local run and test commands

The README recommends the Docker Dev Container. A direct local development
setup, as documented, is:

```bash
cd backend
uv sync --extra dev
cp .env.example .env
# Configure the required variable names in backend/.env; values omitted here.
uv run uvicorn app:app --reload --host 0.0.0.0 --port 8000 --timeout-keep-alive 600
```

Backend startup requires `WHISPER_MODEL`, `LLM_BASE_URL`, and `LLM_MODEL`;
`LLM_API_KEY` is optional in `settings.py`. Other supported names include
`WHISPER_DEVICE`, `DATABASE_PATH`, `LLM_TIMEOUT_SECONDS`,
`MEETING_STORAGE_BACKEND`, `POSTGRES_DATABASE_URL`, `AUTH_ENABLED`,
`AUTH_SESSION_SECRET`, `AUTH_SESSION_LIFETIME_SECONDS`, `AUTH_COOKIE_SECURE`,
`REMOTE_CORS_ORIGINS`, `OLLAMA_MODELS`, `ELECTRON_DESKTOP_MODE`, and
`ELECTRON_RENDERER_ORIGIN`. Frontend configuration names include
`VITE_BACKEND_URL`, `VITE_BACKEND_PORT`, and `VITE_WS_URL`.

```bash
cd frontend
npm ci
npm run dev
```

Vite serves the frontend at `http://localhost:3000` and proxies `/api` to the
configured backend URL (default `http://localhost:8000`). The documented
Compose backend runtime is also available with `cd backend && docker compose
up --build`; it expects an untracked `.env` and stores SQLite data/model cache
in named volumes. PostgreSQL integration tests require a separately configured
test database and optional `postgres` dependency.

Checks documented by the repository:

```bash
cd frontend
npm run type-check
npm run lint
npm run format:check
npm run test:run
npm run test:electron
npm run build
npm run build:pwa
```

```bash
cd backend
uv run ruff check .
uv run black --check .
uv run pytest
```

## 8. Known limitations and TODOs

- `App.tsx` owns many cross-feature states and view branches; saved-meeting
  list/search and much workspace markup are not isolated components.
- Meeting list/search API has no pagination. Notes use client-side debounce;
  update requests have no version/ETag conflict contract, so concurrent edits
  from multiple clients can overwrite one another. This is an architectural
  limitation inferred from the patch contract and UI save flow.
- Custom prompt and UI settings have no persistence API. Audio is not retained,
  which rules out later reprocessing from stored source audio.
- Local SQLite schema evolution is handled in repository startup SQL rather
  than versioned migration files. PostgreSQL setup also uses startup DDL.
- README's priority/roadmap sections still call out broader export workflows,
  remote capture controls, diarization, and iOS work. `backend/PRODUCTION.md`
  states certificate issuance/renewal automation is not implemented and
  mentions planned schema migration review.
- Specific currently open code TODO/FIXME markers: none found in non-generated
  repository source/docs during this inspection. This does not establish that
  there are no untracked issues outside the checkout.

## 9. Paths for the requested future work

**(a) Cross-meeting chatbot** — likely integration points (no chatbot exists):

- `backend/app.py` — API route, auth/owner scope, request/response handling
- `backend/llm.py` — provider client and prompt construction
- `backend/storage.py` — meeting retrieval/search boundary
- `backend/database.py` and `backend/postgres_database.py` — persistence/query
- `backend/meeting_models.py` — meeting API schema conventions
- `frontend/src/App.tsx` — current workspace orchestration/integration point
- `frontend/src/api.ts` — API request and CSRF handling
- `frontend/src/hooks/useMeetingSessions.ts` — meeting workspace data access

**(b) Meeting search** — already implemented; primary files:

- `frontend/src/App.tsx` — query, result, loading, and result-selection UI
- `frontend/src/hooks/useMeetingSessions.ts` — search request and API state
- `frontend/src/api.ts` — backend fetch handling
- `backend/app.py` — `GET /api/meetings/search`
- `backend/storage.py` — search protocol and store construction
- `backend/database.py` — SQLite FTS5 query/index/triggers
- `backend/postgres_database.py` — PostgreSQL full-text query/index
- `backend/meeting_models.py` — meeting search result schema

**(c) Reliable note editing** — current debounce/save path and persistence:

- `frontend/src/App.tsx` — notes state, 500 ms autosave, save status
- `frontend/src/hooks/useMeetingSessions.ts` — `saveNotes`, meeting patch
- `frontend/src/api.ts` — API/CSRF fetch logic
- `backend/app.py` — `PATCH /api/meetings/{meeting_id}`
- `backend/meeting_models.py` — notes field and length validation
- `backend/database.py` and `backend/postgres_database.py` — notes update
  persistence and search-index maintenance

## 10. Git checkout

- Branch: `main`
- HEAD commit: `b8d619bffefc7abac02d2887d5592f2a9ed293cf`
- Before this handoff was created, the checkout had no uncommitted changes
  (`## main...origin/main` with no changed paths). After creating this file,
  the only uncommitted path is the new `PROJECT_HANDOFF.md`; no application
  files were changed.
