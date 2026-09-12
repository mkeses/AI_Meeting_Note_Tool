# Windows Backend Packaging

The Electron app and FastAPI backend are packaged separately so the installed
desktop app can launch a local backend without requiring an end user to have
Python or `uv`. This is a Windows x64 PyInstaller one-folder bundle with an
automatic CUDA/FP16 Whisper path and CPU/int8 fallback. One-folder packaging
keeps native dependency files visible and diagnosable; it is not an installer.

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

The complete archive includes the CUDA 12.8 runtime under
`resources\ollama\lib\ollama\cuda_v12\`. When the packaged backend is
launched, Electron validates `cublas64_12.dll`, `cublasLt64_12.dll`, and
`cudart64_12.dll` in that exact directory and prepends only that directory to
the backend child process `PATH`. It does not change the global Windows
`PATH`, and development launches do not receive the packaged path.

The frozen CTranslate2 4.8.1 backend already includes `cudnn64_9.dll` (cuDNN
9.10.2). Its CUDA 12 BLAS dependency is satisfied by the pinned Ollama CUDA
runtime; the runtime remains optional because Faster-Whisper falls back to
CPU/int8 when CUDA cannot initialize. The complete Ollama archive, including
its third-party notices such as `lib\ollama\CUDNN_LICENSE.txt`, must remain
intact. CUDA Runtime/cuBLAS redistribution is governed by the CUDA Toolkit
EULA, and cuDNN runtime redistribution is governed by the cuDNN Software
License Agreement; review the applicable NVIDIA terms for each release before
updating the pinned runtime.

The runtime is started with `ollama serve` on loopback only. It is an
application-owned process when Electron starts it, and Windows shutdown targets
that recorded PID and its live process tree so Ollama inference children do not
survive the app. A user-owned Ollama endpoint is never stopped. If a
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
The packaged backend binds only to `127.0.0.1`. `WHISPER_DEVICE=auto` prefers
CUDA/float16 and safely falls back to CPU/int8; `WHISPER_DEVICE=cpu` always
uses CPU/int8. NVIDIA GPU acceleration requires a compatible NVIDIA driver,
but does not require an end user to install the CUDA Toolkit. CTranslate2's
Windows wheel may require the Microsoft Visual C++ runtime on machines that do
not already have it.

## Package with Electron

After building this Windows one-folder backend, package the Electron app from
`frontend/` on Windows x64:

```powershell
npm run package:win
```

The package command validates this artifact, downloads/verifies the pinned
Ollama runtime when it is not already cached, then uses electron-builder's
standard NSIS target to embed the complete backend under `resources\backend\`
and complete Ollama runtime under `resources\ollama\`. It writes a standalone
installer to `dist\windows-installer-nsis\AI Meeting Note Tool Setup <version>.exe`
and an unpacked inspection directory beside it. The release artifact is the one
installer executable; it does not require Squirrel `.nupkg` or `RELEASES`
companion files. Do not delete `_internal`, `resources\ollama\`, or copy only an
executable.

The NSIS package uses the stable Windows application identifier
`com.mkeses.ai-meeting-note-tool`; keep it unchanged so future reinstall and
upgrade behavior continues to target the same application.

The first packaged launch may require Internet access for the `base.en`
Whisper model and `gemma3:4b`. Both are stored persistently under the
application's LocalAppData model directories after provisioning. The bundled
runtime is updated with a new application package; model data remains outside
the installation directory and survives normal application upgrades.

On startup, the desktop application presents a small setup window while it
starts Ollama, provisions `gemma3:4b` when required, and prepares the backend.
Ollama's native pull progress is displayed when available. Faster-Whisper does
not expose reliable model-download progress, so transcription preparation is
shown as an indeterminate state. If local AI cleanup cannot be provisioned, the
user can retry or continue with transcription only. This does not change the
application-owned model directories or process-ownership rules.

The NSIS installer is currently unsigned. Configure Authenticode signing before
external distribution and verify the final installer and project-owned backend
executable signatures on the release machine.
