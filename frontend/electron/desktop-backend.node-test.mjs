import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  BackendLifecycleManager,
  buildBackendLaunchSpec,
  findAvailableLoopbackPort,
  terminateBackendProcess,
  waitForBackendReadiness,
} from './desktop-backend.mjs';

function createDesktopRuntime() {
  return {
    paths: {
      databasePath: '/runtime/data/meetings.db',
      modelCacheDirectory: '/runtime/models/huggingface',
    },
    config: {
      whisperModel: 'base.en',
      llm: {
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'gemma3:4b',
      },
    },
  };
}

function createChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

test('selects a port from a 127.0.0.1-only listener', async () => {
  const server = new EventEmitter();
  server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 45678 });
  server.listen = (options, callback) => {
    assert.deepEqual(options, {
      host: '127.0.0.1',
      port: 0,
      exclusive: true,
    });
    callback();
  };
  server.close = (callback) => callback();

  assert.equal(
    await findAvailableLoopbackPort({ createServer: () => server }),
    45678
  );
});

test('builds a loopback launch command from desktop runtime configuration', () => {
  const spec = buildBackendLaunchSpec({
    desktopRuntime: createDesktopRuntime(),
    backendWorkingDirectory: '/workspace/backend',
    port: 45678,
    rendererOrigin: 'meeting://renderer',
    inheritedEnvironment: { LLM_API_KEY: 'existing-secret' },
  });

  assert.deepEqual(spec.args, [
    'run',
    'uvicorn',
    'app:app',
    '--host',
    '127.0.0.1',
    '--port',
    '45678',
    '--timeout-keep-alive',
    '600',
  ]);
  assert.equal(spec.options.cwd, '/workspace/backend');
  assert.equal(spec.options.env.DATABASE_PATH, '/runtime/data/meetings.db');
  assert.equal(spec.options.env.HF_HOME, '/runtime/models/huggingface');
  assert.equal(spec.options.env.WHISPER_MODEL, 'base.en');
  assert.equal(spec.options.env.LLM_BASE_URL, 'http://127.0.0.1:11434/v1');
  assert.equal(spec.options.env.LLM_MODEL, 'gemma3:4b');
  assert.equal(spec.options.env.ELECTRON_DESKTOP_MODE, '1');
  assert.equal(spec.options.env.LLM_API_KEY, 'existing-secret');
});

test('retries readiness until the backend reports ready', async () => {
  let now = 0;
  let attempts = 0;

  const status = await waitForBackendReadiness({
    origin: 'http://127.0.0.1:45678',
    now: () => now,
    sleep: async () => {
      now += 100;
    },
    intervalMs: 100,
    timeoutMs: 500,
    fetchImpl: async () => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error('Connection refused');
      }

      return {
        ok: true,
        json: async () => ({ status: 'ready' }),
      };
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(status, { status: 'ready' });
});

test('reports readiness timeout without waiting for real time', async () => {
  let now = 0;

  await assert.rejects(
    waitForBackendReadiness({
      origin: 'http://127.0.0.1:45678',
      now: () => now,
      sleep: async () => {
        now += 100;
      },
      timeoutMs: 200,
      intervalMs: 100,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /did not become ready within 1 seconds/
  );
});

test('clears its state when the backend exits before readiness', async () => {
  const child = createChild();
  const lifecycleEvents = [];
  const manager = new BackendLifecycleManager({
    spawnProcess: () => child,
    selectPort: async () => 45678,
    fetchImpl: async () => ({ ok: false, status: 503 }),
    now: () => 0,
    sleep: async () => {
      child.emit('exit', 1, null);
    },
    log: (event) => lifecycleEvents.push(event),
  });

  await assert.rejects(
    manager.start({
      desktopRuntime: createDesktopRuntime(),
      backendWorkingDirectory: '/workspace/backend',
      rendererOrigin: 'meeting://renderer',
      startupTimeoutMs: 100,
    }),
    /exited before becoming ready/
  );

  assert.equal(manager.ready, false);
  assert.equal(manager.child, null);
  assert.ok(lifecycleEvents.includes('backend-startup-failed'));
});

test('stops gracefully before force-killing only when needed', async () => {
  const child = createChild();
  const waits = [false, true];

  const result = await terminateBackendProcess({
    child,
    waitForExit: async () => waits.shift(),
  });

  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(result, { stopped: true, forced: true });
});

test('reports an unexpected exit after readiness', async () => {
  const child = createChild();
  const unexpectedExits = [];
  const manager = new BackendLifecycleManager({
    spawnProcess: () => child,
    selectPort: async () => 45678,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ status: 'ready' }),
    }),
    onUnexpectedExit: (exit) => unexpectedExits.push(exit),
  });

  const started = await manager.start({
    desktopRuntime: createDesktopRuntime(),
    backendWorkingDirectory: '/workspace/backend',
    rendererOrigin: 'meeting://renderer',
  });

  child.stdout.emit(
    'data',
    'INFO:     Uvicorn running on http://127.0.0.1:45678\n'
  );
  child.emit('exit', 1, null);

  assert.deepEqual(started, {
    origin: 'http://127.0.0.1:45678',
    port: 45678,
  });
  assert.deepEqual(unexpectedExits, [
    {
      code: 1,
      signal: null,
      diagnostics: ['INFO:     Uvicorn running on http://127.0.0.1:45678'],
    },
  ]);
});
