# Windows Backend Packaging

The Electron app and FastAPI backend are packaged separately so the installed
desktop app can launch a local backend without requiring an end user to have
Python or `uv`. This first target is a **Windows x64 CPU** PyInstaller
one-folder bundle. One-folder packaging keeps native dependency files visible
and diagnosable; it is not an installer.

The bundle contains the Python runtime, backend application code, FastAPI,
Uvicorn, Faster-Whisper/CTranslate2 dependencies, and `system_prompt.txt`.
It deliberately excludes SQLite data, WAL/SHM files, logs, runtime state,
Whisper model weights, Hugging Face downloads, Ollama, and credentials.

Electron owns mutable runtime data under `%LOCALAPPDATA%\AI Meeting Note Tool\`
and supplies `DATABASE_PATH`, `HF_HOME`, `WHISPER_MODEL`, `LLM_BASE_URL`, and
`LLM_MODEL` when it launches the backend. Models are downloaded on first use
into `HF_HOME`; Ollama remains an external prerequisite. The backend also
requires `LLM_API_KEY`, supplied outside the bundle.

## Build on Windows x64

Run from a Windows x64 PowerShell prompt:

```powershell
cd backend
uv python install 3.12.13
uv sync --locked --extra packaging
.\.venv\Scripts\Activate.ps1
python build_desktop_backend.py
```

`uv sync` creates the project environment; `uv` is a build-time dependency
only and is not required beside the packaged executable.

The artifact is:

```text
backend\dist\windows-backend\ai-meeting-note-backend\ai-meeting-note-backend.exe
```

Copy the entire `ai-meeting-note-backend` folder, not only the executable.
The build helper rejects non-Windows hosts because PyInstaller does not produce
a Windows executable from Linux or macOS.

## Windows smoke test

First, verify the packaged process starts without Python or `uv` at runtime:

```powershell
.\dist\windows-backend\ai-meeting-note-backend\ai-meeting-note-backend.exe --help
```

For a full service smoke test, start Ollama (or another compatible endpoint),
then use temporary runtime paths so the normal Electron data is untouched:

```powershell
$smokeRoot = Join-Path $env:TEMP 'ai-meeting-note-backend-smoke'
$env:DATABASE_PATH = Join-Path $smokeRoot 'data\meetings.db'
$env:HF_HOME = Join-Path $smokeRoot 'models\huggingface'
$env:WHISPER_MODEL = 'base.en'
$env:LLM_BASE_URL = 'http://127.0.0.1:11434/v1'
$env:LLM_API_KEY = 'ollama'
$env:LLM_MODEL = 'gemma3:4b'

.\dist\windows-backend\ai-meeting-note-backend\ai-meeting-note-backend.exe --port 8765
```

In another PowerShell window, wait for model initialization and verify:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/api/status
```

The first full startup can download the configured Whisper model into `HF_HOME`.
The packaged backend binds only to `127.0.0.1`. Windows GPU/CUDA execution and
installer integration are intentionally out of scope. CTranslate2's Windows
wheel may require the Microsoft Visual C++ runtime on machines that do not
already have it.

## Package with Electron

After building this Windows one-folder backend, package the Electron app from
`frontend/` on Windows x64:

```powershell
npm run package:win
```

The package command validates this artifact first, then copies the complete
`ai-meeting-note-backend` directory into the packaged app's
`resources\backend\` directory. It writes the Windows app folder under
`dist\windows-electron\`. Do not delete `_internal` or copy only the
executable.
