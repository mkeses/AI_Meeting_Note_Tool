# Repository Guidelines

## Architecture and Boundaries

- `frontend/` is a React 19 + TypeScript Vite app. Put reusable UI in `src/components/`, feature logic in `src/hooks/`, and audio worklets in `src/audio/`. `App.tsx` is the current workflow orchestrator; extract cohesive features rather than adding unrelated state there.
- `backend/app.py` owns FastAPI routes. `transcription.py` owns Faster-Whisper and the OpenAI-compatible LLM client; `system_prompt.txt` is the default prompt. Keep model work and route policy separable and testable.
- Sessions live in browser `localStorage`; there is no backend database or server-side meeting storage.

## Development Commands

Requirements are Python 3.12+ and Node 24+. From `backend/`, run `uv sync`, copy `.env.example` to `.env`, then run `uv run uvicorn app:app --reload --host 0.0.0.0 --port 8000`. From `frontend/`, run:

```powershell
npm install
npm run dev
npm run type-check
npm run lint
npm run test:run
npm run format:check
npm run build
```

`build` writes `frontend/dist/`. The CUDA/Ollama `.devcontainer/` is development tooling, not a production image.

## Contracts, Correctness, and Tests

The live protocol is a compatibility boundary: client sends `{"type":"start"}`, 48 kHz mono signed-16-bit PCM chunks, then `{"type":"stop"}`. Server emits `ready`, `transcript` (`committed_text`, `partial_text`, `segments`), and `final`. Committed text is editable; partial text is provisional. Document and test every protocol, audio-format, or lifecycle change.

Vitest/Testing Library tests live beside frontend hooks as `*.test.ts`; cover state transitions, failure paths, browser APIs, and edit-protection merges. There are no backend pytest tests or pytest configuration yet. Add focused mocked tests before changing rolling-window, word-boundary, pause, or protocol behavior.

## Style and Workflow

Prettier enforces two spaces, semicolons, single quotes, trailing commas, and 80-column formatting. TypeScript is strict: use PascalCase components, `useX` hooks, and narrow types. Python follows the Black/Ruff settings: four spaces, `snake_case` functions, and `PascalCase` classes.

Use small, imperative commits; history uses `Fix ...` and `Refactor: ...`. PRs describe behavior, checks run, UI screenshots when relevant, and REST/WebSocket, configuration, or data-model impacts.

## Working Tree Safety

Treat existing working-tree changes as user-owned. Do not reset, discard, overwrite, or revert pre-existing changes unless the user explicitly requests that exact action. Work around unrelated changes and confirm scope before touching overlapping files.

## Configuration, Privacy, and Delivery

Keep `.env`, API keys, recordings, and transcripts out of Git. Backend startup unconditionally requires `WHISPER_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`; turning off frontend LLM cleanup does not bypass that validation. Treat transcript content as sensitive: avoid logging it and validate untrusted uploads and WebSocket input.

Remote/PWA, production Docker, diarization, Electron, and Capacitor are not implemented. The live socket is hard-coded to localhost despite the `VITE_WS_URL` template. Do not claim remote or platform support without validating configuration, WSS/authentication, resource limits, retention, and capture permissions.
