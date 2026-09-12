# Windows Backend Packaging

The Electron app and FastAPI backend are packaged separately so the installed
desktop app can launch a local backend without requiring an end user to have
Python or `uv`. This first target is a **Windows x64 CPU** PyInstaller
one-folder bundle. One-folder packaging keeps native dependency files visible
and diagnosable; it is not an installer.

The bundle contains the Python runtime, backend application code, FastAPI,
Uvicorn, Faster-Whisper/CTranslate2 dependencies, and `system_prompt.txt`.
It deliberately excludes SQLite data, WAL/SHM files, logs, runtime state,
Whisper model weights, Hugging Face downloads, Ollama model weights, and
credentials. The Electron Windows package separately stages a pinned Ollama
standalone runtime under `resources\ollama\`.

Electron owns mutable runtime data under `%LOCALAPPDATA%\AI Meeting Note Tool\`
and supplies `DATABASE_PATH`, `HF_HOME`, `OLLAMA_MODELS`, `WHISPER_MODEL`,
`LLM_BASE_URL`, and `LLM_MODEL` when it launches the backend. Faster-Whisper can
download its configured model on first use into `HF_HOME`. The Electron
runtime starts the bundled Ollama service when a compatible user-owned endpoint
with the required model is not already available, and supplies `OLLAMA_MODELS`
as the application-owned model directory. Ollama models are still provisioned
on first use and are not part of the installer.

## Bundled Ollama runtime

The Windows packaging command downloads and verifies the official standalone
Ollama archive pinned by the Electron packaging code:

```text
Version: 0.34.0
Archive: ollama-windows-amd64.zip
Destination: resources\ollama\
Model directory: %LOCALAPPDATA%\AI Meeting Note Tool\models\ollama
```

The archive is verified with its SHA-256 checksum and copied as a complete
runtime directory. The package does not guess or selectively copy internal
Ollama files. The download is cached under `dist\ollama-runtime\v0.34.0` and
is not source-controlled.

The runtime is started with `ollama serve` on loopback only. It is an
application-owned process when Electron starts it, and it is stopped on normal
application shutdown. A user-owned Ollama endpoint is never stopped. If a
user-owned endpoint is running but does not contain the configured model, the
application does not pull into that endpoint; it prefers the bundled runtime
and its separate application model directory.

If Ollama cannot be started or the model cannot be downloaded, the backend can
still become usable when Whisper is ready. Transcription remains available and
LLM cleanup reports a recoverable provider-unavailable/model-unavailable
condition.

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

For a backend-only smoke test, start Ollama (or another compatible endpoint),
then use temporary runtime paths so the normal Electron data is untouched:

```powershell
$smokeRoot = Join-Path $env:TEMP 'ai-meeting-note-backend-smoke'
$env:DATABASE_PATH = Join-Path $smokeRoot 'data\meetings.db'
$env:HF_HOME = Join-Path $smokeRoot 'models\huggingface'
$env:OLLAMA_MODELS = Join-Path $smokeRoot 'models\ollama'
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
The packaged backend binds only to `127.0.0.1`. Windows GPU/CUDA Whisper
execution is intentionally out of scope; the current packaged Whisper path is
CPU/int8. CTranslate2's Windows wheel may require the Microsoft Visual C++
runtime on machines that do not already have it.

## Package with Electron

After building this Windows one-folder backend, package the Electron app from
`frontend/` on Windows x64:

```powershell
npm run package:win
```

The package command validates this artifact, downloads/verifies the pinned
Ollama runtime when it is not already cached, then copies the complete
`ai-meeting-note-backend` directory into `resources\backend\` and the complete
Ollama runtime into `resources\ollama\`. It writes the Windows app folder under
`dist\windows-electron\` and the Squirrel installer under
`dist\windows-installer\`. Do not delete `_internal`, `resources\ollama\`, or
copy only an executable.

The first packaged launch may require Internet access for the `base.en`
Whisper model and `gemma3:4b`. Both are stored persistently under the
application's LocalAppData model directories after provisioning. The bundled
runtime is updated with a new application package; model data remains outside
the installation directory and survives normal application upgrades.
