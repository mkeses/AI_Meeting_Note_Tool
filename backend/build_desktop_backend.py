"""Build the Windows one-folder backend artifact with PyInstaller."""

from __future__ import annotations

import platform
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

BACKEND_DIRECTORY = Path(__file__).resolve().parent
PACKAGE_NAME = "ai-meeting-note-backend"
SPECIFICATION_PATH = BACKEND_DIRECTORY / "packaging" / "desktop_backend.spec"
DIST_DIRECTORY = BACKEND_DIRECTORY / "dist" / "windows-backend"
WORK_DIRECTORY = BACKEND_DIRECTORY / "build" / "windows-backend"


def require_windows_x64(
    *, system_name: str | None = None, machine_name: str | None = None
) -> None:
    """Reject builds that cannot produce the intended Windows x64 artifact."""
    system_name = system_name or platform.system()
    machine_name = machine_name or platform.machine()

    if system_name != "Windows" or machine_name.lower() not in {"amd64", "x86_64"}:
        raise RuntimeError(
            "Windows x64 is required to build the desktop backend. "
            "PyInstaller does not cross-compile this artifact."
        )


def create_pyinstaller_command(*, python_executable: str = sys.executable) -> list[str]:
    """Return the reproducible PyInstaller command for the one-folder build."""
    return [
        python_executable,
        "-m",
        "PyInstaller",
        str(SPECIFICATION_PATH),
        "--noconfirm",
        "--clean",
        "--distpath",
        str(DIST_DIRECTORY),
        "--workpath",
        str(WORK_DIRECTORY),
    ]


def build_backend(
    *,
    command_runner: Callable[..., object] = subprocess.run,
    python_executable: str = sys.executable,
) -> Path:
    """Build the backend without reading or writing any runtime data directory."""
    require_windows_x64()
    command_runner(
        create_pyinstaller_command(python_executable=python_executable),
        check=True,
        cwd=BACKEND_DIRECTORY,
    )
    return DIST_DIRECTORY / PACKAGE_NAME / f"{PACKAGE_NAME}.exe"


def main(argv: Sequence[str] | None = None) -> None:
    """Build the checked-in desktop backend specification."""
    if argv:
        raise SystemExit("This build command does not accept arguments.")

    artifact = build_backend()
    print(f"Built desktop backend: {artifact}")


if __name__ == "__main__":
    main(sys.argv[1:])
