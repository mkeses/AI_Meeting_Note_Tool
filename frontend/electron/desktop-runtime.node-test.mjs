import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_DESKTOP_RUNTIME_CONFIG,
  DESKTOP_APPLICATION_NAME,
  initializeDesktopRuntime,
  loadDesktopRuntimeConfig,
  resolveDesktopDataRoot,
  resolveDesktopRuntimePaths,
} from './desktop-runtime.mjs';

test('uses LOCALAPPDATA for the Windows desktop data root', () => {
  const dataRoot = resolveDesktopDataRoot({
    platform: 'win32',
    localAppData: 'C:\\Users\\Ada\\AppData\\Local',
    userDataPath: 'C:\\Users\\Ada\\AppData\\Roaming\\Ignored',
    pathApi: path.win32,
  });
  const paths = resolveDesktopRuntimePaths({
    dataRoot,
    pathApi: path.win32,
  });

  assert.equal(
    dataRoot,
    `C:\\Users\\Ada\\AppData\\Local\\${DESKTOP_APPLICATION_NAME}`
  );
  assert.equal(
    paths.databasePath,
    `C:\\Users\\Ada\\AppData\\Local\\${DESKTOP_APPLICATION_NAME}\\data\\meetings.db`
  );
  assert.equal(
    paths.modelCacheDirectory,
    `C:\\Users\\Ada\\AppData\\Local\\${DESKTOP_APPLICATION_NAME}\\models\\huggingface`
  );
});

test('uses Electron userData as the non-Windows base', () => {
  const dataRoot = resolveDesktopDataRoot({
    platform: 'linux',
    localAppData: undefined,
    userDataPath: '/home/ada/.config/ai-transcript-app',
    pathApi: path.posix,
  });

  assert.equal(
    dataRoot,
    `/home/ada/.config/ai-transcript-app/${DESKTOP_APPLICATION_NAME}`
  );
});

test('creates desktop-owned directories and a non-secret default config only', () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ai-meeting-note-runtime-')
  );

  try {
    const runtime = initializeDesktopRuntime({
      platform: 'linux',
      localAppData: undefined,
      userDataPath: temporaryDirectory,
    });

    assert.deepEqual(runtime.config, {
      configVersion: DEFAULT_DESKTOP_RUNTIME_CONFIG.configVersion,
      whisperModel: DEFAULT_DESKTOP_RUNTIME_CONFIG.whisperModel,
      llm: {
        baseUrl: DEFAULT_DESKTOP_RUNTIME_CONFIG.llm.baseUrl,
        model: DEFAULT_DESKTOP_RUNTIME_CONFIG.llm.model,
      },
    });
    assert.equal(fs.existsSync(runtime.paths.configurationFilePath), true);
    assert.equal(fs.existsSync(runtime.paths.dataDirectory), true);
    assert.equal(fs.existsSync(runtime.paths.modelCacheDirectory), true);
    assert.equal(fs.existsSync(runtime.paths.logsDirectory), true);
    assert.equal(fs.existsSync(runtime.paths.databasePath), false);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('loads an existing configuration without overwriting it', () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ai-meeting-note-runtime-')
  );

  try {
    const runtime = initializeDesktopRuntime({
      platform: 'linux',
      localAppData: undefined,
      userDataPath: temporaryDirectory,
    });
    const existingConfig = {
      configVersion: 1,
      whisperModel: 'small.en',
      llm: {
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'local-model',
      },
    };

    fs.writeFileSync(
      runtime.paths.configurationFilePath,
      `${JSON.stringify(existingConfig)}\n`,
      'utf8'
    );

    assert.deepEqual(loadDesktopRuntimeConfig(runtime.paths), existingConfig);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
