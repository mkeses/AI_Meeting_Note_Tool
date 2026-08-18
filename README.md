# Signal Notes

A local-first AI transcription app for turning meeting audio into clean, structured notes.

Signal Notes records microphone and desktop audio in the browser, transcribes recordings with Whisper, and optionally cleans and organizes the transcript with an OpenAI-compatible language model.

## Features

- Browser-based microphone and desktop-audio recording.
- Upload existing audio files.
- Local speech-to-text transcription with Whisper.
- Optional AI cleanup for filler-word removal, grammar correction, and organization.
- Meeting presets for general meetings, design reviews, debugging sessions, and standups.
- Customizable cleanup system prompt.
- One-click transcript copying.
- OpenAI-compatible LLM support through Ollama, LM Studio, OpenAI, or another compatible provider.
- Dev Container setup for reproducible development.

## Architecture

```text
Browser
  ├── React + TypeScript frontend
  ├── Microphone and desktop-audio capture
  └── Audio upload
        ↓
FastAPI backend
  ├── Whisper transcription
  └── LLM-based transcript cleanup
```

The browser records audio only. Screen video is requested by the browser's screen-capture API when desktop audio is selected, but it is not included in the recorded file.

## Requirements

For the recommended setup:

- Docker Desktop.
- VS Code.
- The VS Code Dev Containers extension.
- A browser with microphone and screen-capture support, such as Chrome or Edge.

For manual setup:

- Python 3.12 or newer.
- Node.js.
- `uv`.
- Ollama, LM Studio, OpenAI, or another OpenAI-compatible LLM provider.

## Development with Dev Containers

1. Open the repository in VS Code.
2. Run **Dev Containers: Reopen in Container** from the Command Palette.
3. Wait for the container setup to complete.
4. Open the application at [http://localhost:3000](http://localhost:3000).

The Dev Container is the recommended development environment because it provides the backend and frontend dependencies in a consistent setup.

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

## Recording notes

- Microphone access must be allowed in the browser.
- Desktop-audio availability depends on the browser, operating system, selected sharing surface, and output device.
- For system audio, choose **Entire screen** and enable **Share system audio** when the browser provides that option.
- Tab-audio capture is generally more widely supported than system-audio capture.
- Some USB or Bluetooth output devices may not support browser system-audio loopback capture. If that occurs, try another output device or use an audio-routing solution.

## Project structure

```text
.
├── backend/       FastAPI API, transcription, and LLM cleanup
├── frontend/      React and TypeScript interface
└── .devcontainer/ Development container configuration
```

## Current status

This is an actively developed personal project. The core recording, transcription, cleanup, upload, and review workflow is functional. Browser and operating-system differences may affect desktop-audio capture.
