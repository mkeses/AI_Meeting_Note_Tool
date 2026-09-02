from __future__ import annotations

import ast

import pytest

from build_desktop_backend import (
    BACKEND_DIRECTORY,
    DIST_DIRECTORY,
    PACKAGE_NAME,
    SPECIFICATION_PATH,
    WORK_DIRECTORY,
    build_backend,
    create_pyinstaller_command,
    require_windows_x64,
)


def test_packaging_command_uses_the_checked_in_spec_and_isolated_build_output() -> None:
    command = create_pyinstaller_command(python_executable="python.exe")

    assert command == [
        "python.exe",
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
    assert DIST_DIRECTORY.parent == BACKEND_DIRECTORY / "dist"
    assert "data" not in DIST_DIRECTORY.parts
    assert "models" not in DIST_DIRECTORY.parts


def test_packaging_requires_a_windows_x64_build_host() -> None:
    require_windows_x64(system_name="Windows", machine_name="AMD64")

    with pytest.raises(RuntimeError, match="Windows x64"):
        require_windows_x64(system_name="Linux", machine_name="x86_64")


def test_spec_resolves_the_backend_directory_from_its_packaging_directory() -> None:
    specification = ast.parse(SPECIFICATION_PATH.read_text(encoding="utf-8"))
    backend_directory_assignment = next(
        statement
        for statement in specification.body
        if isinstance(statement, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "BACKEND_DIRECTORY"
            for target in statement.targets
        )
    )

    assert SPECIFICATION_PATH.parent.parent == BACKEND_DIRECTORY
    assert ast.unparse(backend_directory_assignment.value) == (
        "Path(SPECPATH).resolve().parent"
    )


def test_spec_collects_the_faster_whisper_package_asset_tree() -> None:
    specification = ast.parse(SPECIFICATION_PATH.read_text(encoding="utf-8"))
    analysis_call = next(
        statement.value
        for statement in specification.body
        if isinstance(statement, ast.Assign)
        and isinstance(statement.value, ast.Call)
        and isinstance(statement.value.func, ast.Name)
        and statement.value.func.id == "Analysis"
    )
    datas_keyword = next(
        keyword for keyword in analysis_call.keywords if keyword.arg == "datas"
    )

    assert isinstance(datas_keyword.value, ast.List)
    asset_collection = next(
        entry.value
        for entry in datas_keyword.value.elts
        if isinstance(entry, ast.Starred)
        and isinstance(entry.value, ast.Call)
        and isinstance(entry.value.func, ast.Name)
        and entry.value.func.id == "collect_data_files"
    )

    assert isinstance(asset_collection, ast.Call)
    assert ast.unparse(asset_collection) == (
        "collect_data_files('faster_whisper', includes=['assets/**'])"
    )


def test_build_returns_the_expected_one_folder_windows_artifact(monkeypatch) -> None:
    commands: list[tuple[list[str], dict[str, object]]] = []
    monkeypatch.setattr("build_desktop_backend.require_windows_x64", lambda: None)

    artifact = build_backend(
        python_executable="python.exe",
        command_runner=lambda command, **kwargs: commands.append((command, kwargs)),
    )

    assert artifact == DIST_DIRECTORY / PACKAGE_NAME / f"{PACKAGE_NAME}.exe"
    assert commands == [
        (
            create_pyinstaller_command(python_executable="python.exe"),
            {"check": True, "cwd": BACKEND_DIRECTORY},
        )
    ]
