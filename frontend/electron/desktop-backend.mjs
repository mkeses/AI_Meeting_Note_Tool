import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;
export const DEFAULT_READINESS_INTERVAL_MS = 250;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export function resolveBackendLaunchTarget({
  isPackaged,
  appPath,
  resources,
  developmentBackendCommand = 'uv',
  pathApi = path,
}) {
  if (isPackaged) {
    return {
      backendExecutablePath: resources.backendExecutablePath,
      backendWorkingDirectory: resources.backendDirectory,
    };
  }

  return {
    backendCommand: developmentBackendCommand,
    backendWorkingDirectory: pathApi.resolve(appPath, '..', 'backend'),
  };
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatLifecycleEvent(event, details) {
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  return `${new Date().toISOString()} ${event}${suffix}\n`;
}

function isSafeBackendDiagnostic(line) {
  return /(?:Uvicorn running on|Waiting for application startup|Application startup complete|Application shutdown complete|Starting AI Transcript App|Ready!|Missing required environment variables|Application startup failed)/.test(
    line
  );
}

function createDeferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

export function createLifecycleLogger({ logFilePath, fsApi = fs }) {
  return (event, details) => {
    fsApi.appendFileSync(
      logFilePath,
      formatLifecycleEvent(event, details),
      'utf8'
    );
  };
}

export function findAvailableLoopbackPort({
  host = LOOPBACK_HOST,
  createServer = net.createServer,
} = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;

    const finish = (callback) => {
      if (!settled) {
        settled = true;
        callback();
      }
    };

    server.once('error', (error) => finish(() => reject(error)));
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close(() => {
          finish(() => reject(new Error('Could not determine loopback port.')));
        });
        return;
      }

      server.close((error) => {
        if (error) {
          finish(() => reject(error));
          return;
        }

        finish(() => resolve(address.port));
      });
    });
  });
}

export function buildBackendLaunchSpec({
  desktopRuntime,
  backendWorkingDirectory,
  port,
  rendererOrigin,
  backendCommand = 'uv',
  backendExecutablePath,
  inheritedEnvironment = process.env,
}) {
  const isPackagedBackend = Boolean(backendExecutablePath);

  return {
    command: backendExecutablePath ?? backendCommand,
    args: isPackagedBackend
      ? ['--port', String(port), '--timeout-keep-alive', '600']
      : [
          'run',
          'uvicorn',
          'app:app',
          '--host',
          LOOPBACK_HOST,
          '--port',
          String(port),
          '--timeout-keep-alive',
          '600',
        ],
    options: {
      cwd: backendWorkingDirectory,
      env: {
        ...inheritedEnvironment,
        DATABASE_PATH: desktopRuntime.paths.databasePath,
        HF_HOME: desktopRuntime.paths.modelCacheDirectory,
        WHISPER_MODEL: desktopRuntime.config.whisperModel,
        LLM_BASE_URL: desktopRuntime.config.llm.baseUrl,
        LLM_MODEL: desktopRuntime.config.llm.model,
        ELECTRON_DESKTOP_MODE: '1',
        ELECTRON_RENDERER_ORIGIN: rendererOrigin,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  };
}

export async function waitForBackendReadiness({
  origin,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  intervalMs = DEFAULT_READINESS_INTERVAL_MS,
  hasExited = () => false,
}) {
  const deadline = now() + timeoutMs;
  let lastFailure = 'The backend did not respond.';

  while (now() <= deadline) {
    if (hasExited()) {
      throw new Error('The local backend exited before becoming ready.');
    }

    try {
      const response = await fetchImpl(`${origin}/api/status`);

      if (response.ok) {
        const status = await response.json();

        if (status?.status === 'ready') {
          return status;
        }

        lastFailure = 'The backend is still initializing.';
      } else {
        lastFailure = `The backend returned status ${response.status}.`;
      }
    } catch (error) {
      lastFailure = getErrorMessage(error);
    }

    if (now() >= deadline) {
      break;
    }

    await sleep(intervalMs);
  }

  throw new Error(
    `The local backend did not become ready within ${Math.ceil(
      timeoutMs / 1000
    )} seconds: ${lastFailure}`
  );
}

export async function terminateBackendProcess({
  child,
  waitForExit,
  gracefulTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  log = () => {},
}) {
  if (!child || child.exitCode !== null) {
    return { stopped: true, forced: false };
  }

  log('backend-shutdown-requested');
  child.kill('SIGTERM');

  if (await waitForExit(gracefulTimeoutMs)) {
    log('backend-shutdown-complete', { forced: false });
    return { stopped: true, forced: false };
  }

  log('backend-force-kill-requested');
  child.kill('SIGKILL');
  const stopped = await waitForExit(gracefulTimeoutMs);
  log('backend-shutdown-complete', { forced: true, stopped });

  return { stopped, forced: true };
}

export class BackendLifecycleManager {
  constructor({
    spawnProcess,
    selectPort = findAvailableLoopbackPort,
    fetchImpl = fetch,
    now = Date.now,
    sleep,
    log = () => {},
    onUnexpectedExit = () => {},
  }) {
    this.spawnProcess = spawnProcess;
    this.selectPort = selectPort;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.log = log;
    this.onUnexpectedExit = onUnexpectedExit;
    this.child = null;
    this.ready = false;
    this.stopping = false;
    this.stopPromise = null;
    this.exitDeferred = null;
    this.diagnostics = [];
  }

  async start({
    desktopRuntime,
    backendWorkingDirectory,
    rendererOrigin,
    backendCommand,
    backendExecutablePath,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  }) {
    if (this.child) {
      throw new Error('The local backend is already running.');
    }

    const port = await this.selectPort();
    const origin = `http://${LOOPBACK_HOST}:${port}`;
    const launchSpec = buildBackendLaunchSpec({
      desktopRuntime,
      backendWorkingDirectory,
      port,
      rendererOrigin,
      backendCommand,
      backendExecutablePath,
    });

    this.log('backend-starting', { port });
    const child = this.spawnProcess(
      launchSpec.command,
      launchSpec.args,
      launchSpec.options
    );
    this.child = child;
    this.exitDeferred = createDeferred();
    this.attachProcessListeners(child);

    try {
      await waitForBackendReadiness({
        origin,
        fetchImpl: this.fetchImpl,
        now: this.now,
        sleep: this.sleep,
        timeoutMs: startupTimeoutMs,
        hasExited: () => this.child !== child,
      });

      if (this.child !== child) {
        throw new Error('The local backend exited before becoming ready.');
      }

      this.ready = true;
      this.log('backend-ready', { port });

      return { origin, port };
    } catch (error) {
      this.log('backend-startup-failed', {
        port,
        reason: getErrorMessage(error),
        diagnostics: this.diagnostics,
      });
      await this.stop();
      throw error;
    }
  }

  attachProcessListeners(child) {
    const captureOutput = (output) => {
      output?.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (isSafeBackendDiagnostic(line)) {
            this.diagnostics.push(line.slice(0, 500));
            this.diagnostics = this.diagnostics.slice(-10);
          }
        }
      });
    };

    captureOutput(child.stdout);
    captureOutput(child.stderr);

    child.once('error', (error) => {
      this.handleExit(child, null, getErrorMessage(error));
    });
    child.once('exit', (code, signal) => {
      this.handleExit(child, code, signal);
    });
  }

  handleExit(child, code, signal) {
    if (this.child !== child) {
      return;
    }

    const wasReady = this.ready;
    this.child = null;
    this.ready = false;
    this.exitDeferred?.resolve(true);
    this.log('backend-exited', { code, signal, wasReady });

    if (!this.stopping && wasReady) {
      this.onUnexpectedExit({ code, signal, diagnostics: this.diagnostics });
    }
  }

  async stop() {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    const child = this.child;

    if (!child) {
      return { stopped: true, forced: false };
    }

    this.stopping = true;
    this.stopPromise = terminateBackendProcess({
      child,
      waitForExit: (timeoutMs) => this.waitForExit(timeoutMs),
      log: this.log,
    }).finally(() => {
      this.stopPromise = null;
      this.stopping = false;
      this.child = null;
      this.ready = false;
    });

    return this.stopPromise;
  }

  waitForExit(timeoutMs) {
    if (!this.exitDeferred) {
      return Promise.resolve(true);
    }

    return Promise.race([
      this.exitDeferred.promise,
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }
}
