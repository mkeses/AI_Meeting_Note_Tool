import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  WINDOWS_APPLICATION_ID,
  WINDOWS_NSIS_DIRECTORY_NAME,
  WINDOWS_PRODUCT_NAME,
  createWindowsNsisConfiguration,
  resolveWindowsNsisArtifactPath,
  resolveWindowsNsisOutputDirectory,
  validateWindowsNsisOutput,
} from './windows-nsis.mjs';

test('creates a stable standalone NSIS configuration', () => {
  const configuration = createWindowsNsisConfiguration({
    frontendDirectory: 'C:\\workspace\\frontend',
    repositoryDirectory: 'C:\\workspace',
    outputDirectory: 'C:\\workspace\\dist\\windows-installer-nsis',
    backendDirectory: 'C:\\workspace\\backend\\dist\\windows-backend\\backend',
    ollamaDirectory: 'C:\\workspace\\dist\\ollama-runtime\\v0.34.0',
  });

  assert.equal(configuration.appId, WINDOWS_APPLICATION_ID);
  assert.equal(configuration.productName, WINDOWS_PRODUCT_NAME);
  assert.equal(configuration.asar, true);
  assert.deepEqual(configuration.win.target, [
    { target: 'nsis', arch: ['x64'] },
  ]);
  assert.equal(configuration.nsis.oneClick, false);
  assert.equal(configuration.nsis.perMachine, false);
  assert.equal(configuration.nsis.createDesktopShortcut, true);
  assert.equal(configuration.nsis.createStartMenuShortcut, true);
  assert.equal(configuration.publish, undefined);
  assert.equal(configuration.extraResources[0].to, 'backend');
  assert.equal(configuration.extraResources[1].to, 'ollama');
});

test('uses a dedicated NSIS output directory and standalone artifact name', () => {
  const outputDirectory = resolveWindowsNsisOutputDirectory({
    repositoryDirectory: 'C:\\workspace',
    pathApi: path.win32,
  });

  assert.equal(
    outputDirectory,
    `C:\\workspace\\dist\\${WINDOWS_NSIS_DIRECTORY_NAME}`
  );
  assert.equal(
    resolveWindowsNsisArtifactPath({
      outputDirectory,
      version: '0.1.0',
      pathApi: path.win32,
    }),
    `C:\\workspace\\dist\\${WINDOWS_NSIS_DIRECTORY_NAME}\\${WINDOWS_PRODUCT_NAME} Setup 0.1.0.exe`
  );
});

test('validates required resources without treating model caches as package resources', () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ai-meeting-note-nsis-')
  );
  const outputDirectory = path.join(temporaryDirectory, 'output');
  const resources = path.join(outputDirectory, 'win-unpacked', 'resources');
  const required = [
    path.join(outputDirectory, 'AI Meeting Note Tool Setup 0.1.0.exe'),
    path.join(resources, 'app.asar'),
    path.join(resources, 'backend', 'ai-meeting-note-backend.exe'),
    path.join(
      resources,
      'backend',
      '_internal',
      'ctranslate2',
      'ctranslate2.dll'
    ),
    path.join(
      resources,
      'backend',
      '_internal',
      'ctranslate2',
      'cudnn64_9.dll'
    ),
    path.join(resources, 'ollama', 'ollama.exe'),
    path.join(
      resources,
      'ollama',
      'lib',
      'ollama',
      'cuda_v12',
      'cublas64_12.dll'
    ),
    path.join(
      resources,
      'ollama',
      'lib',
      'ollama',
      'cuda_v12',
      'cublasLt64_12.dll'
    ),
    path.join(
      resources,
      'ollama',
      'lib',
      'ollama',
      'cuda_v12',
      'cudart64_12.dll'
    ),
    path.join(resources, 'ollama', 'lib', 'ollama', 'CUDNN_LICENSE.txt'),
  ];

  try {
    for (const filePath of required) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'fixture');
    }

    const result = validateWindowsNsisOutput({
      outputDirectory,
      version: '0.1.0',
    });

    assert.equal(result.unpackedResourcesDirectory, resources);
    assert.equal(fs.existsSync(path.join(resources, 'models')), false);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('rejects an output directory containing Squirrel release artifacts', () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ai-meeting-note-nsis-')
  );
  try {
    fs.writeFileSync(path.join(temporaryDirectory, 'RELEASES'), 'fixture');
    assert.throws(
      () =>
        validateWindowsNsisOutput({
          outputDirectory: temporaryDirectory,
          version: '0.1.0',
        }),
      /incomplete|Squirrel/
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
