import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveDesktopResourcePaths } from './desktop-runtime.mjs';
import {
  PYINSTALLER_BACKEND_DIRECTORY_NAME,
  resolvePackagedBackendDirectory,
  resolveWindowsBackendSourceDirectory,
  stageWindowsBackend,
} from './windows-backend-stage.mjs';

function withTemporaryDirectory(callback) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ai-meeting-note-package-')
  );

  try {
    return callback(temporaryDirectory);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function createPyInstallerBackendArtifact(sourceDirectory) {
  fs.mkdirSync(path.join(sourceDirectory, '_internal'), { recursive: true });
  fs.writeFileSync(
    path.join(sourceDirectory, 'ai-meeting-note-backend.exe'),
    'backend executable'
  );
  fs.writeFileSync(
    path.join(sourceDirectory, '_internal', 'native-library.dll'),
    'native library'
  );
  fs.writeFileSync(path.join(sourceDirectory, 'system_prompt.txt'), 'prompt');
}

test('resolves the checked-in Windows PyInstaller source directory', () => {
  const sourceDirectory = resolveWindowsBackendSourceDirectory({
    repositoryDirectory: 'C:\\workspace\\ai-meeting-note-tool',
    pathApi: path.win32,
  });

  assert.equal(
    sourceDirectory,
    `C:\\workspace\\ai-meeting-note-tool\\backend\\dist\\windows-backend\\${PYINSTALLER_BACKEND_DIRECTORY_NAME}`
  );
});

test('stages the complete PyInstaller directory into resources/backend', () => {
  withTemporaryDirectory((temporaryDirectory) => {
    const sourceDirectory = path.join(temporaryDirectory, 'source');
    const resourcesDirectory = path.join(temporaryDirectory, 'resources');
    createPyInstallerBackendArtifact(sourceDirectory);

    const staged = stageWindowsBackend({
      sourceDirectory,
      resourcesDirectory,
    });
    const desktopResources = resolveDesktopResourcePaths({
      appPath: path.join(temporaryDirectory, 'app.asar'),
      resourcesPath: resourcesDirectory,
    });

    assert.equal(
      staged.destinationDirectory,
      resolvePackagedBackendDirectory({ resourcesDirectory })
    );
    assert.equal(
      staged.destinationExecutablePath,
      desktopResources.backendExecutablePath
    );
    assert.equal(fs.existsSync(staged.destinationExecutablePath), true);
    assert.equal(
      fs.existsSync(
        path.join(
          staged.destinationDirectory,
          '_internal',
          'native-library.dll'
        )
      ),
      true
    );
    assert.equal(
      fs.existsSync(
        path.join(staged.destinationDirectory, 'system_prompt.txt')
      ),
      true
    );
  });
});

test('fails clearly when the PyInstaller backend directory is missing', () => {
  withTemporaryDirectory((temporaryDirectory) => {
    assert.throws(
      () =>
        stageWindowsBackend({
          sourceDirectory: path.join(temporaryDirectory, 'missing-backend'),
          resourcesDirectory: path.join(temporaryDirectory, 'resources'),
        }),
      /Windows backend artifact is missing:.*Run the backend Windows PyInstaller build first/
    );
  });
});

test('fails clearly when the PyInstaller artifact lacks its one-folder runtime', () => {
  withTemporaryDirectory((temporaryDirectory) => {
    const sourceDirectory = path.join(temporaryDirectory, 'source');
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDirectory, 'ai-meeting-note-backend.exe'),
      'backend executable'
    );

    assert.throws(
      () =>
        stageWindowsBackend({
          sourceDirectory,
          resourcesDirectory: path.join(temporaryDirectory, 'resources'),
        }),
      /Windows backend artifact is incomplete:.*_internal is missing/
    );
  });
});
