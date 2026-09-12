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
  terminateWindowsProcessTree,
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

function exitChild(child) {
  child.exitCode = 0;
  child.emit('exit', 0, null);
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
      return attempts < 2 ? response({}, 503) : response({ models: [] });
    },
  });

  assert.deepEqual(result, { state: 'ready' });
  assert.equal(attempts, 2);
});

test('detects the configured model without modifying model storage', async () => {
  const fetchImpl = async () => response({ models: [{ name: 'gemma3:4b' }] });

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
  let treeTerminationCalls = 0;
  const manager = new OllamaLifecycleManager({
    spawnProcess: () => {
      spawned = true;
      return createChild();
    },
    fetchImpl: async () => response({ models: [{ name: 'gemma3:4b' }] }),
    platform: 'win32',
    killProcessTree: async () => {
      treeTerminationCalls += 1;
      return true;
    },
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
  assert.equal(treeTerminationCalls, 0);
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
  const child = createChild();
  const spawnCalls = [];
  const shutdownSteps = [];
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
    platform: 'win32',
    killProcessTree: async (ownedChild) => {
      shutdownSteps.push({
        pid: ownedChild.pid,
        parentExited: ownedChild.exitCode !== null,
      });
      exitChild(ownedChild);
      return true;
    },
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
  assert.equal(spawnCalls[0][2].env.OLLAMA_MODELS, 'C:\\app\\models\\ollama');
  assert.deepEqual(await manager.stop(), { stopped: true, forced: true });
  assert.deepEqual(shutdownSteps, [{ pid: 1234, parentExited: false }]);
  assert.deepEqual(child.signals, []);
});

test('uses a targeted taskkill tree command only for a valid owned PID', async () => {
  const calls = [];
  const taskkill = new EventEmitter();
  const terminate = terminateWindowsProcessTree({
    pid: 4321,
    spawnProcess: (...args) => {
      calls.push(args);
      queueMicrotask(() => taskkill.emit('exit', 0));
      return taskkill;
    },
  });

  assert.equal(await terminate, true);
  assert.deepEqual(calls, [
    [
      'taskkill.exe',
      ['/PID', '4321', '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    ],
  ]);
  assert.equal(await terminateWindowsProcessTree({ pid: 0 }), false);
});

test('handles a stale process-tree PID without throwing', async () => {
  const taskkill = new EventEmitter();
  const terminated = terminateWindowsProcessTree({
    pid: 4321,
    spawnProcess: () => {
      queueMicrotask(() =>
        taskkill.emit('error', new Error('process not found'))
      );
      return taskkill;
    },
  });

  assert.equal(await terminated, false);
});

test('bounds a stalled process-tree termination request', async () => {
  const taskkill = new EventEmitter();
  const terminated = terminateWindowsProcessTree({
    pid: 4321,
    timeoutMs: 0,
    spawnProcess: () => taskkill,
  });

  assert.equal(await terminated, false);
});

test('keeps the app-owned process tree intact until targeted cleanup runs', async () => {
  const ollama = createChild();
  const llamaServer = createChild();
  llamaServer.pid = 4321;
  let treeTerminationCalls = 0;
  let modelChecks = 0;
  const manager = new OllamaLifecycleManager({
    spawnProcess: () => ollama,
    fsApi: { existsSync: () => true },
    selectPort: async () => 45678,
    fetchImpl: async () =>
      response({
        models: modelChecks++ < 2 ? [] : [{ name: 'gemma3:4b' }],
      }),
    platform: 'win32',
    killProcessTree: async (ownedChild) => {
      treeTerminationCalls += 1;
      assert.equal(ownedChild.exitCode, null);
      exitChild(llamaServer);
      exitChild(ownedChild);
      return true;
    },
  });

  await manager.start({
    configuredBaseUrl: 'http://127.0.0.1:11434/v1',
    model: 'gemma3:4b',
    modelDirectory: 'C:\\app\\models\\ollama',
    bundledExecutablePath: 'ollama.exe',
  });

  assert.deepEqual(await manager.stop(), { stopped: true, forced: true });
  assert.equal(treeTerminationCalls, 1);
  assert.equal(ollama.exitCode, 0);
  assert.equal(llamaServer.exitCode, 0);
});

test('cleans up an owned parent after its inference child has already exited', async () => {
  const ollama = createChild();
  const llamaServer = createChild();
  let modelChecks = 0;
  let treeTerminationCalls = 0;
  const manager = new OllamaLifecycleManager({
    spawnProcess: () => ollama,
    fsApi: { existsSync: () => true },
    selectPort: async () => 45678,
    fetchImpl: async () =>
      response({
        models: modelChecks++ < 2 ? [] : [{ name: 'gemma3:4b' }],
      }),
    platform: 'win32',
    killProcessTree: async (ownedChild) => {
      treeTerminationCalls += 1;
      assert.equal(llamaServer.exitCode, 0);
      exitChild(ownedChild);
      return true;
    },
  });

  await manager.start({
    configuredBaseUrl: 'http://127.0.0.1:11434/v1',
    model: 'gemma3:4b',
    modelDirectory: 'C:\\app\\models\\ollama',
    bundledExecutablePath: 'ollama.exe',
  });
  exitChild(llamaServer);

  assert.deepEqual(await manager.stop(), { stopped: true, forced: true });
  assert.equal(treeTerminationCalls, 1);
});

test('handles stale or already-exited app-owned processes without a second tree kill', async () => {
  const child = createChild();
  let treeTerminationCalls = 0;
  let modelChecks = 0;
  const manager = new OllamaLifecycleManager({
    spawnProcess: () => child,
    fsApi: { existsSync: () => true },
    selectPort: async () => 45678,
    fetchImpl: async () =>
      response({
        models: modelChecks++ < 2 ? [] : [{ name: 'gemma3:4b' }],
      }),
    platform: 'win32',
    killProcessTree: async () => {
      treeTerminationCalls += 1;
      return false;
    },
  });

  await manager.start({
    configuredBaseUrl: 'http://127.0.0.1:11434/v1',
    model: 'gemma3:4b',
    modelDirectory: 'C:\\app\\models\\ollama',
    bundledExecutablePath: 'ollama.exe',
  });
  exitChild(child);

  assert.deepEqual(await manager.stop(), { stopped: true, forced: false });
  assert.deepEqual(await manager.stop(), { stopped: true, forced: false });
  assert.equal(treeTerminationCalls, 0);
});

test('cleans up an app-owned process after startup fails partway through', async () => {
  const child = createChild();
  let treeTerminationCalls = 0;
  const manager = new OllamaLifecycleManager({
    spawnProcess: () => child,
    fsApi: { existsSync: () => true },
    selectPort: async () => 45678,
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
    now: () => 1,
    sleep: async () => {},
    platform: 'win32',
    killProcessTree: async (ownedChild) => {
      treeTerminationCalls += 1;
      exitChild(ownedChild);
      return true;
    },
  });

  const status = await manager.start({
    configuredBaseUrl: 'http://127.0.0.1:11434/v1',
    model: 'gemma3:4b',
    modelDirectory: 'C:\\app\\models\\ollama',
    bundledExecutablePath: 'ollama.exe',
    startupTimeoutMs: 0,
  });

  assert.equal(status.state, 'unavailable');
  assert.equal(treeTerminationCalls, 1);
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
