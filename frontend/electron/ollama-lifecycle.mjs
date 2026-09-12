import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const OLLAMA_DEFAULT_PORT = 11434;
export const OLLAMA_STARTUP_TIMEOUT_MS = 60_000;
export const OLLAMA_READINESS_INTERVAL_MS = 500;
export const OLLAMA_PULL_TIMEOUT_MS = 30 * 60 * 1000;
export const OLLAMA_SHUTDOWN_TIMEOUT_MS = 5_000;

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function reportSetupStatus(callback, status) {
  try {
    callback?.(status);
  } catch {
    // Setup presentation must not affect local runtime startup.
  }
}

function createDeferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

export function getOllamaApiOrigin(baseUrl) {
  const parsed = new URL(baseUrl);
  parsed.pathname = parsed.pathname.replace(/\/v1\/?$/, '') || '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function buildOllamaApiUrl(baseUrl, resource) {
  return `${getOllamaApiOrigin(baseUrl)}${resource}`;
}

async function fetchWithTimeout(
  fetchImpl,
  url,
  options,
  timeoutMs,
  AbortControllerImpl = AbortController
) {
  const controller = new AbortControllerImpl();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStreamingWithTimeout(
  fetchImpl,
  url,
  options,
  timeoutMs,
  onResponse,
  AbortControllerImpl = AbortController
) {
  const controller = new AbortControllerImpl();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
    return await onResponse(response);
  } finally {
    clearTimeout(timer);
  }
}

async function listModels({
  baseUrl,
  fetchImpl,
  timeoutMs = OLLAMA_STARTUP_TIMEOUT_MS,
}) {
  const response = await fetchWithTimeout(
    fetchImpl,
    buildOllamaApiUrl(baseUrl, '/api/tags'),
    {},
    timeoutMs
  );

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}.`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.models) ? payload.models : [];
}

function modelName(model) {
  return String(model?.name ?? model?.model ?? model?.id ?? '');
}

export async function probeOllama({
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = 3_000,
} = {}) {
  try {
    await listModels({ baseUrl, fetchImpl, timeoutMs });
    return { state: 'ready' };
  } catch (error) {
    return { state: 'unavailable', error: getErrorMessage(error) };
  }
}

export async function isOllamaModelAvailable({
  baseUrl,
  model,
  fetchImpl = fetch,
  timeoutMs = 3_000,
} = {}) {
  const models = await listModels({ baseUrl, fetchImpl, timeoutMs });
  return models.some((candidate) => modelName(candidate) === model);
}

export async function waitForOllamaReadiness({
  baseUrl,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = OLLAMA_STARTUP_TIMEOUT_MS,
  intervalMs = OLLAMA_READINESS_INTERVAL_MS,
  hasExited = () => false,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastError = 'Ollama did not respond.';

  while (now() <= deadline) {
    if (hasExited()) {
      throw new Error('Ollama exited before becoming ready.');
    }

    const result = await probeOllama({
      baseUrl,
      fetchImpl,
      timeoutMs: intervalMs,
    });

    if (result.state === 'ready') {
      return result;
    }

    lastError = result.error;
    if (now() >= deadline) {
      break;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Ollama did not become ready within ${Math.ceil(
      timeoutMs / 1000
    )} seconds: ${lastError}`
  );
}

async function readPullStream(response, onProgress) {
  if (!response.body?.getReader) {
    const payload = await response.text();
    for (const line of payload.split(/\r?\n/).filter(Boolean)) {
      onProgress(JSON.parse(line));
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      onProgress(JSON.parse(line));
    }
    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    onProgress(JSON.parse(buffer));
  }
}

export async function pullOllamaModel({
  baseUrl,
  model,
  fetchImpl = fetch,
  onProgress = () => {},
  timeoutMs = OLLAMA_PULL_TIMEOUT_MS,
  AbortControllerImpl = AbortController,
} = {}) {
  return fetchStreamingWithTimeout(
    fetchImpl,
    buildOllamaApiUrl(baseUrl, '/api/pull'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    },
    timeoutMs,
    async (response) => {
      if (!response.ok) {
        throw new Error(
          `Ollama model provisioning returned HTTP ${response.status}.`
        );
      }

      await readPullStream(response, (update) => {
        if (update.error) {
          throw new Error('Ollama model provisioning failed.');
        }

        onProgress({
          status: String(update.status ?? ''),
          completed: Number.isFinite(update.completed)
            ? update.completed
            : null,
          total: Number.isFinite(update.total) ? update.total : null,
        });
      });
    },
    AbortControllerImpl
  );
}

export function resolveKnownOllamaExecutablePaths({
  environment = process.env,
  pathApi = path,
  fsApi = fs,
} = {}) {
  const candidates = [
    environment.OLLAMA_EXECUTABLE,
    environment.LOCALAPPDATA &&
      pathApi.join(
        environment.LOCALAPPDATA,
        'Programs',
        'Ollama',
        'ollama.exe'
      ),
    environment.ProgramFiles &&
      pathApi.join(environment.ProgramFiles, 'Ollama', 'ollama.exe'),
    environment['ProgramFiles(x86)'] &&
      pathApi.join(environment['ProgramFiles(x86)'], 'Ollama', 'ollama.exe'),
  ].filter(Boolean);

  return [...new Set(candidates)].filter((candidate) => {
    try {
      return fsApi.existsSync(candidate) && fsApi.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function findAvailableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() =>
          reject(new Error('Could not determine Ollama port.'))
        );
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

export function terminateWindowsProcessTree({
  pid,
  spawnProcess = spawn,
  timeoutMs = OLLAMA_SHUTDOWN_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let taskkill;
    try {
      taskkill = spawnProcess(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        {
          windowsHide: true,
          stdio: 'ignore',
        }
      );
    } catch {
      resolve(false);
      return;
    }

    if (!taskkill || typeof taskkill.once !== 'function') {
      resolve(false);
      return;
    }

    let settled = false;
    let timer;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    taskkill.once('error', () => finish(false));
    taskkill.once('exit', (code) => finish(code === 0));
  });
}

async function terminateOwnedProcess({
  child,
  waitForExit,
  killProcessTree,
  gracefulTimeoutMs,
  platform,
  log,
}) {
  if (!child || child.exitCode !== null) {
    return { stopped: true, forced: false };
  }

  log('ollama-shutdown-requested');
  if (platform === 'win32') {
    log('ollama-process-tree-shutdown-requested', { pid: child.pid });
    const treeTerminated = await killProcessTree(child);
    const stopped = await waitForExit(gracefulTimeoutMs);
    log('ollama-shutdown-complete', { forced: true, stopped, treeTerminated });
    return { stopped, forced: true };
  }

  child.kill('SIGTERM');
  if (await waitForExit(gracefulTimeoutMs)) {
    log('ollama-shutdown-complete', { forced: false });
    return { stopped: true, forced: false };
  }

  log('ollama-force-kill-requested');
  await killProcessTree(child);
  const stopped = await waitForExit(gracefulTimeoutMs);
  log('ollama-shutdown-complete', { forced: true, stopped });
  return { stopped, forced: true };
}

export class OllamaLifecycleManager {
  constructor({
    spawnProcess = spawn,
    selectPort = findAvailableLoopbackPort,
    fetchImpl = fetch,
    fsApi = fs,
    now = Date.now,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    platform = process.platform,
    killProcessTree = async (child) => {
      if (platform === 'win32') {
        return terminateWindowsProcessTree({ pid: child.pid });
      }
      child.kill('SIGKILL');
      return true;
    },
    log = () => {},
  } = {}) {
    this.spawnProcess = spawnProcess;
    this.selectPort = selectPort;
    this.fetchImpl = fetchImpl;
    this.fsApi = fsApi;
    this.now = now;
    this.sleep = sleep;
    this.platform = platform;
    this.killProcessTree = killProcessTree;
    this.log = log;
    this.child = null;
    this.exitDeferred = null;
    this.stopping = false;
    this.stopPromise = null;
    this.owned = false;
    this.state = 'unavailable';
    this.ownership = 'none';
    this.baseUrl = null;
    this.error = null;
  }

  async start({
    configuredBaseUrl,
    model,
    modelDirectory,
    bundledExecutablePath,
    externalExecutablePaths = [],
    startupTimeoutMs = OLLAMA_STARTUP_TIMEOUT_MS,
    onSetupStatus,
  }) {
    if (this.child) {
      throw new Error('Ollama is already managed by this application.');
    }

    const existingBaseUrl = `${getOllamaApiOrigin(configuredBaseUrl)}/v1`;
    try {
      const existing = await probeOllama({
        baseUrl: existingBaseUrl,
        fetchImpl: this.fetchImpl,
      });
      if (existing.state === 'ready') {
        if (
          await isOllamaModelAvailable({
            baseUrl: existingBaseUrl,
            model,
            fetchImpl: this.fetchImpl,
          })
        ) {
          this.state = 'ready';
          this.ownership = 'user';
          this.baseUrl = existingBaseUrl;
          this.error = null;
          this.log('ollama-reused-user-owned', { model });
          reportSetupStatus(onSetupStatus, {
            phase: 'starting_ollama',
            message: 'Local AI engine ready.',
          });
          return this.getStatus(model);
        }
        this.log('ollama-user-owned-model-missing', { model });
      }
    } catch (error) {
      this.log('ollama-existing-endpoint-check-failed', {
        reason: getErrorMessage(error),
      });
    }

    const executablePath = [bundledExecutablePath, ...externalExecutablePaths]
      .filter(Boolean)
      .find((candidate) => this.fsApi.existsSync(candidate));

    if (!executablePath) {
      this.state = 'unavailable';
      this.ownership = 'none';
      this.error = 'No Ollama runtime is available.';
      this.log('ollama-runtime-unavailable');
      return this.getStatus(model);
    }

    let port;
    try {
      port = await this.selectPort();
    } catch (error) {
      this.state = 'unavailable';
      this.ownership = 'none';
      this.error = 'Ollama could not reserve a local port.';
      this.log('ollama-port-selection-failed', {
        reason: getErrorMessage(error),
      });
      return this.getStatus(model);
    }
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    let child;
    try {
      child = this.spawnProcess(executablePath, ['serve'], {
        cwd: path.dirname(executablePath),
        env: {
          ...process.env,
          OLLAMA_HOST: `127.0.0.1:${port}`,
          OLLAMA_MODELS: modelDirectory,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.state = 'unavailable';
      this.ownership = 'none';
      this.error = 'Ollama could not be started.';
      this.log('ollama-start-failed', { reason: getErrorMessage(error) });
      return this.getStatus(model);
    }

    this.child = child;
    this.owned = true;
    this.ownership = 'application';
    this.baseUrl = baseUrl;
    this.state = 'starting';
    this.error = null;
    this.exitDeferred = createDeferred();
    child.once('error', (error) =>
      this.handleExit(child, getErrorMessage(error))
    );
    child.once('exit', (code, signal) =>
      this.handleExit(child, `exit ${code ?? 'unknown'} ${signal ?? ''}`)
    );
    this.log('ollama-starting', { executablePath, port });
    reportSetupStatus(onSetupStatus, {
      phase: 'starting_ollama',
      message: 'Starting local AI engine...',
    });

    try {
      await waitForOllamaReadiness({
        baseUrl,
        fetchImpl: this.fetchImpl,
        now: this.now,
        sleep: this.sleep,
        timeoutMs: startupTimeoutMs,
        hasExited: () => this.child !== child,
      });
      this.state = 'ready';
      this.log('ollama-ready', { port });
      reportSetupStatus(onSetupStatus, {
        phase: 'starting_ollama',
        message: 'Local AI engine ready.',
      });

      if (
        !(await isOllamaModelAvailable({
          baseUrl,
          model,
          fetchImpl: this.fetchImpl,
        }))
      ) {
        this.state = 'provisioning';
        this.log('ollama-model-provisioning-started', { model });
        reportSetupStatus(onSetupStatus, {
          phase: 'provisioning_llm_model',
          message: 'Downloading AI model...',
        });
        await pullOllamaModel({
          baseUrl,
          model,
          fetchImpl: this.fetchImpl,
          onProgress: (progress) => {
            this.log('ollama-model-progress', progress);
            const percent =
              typeof progress.completed === 'number' &&
              typeof progress.total === 'number' &&
              progress.total > 0
                ? progress.completed / progress.total
                : undefined;
            reportSetupStatus(onSetupStatus, {
              phase: 'provisioning_llm_model',
              message: 'Downloading AI model...',
              progress: percent,
            });
          },
        });
      }

      if (
        !(await isOllamaModelAvailable({
          baseUrl,
          model,
          fetchImpl: this.fetchImpl,
        }))
      ) {
        throw new Error('Ollama model provisioning did not complete.');
      }

      this.state = 'ready';
      this.log('ollama-model-ready', { model });
    } catch (error) {
      this.state = 'unavailable';
      this.error = getErrorMessage(error);
      this.log('ollama-startup-failed', { reason: this.error });
      await this.stop();
    }

    return this.getStatus(model);
  }

  getStatus(model) {
    return {
      state: this.state,
      ownership: this.ownership,
      baseUrl: this.baseUrl,
      model,
      error: this.error,
    };
  }

  handleExit(child, reason) {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.exitDeferred?.resolve(true);
    if (!this.stopping) {
      this.state = 'unavailable';
      this.error = 'Ollama stopped unexpectedly.';
      this.log('ollama-unexpected-exit', { reason });
    }
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

  async stop() {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    if (!this.child || !this.owned) {
      return { stopped: true, forced: false };
    }

    this.stopping = true;
    this.stopPromise = terminateOwnedProcess({
      child: this.child,
      waitForExit: (timeoutMs) => this.waitForExit(timeoutMs),
      killProcessTree: this.killProcessTree,
      gracefulTimeoutMs: OLLAMA_SHUTDOWN_TIMEOUT_MS,
      platform: this.platform,
      log: this.log,
    }).finally(() => {
      this.stopPromise = null;
      this.stopping = false;
      this.child = null;
      this.owned = false;
      this.ownership = 'none';
      this.state = 'unavailable';
      this.baseUrl = null;
    });
    return this.stopPromise;
  }
}
