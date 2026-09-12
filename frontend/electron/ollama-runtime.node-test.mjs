import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  OLLAMA_ARCHIVE_NAME,
  OLLAMA_ARCHIVE_SHA256,
  OLLAMA_ARCHIVE_URL,
  OLLAMA_VERSION,
  resolveBundledOllamaPaths,
  resolveOllamaDownloadDirectory,
  stageOllamaRuntime,
  validateOllamaRuntime,
} from './ollama-runtime.mjs';

function withTemporaryDirectory(callback) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ai-meeting-note-ollama-test-')
  );

  try {
    return callback(temporaryDirectory);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test('pins the official Windows standalone Ollama archive', () => {
  assert.equal(OLLAMA_VERSION, '0.34.0');
  assert.equal(OLLAMA_ARCHIVE_NAME, 'ollama-windows-amd64.zip');
  assert.match(OLLAMA_ARCHIVE_URL, /releases\/download\/v0\.34\.0/);
  assert.match(OLLAMA_ARCHIVE_SHA256, /^[a-f0-9]{64}$/);
});

test('resolves the packaged Ollama resource and cache locations', () => {
  assert.deepEqual(
    resolveBundledOllamaPaths({
      resourcesDirectory: 'C:\\Program Files\\AI Meeting Note Tool\\resources',
      pathApi: path.win32,
    }),
    {
      runtimeDirectory:
        'C:\\Program Files\\AI Meeting Note Tool\\resources\\ollama',
      executablePath:
        'C:\\Program Files\\AI Meeting Note Tool\\resources\\ollama\\ollama.exe',
    }
  );
  assert.equal(
    resolveOllamaDownloadDirectory({
      repositoryDirectory: 'C:\\workspace\\meeting-tool',
      pathApi: path.win32,
    }),
    'C:\\workspace\\meeting-tool\\dist\\ollama-runtime\\v0.34.0'
  );
});

test('validates and stages the complete Ollama runtime directory', () => {
  withTemporaryDirectory((temporaryDirectory) => {
    const sourceDirectory = path.join(temporaryDirectory, 'source');
    const resourcesDirectory = path.join(temporaryDirectory, 'resources');
    fs.mkdirSync(path.join(sourceDirectory, 'lib', 'ollama'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(sourceDirectory, 'ollama.exe'), 'ollama');
    fs.writeFileSync(
      path.join(sourceDirectory, 'lib', 'ollama', 'runtime.dll'),
      'runtime'
    );

    assert.equal(
      validateOllamaRuntime({ sourceDirectory }).executablePath,
      path.join(sourceDirectory, 'ollama.exe')
    );
    const staged = stageOllamaRuntime({ sourceDirectory, resourcesDirectory });

    assert.equal(fs.existsSync(staged.destinationExecutablePath), true);
    assert.equal(
      fs.existsSync(
        path.join(staged.destinationDirectory, 'lib', 'ollama', 'runtime.dll')
      ),
      true
    );
  });
});

test('rejects an incomplete Ollama runtime', () => {
  withTemporaryDirectory((temporaryDirectory) => {
    assert.throws(
      () => validateOllamaRuntime({ sourceDirectory: temporaryDirectory }),
      /ollama\.exe is missing/
    );
  });
});
