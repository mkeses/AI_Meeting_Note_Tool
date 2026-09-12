import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  OllamaLifecycleManager,
  getOllamaApiOrigin,
  isOllamaModelAvailable,
  probeOllama,
  pullOllamaModel,
  resolveKnownOllamaExecutablePaths,
  waitForOllamaReadiness,
} from './ollama-lifecycle.mjs';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function createChild({ autoExitOnKill = false } = {}) {
  const child = new EventEmitter();
  child.pid = 1234;
  child.exitCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    if (autoExitOnKill) {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    }
  };
  return child;
}

test('builds the native Ollama API origin from the OpenAI-compatible URL', () => {
  assert.equal(
    getOllamaApiOrigin('http://127.0.0.1:11434/v1'),
    'http://127.0.0.1:11434'
  );
});

test('probes an unavailable Ollama endpoint without throwing', async () => {
  const result = await probeOllama({
    baseUrl: 'http://127.0.0.1:11434/v1',
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
  });

  assert.equal(result.state, 'unavailable');
});

test('waits for Ollama readiness with bounded retries', async () => {
  let attempts = 0;
  let now = 0;
  const result = await waitForOllamaReadiness({
    baseUrl: 'http://127.0.0.1:12345/v1',
    now: () => now,
    sleep: async () => {
      now += 100;
    },
    timeoutMs: 500,
    intervalMs: 100,
    fetchImpl: async () => {
      attempts += 1;
      return attempts < 2
        ? response({}, 503)
        : response({ models: [] });
    },
  });

  assert.deepEqual(result, { state: 'ready' });
  assert.equal(attempts, 2);
});

test('detects the configured model without modifying model storage', async () => {
  const fetchImpl = async () =>
    response({ models: [{ name: 'gemma3:4b' }] });

  assert.equal(
    await isOllamaModelAvailable({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'gemma3:4b',
      fetchImpl,
    }),
    true
  );
});

test('pulls a model through the native streaming API and reports indeterminate progress safely', async () => {
  const updates = [];
  await pullOllamaModel({
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'gemma3:4b',
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), {
        model: 'gemma3:4b',
        stream: true,
      });
      return {
        ok: true,
        body: null,
        text: async () =>
          '{"status":"pulling manifest"}\n{"status":"success"}\n',
      };
    },
    onProgress: (update) => updates.push(update),
  });

  assert.deepEqual(updates, [
    { status: 'pulling manifest', completed: null, total: null },
    { status: 'success', completed: null, total: null },
  ]);
});

test('reuses a user-owned Ollama endpoint and never spawns or stops it', async () => {
  let spawned = false;
  const manager = new OllamaLifecycleManager({
    spawnProcess: () => {
      spawned = true;
      return createChild();
    },
    fetchImpl: async () => response({ models: [{ name: 'gemma3:4b' }] }),
  });

  const status = await manager.start({
    configuredBaseUrl: 'http://127.0.0.1:11434/v1',
    model: 'gemma3:4b',
    modelDirectory: 'C:\\app\\models\\ollama',
    bundledExecutablePath: 'missing-ollama.exe',
  });

  assert.equal(spawned, false);
  assert.equal(status.ownership, 'user');
  assert.equal(status.state, 'ready');
  assert.deepEqual(await manager.stop(), { stopped: true, forced: false });
});

test('reports unavailable when no managed runtime exists', async () => {
  const manager = new OllamaLifecycleManager({
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
  });

  const status = await manager.start({
    configuredBaseUrl: 'http://127.0.0.1:11434/v1',
    model: 'gemma3:4b',
    modelDirectory: 'C:\\app\\models\\ollama',
    bundledExecutablePath: 'missing-ollama.exe',
  });

  assert.equal(status.state, 'unavailable');
  assert.equal(status.ownership, 'none');
});

test('starts, provisions, and owns a bundled Ollama process', async () => {
  const child = createChild({ autoExitOnKill: true });
  const spawnCalls = [];
  let modelAvailable = false;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/pull')) {
      modelAvailable = true;
      return {
        ok: true,
        body: null,
        text: async () => '{"status":"success"}\n',
      };
    }
    return response({
      models: modelAvailable ? [{ name: 'gemma3:4b' }] : [],
    });
  };
  const manager = new OllamaLifecycleManager({
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      return child;
    },
    fsApi: { existsSync: () => true },
    selectPort: async () => 45678,
    fetchImpl,
    now: () => 0,
    sleep: async () => {},
  });

  const status = await manager.start({
    configuredBaseUrl: 'http://127.0.0.1:11434/v1',
    model: 'gemma3:4b',
    modelDirectory: 'C:\\app\\models\\ollama',
    bundledExecutablePath: 'ollama.exe',
    startupTimeoutMs: 100,
  });

  assert.equal(status.ownership, 'application');
  assert.equal(status.state, 'ready');
  assert.equal(spawnCalls[0][0], 'ollama.exe');
  assert.deepEqual(spawnCalls[0][1], ['serve']);
  assert.equal(
    spawnCalls[0][2].env.OLLAMA_MODELS,
    'C:\\app\\models\\ollama'
  );
  assert.deepEqual(await manager.stop(), { stopped: true, forced: false });
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('resolves only existing known Windows installation paths', () => {
  const paths = resolveKnownOllamaExecutablePaths({
    environment: {
      LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
    },
    fsApi: {
      existsSync: (candidate) =>
        candidate.endsWith('Program Files\\Ollama\\ollama.exe'),
      statSync: () => ({ isFile: () => true }),
    },
  });

  assert.deepEqual(paths, ['C:\\Program Files\\Ollama\\ollama.exe']);
});
