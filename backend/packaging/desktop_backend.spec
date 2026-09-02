# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller one-folder build for the Windows desktop backend."""

from pathlib import Path

from PyInstaller.utils.hooks import collect_dynamic_libs

BACKEND_DIRECTORY = Path(SPECPATH).resolve().parent.parent
PACKAGE_NAME = "ai-meeting-note-backend"

# `app` is intentionally imported only after command-line parsing so `--help`
# remains cheap. Include that deferred import explicitly. CTranslate2 loads its
# native runtime from package files, so collect its DLLs deliberately.
analysis = Analysis(
    [str(BACKEND_DIRECTORY / "desktop_backend_entry.py")],
    pathex=[str(BACKEND_DIRECTORY)],
    binaries=collect_dynamic_libs("ctranslate2"),
    datas=[(str(BACKEND_DIRECTORY / "system_prompt.txt"), ".")],
    hiddenimports=["app"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

archive = PYZ(analysis.pure)

executable = EXE(
    archive,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name=PACKAGE_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

bundle = COLLECT(
    executable,
    analysis.binaries,
    analysis.zipfiles,
    analysis.datas,
    strip=False,
    upx=False,
    name=PACKAGE_NAME,
)
