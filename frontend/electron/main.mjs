import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
} from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  BackendLifecycleManager,
  createLifecycleLogger,
  resolveBackendLaunchTarget,
} from './desktop-backend.mjs';
import {
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_RENDERER_SCHEME,
  resolveRendererAssetPath,
} from './desktop-protocol.mjs';
import {
  DEFAULT_DESKTOP_RUNTIME_CONFIG,
  initializeDesktopRuntime,
  resolveDesktopResourcePaths,
} from './desktop-runtime.mjs';
import {
  OllamaLifecycleManager,
  resolveKnownOllamaExecutablePaths,
} from './ollama-lifecycle.mjs';
import { configureDesktopMediaCapture } from './desktop-media.mjs';
import { SETUP_PHASE, SetupStartupController } from './setup-state.mjs';
import { handleWindowsSquirrelEvent } from './windows-squirrel.mjs';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const isHandlingSquirrelEvent = handleWindowsSquirrelEvent({
  platform: process.platform,
  argv: process.argv,
  execPath: process.execPath,
  spawnProcess: spawn,
  quit: () => app.quit(),
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let desktopRuntime = null;

if (!isHandlingSquirrelEvent) {
  app.setName('AI Meeting Note Tool');
  desktopRuntime = initializeDesktopRuntime({
    platform: process.platform,
    localAppData: process.env.LOCALAPPDATA,
    userDataPath: app.getPath('userData'),
  });

  app.setPath('userData', desktopRuntime.paths.electronUserDataDirectory);
  app.setPath('sessionData', desktopRuntime.paths.electronSessionDataDirectory);
  app.setAppLogsPath(desktopRuntime.paths.logsDirectory);
}

const developmentRendererUrl =
  process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:3000';
const useProductionRenderer =
  app.isPackaged || process.argv.includes('--production');
let mainWindow = null;
let setupWindow = null;
let backendLifecycle = null;
let ollamaLifecycle = null;
let activeBackendOrigin = null;
let isQuitting = false;
let pendingStartupResult = null;
let setupStartupController = null;
let setupLogger = null;
let rendererProtocolRegistered = false;

const SETUP_STATUS_CHANNEL = 'meeting-setup-status';
const SETUP_RETRY_CHANNEL = 'meeting-setup-retry';
const SETUP_CONTINUE_CHANNEL = 'meeting-setup-continue';

function getRendererOrigin() {
  return useProductionRenderer
    ? DESKTOP_RENDERER_ORIGIN
    : new URL(developmentRendererUrl).origin;
}

function registerRendererProtocol(resources) {
  if (rendererProtocolRegistered) {
    return;
  }

  protocol.handle(DESKTOP_RENDERER_SCHEME, (request) => {
    const assetPath = resolveRendererAssetPath({
      requestUrl: request.url,
      rendererDirectory: path.dirname(resources.rendererIndexPath),
    });

    return net.fetch(pathToFileURL(assetPath).toString());
  });
  rendererProtocolRegistered = true;
}

function createWindow(backendOrigin, resources) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    webPreferences: {
      preload: path.join(currentDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--meeting-backend-origin=${backendOrigin}`],
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (useProductionRenderer) {
    void mainWindow.loadURL(`${DESKTOP_RENDERER_ORIGIN}/index.html`);
    return;
  }

  void mainWindow.loadURL(developmentRendererUrl);
}

function publishSetupState(state) {
  if (!setupWindow || setupWindow.isDestroyed()) {
    return;
  }

  setupWindow.webContents.send(SETUP_STATUS_CHANNEL, state);
}

function createSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    return setupWindow;
  }

  setupWindow = new BrowserWindow({
    width: 520,
    height: 360,
    minWidth: 520,
    minHeight: 360,
    maximizable: false,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(currentDirectory, 'setup-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.once('ready-to-show', () => {
    setupWindow?.show();
  });
  setupWindow.webContents.once('did-finish-load', () => {
    if (setupStartupController) {
      publishSetupState(setupStartupController.state);
    }
  });
  setupWindow.on('closed', () => {
    setupWindow = null;
  });
  void setupWindow.loadFile(path.join(currentDirectory, 'setup.html'));
  return setupWindow;
}

function createSetupStartupController() {
  setupLogger = createLifecycleLogger({
    logFilePath: path.join(
      desktopRuntime.paths.logsDirectory,
      'setup-lifecycle.log'
    ),
  });
  setupStartupController = new SetupStartupController({
    onStateChange: publishSetupState,
  });
}

function setupErrorMessage(phase) {
  if (phase === SETUP_PHASE.PROVISIONING_LLM_MODEL) {
    return 'The AI model could not be downloaded. Check your internet connection and retry.';
  }
  if (phase === SETUP_PHASE.STARTING_OLLAMA) {
    return 'The local AI engine could not be started. Retry setup or continue without AI cleanup.';
  }
  if (phase === SETUP_PHASE.PREPARING_TRANSCRIPTION_MODEL) {
    return 'The transcription model could not be prepared. Check your internet connection and retry.';
  }
  return 'The local transcription service could not be started. Retry setup.';
}

async function stopManagedLocalServices() {
  activeBackendOrigin = null;
  pendingStartupResult = null;
  try {
    await backendLifecycle?.stop();
  } catch (error) {
    setupLogger?.('backend-stop-during-setup-retry-failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  backendLifecycle = null;

  try {
    await ollamaLifecycle?.stop();
  } catch (error) {
    setupLogger?.('ollama-stop-during-setup-retry-failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  ollamaLifecycle = null;
}

function createBackendLifecycle() {
  const log = createLifecycleLogger({
    logFilePath: path.join(
      desktopRuntime.paths.logsDirectory,
      'backend-lifecycle.log'
    ),
  });

  return new BackendLifecycleManager({
    spawnProcess: spawn,
    log,
    onUnexpectedExit: ({ code, signal, diagnostics }) => {
      log('backend-unexpected-exit-diagnostics', {
        code,
        signal,
        diagnostics,
      });

      if (!isQuitting) {
        dialog.showErrorBox(
          'Local backend stopped',
          'The local transcription backend stopped unexpectedly. Restart the app before continuing.'
        );
      }
    },
  });
}

function createOllamaLifecycle() {
  const log = createLifecycleLogger({
    logFilePath: path.join(
      desktopRuntime.paths.logsDirectory,
      'ollama-lifecycle.log'
    ),
  });

  return new OllamaLifecycleManager({ spawnProcess: spawn, log });
}

async function startDesktopApplication({ onSetupStatus = () => {} } = {}) {
  const resources = resolveDesktopResourcePaths({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
  const backendLaunchTarget = resolveBackendLaunchTarget({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resources,
    developmentBackendCommand: process.env.ELECTRON_BACKEND_COMMAND ?? 'uv',
  });
  const availabilityPath =
    backendLaunchTarget.backendExecutablePath ??
    backendLaunchTarget.backendWorkingDirectory;

  if (!fs.existsSync(availabilityPath)) {
    throw new Error(
      app.isPackaged
        ? 'The packaged backend executable is unavailable.'
        : 'The development Python backend directory is unavailable.'
    );
  }

  if (useProductionRenderer) {
    registerRendererProtocol(resources);
  }

  const usesBuiltInOllama =
    desktopRuntime.config.llm.baseUrl ===
    DEFAULT_DESKTOP_RUNTIME_CONFIG.llm.baseUrl;
  let ollamaStatus = null;

  if (usesBuiltInOllama) {
    onSetupStatus({ phase: SETUP_PHASE.STARTING_OLLAMA });
    ollamaLifecycle = createOllamaLifecycle();
    ollamaStatus = await ollamaLifecycle.start({
      configuredBaseUrl: desktopRuntime.config.llm.baseUrl,
      model: desktopRuntime.config.llm.model,
      modelDirectory: desktopRuntime.paths.ollamaModelDirectory,
      bundledExecutablePath: resources.ollamaExecutablePath,
      externalExecutablePaths: resolveKnownOllamaExecutablePaths(),
      onSetupStatus,
    });
  }

  onSetupStatus({ phase: SETUP_PHASE.STARTING_BACKEND });
  onSetupStatus({ phase: SETUP_PHASE.PREPARING_TRANSCRIPTION_MODEL });
  backendLifecycle = createBackendLifecycle();
  try {
    const backend = await backendLifecycle.start({
      desktopRuntime,
      ...backendLaunchTarget,
      llmBaseUrl: ollamaStatus?.baseUrl ?? desktopRuntime.config.llm.baseUrl,
      cudaRuntimeDirectory: resources.whisperCudaRuntimeDirectory,
      rendererOrigin: getRendererOrigin(),
    });

    activeBackendOrigin = backend.origin;
    return { backend, resources, ollamaStatus };
  } catch (error) {
    await ollamaLifecycle?.stop();
    throw error;
  }
}

function openWorkspace(startupResult) {
  pendingStartupResult = null;
  setupStartupController.update({ phase: SETUP_PHASE.READY });
  createWindow(startupResult.backend.origin, startupResult.resources);
  setupWindow?.close();
}

async function startDesktopWithSetup() {
  return setupStartupController.start(async (onSetupStatus) => {
    await stopManagedLocalServices();
    try {
      const startupResult = await startDesktopApplication({ onSetupStatus });

      if (startupResult.ollamaStatus?.state === 'unavailable') {
        pendingStartupResult = startupResult;
        onSetupStatus({
          phase: SETUP_PHASE.ERROR,
          message:
            'The local AI model is unavailable. You can retry setup or continue with transcription only.',
          canContinue: true,
        });
        return { status: 'degraded' };
      }

      openWorkspace(startupResult);
      return { status: 'ready' };
    } catch (error) {
      const phase = setupStartupController.state.phase;
      setupLogger?.('setup-startup-failed', {
        phase,
        reason: error instanceof Error ? error.message : String(error),
      });
      await stopManagedLocalServices();
      onSetupStatus({
        phase: SETUP_PHASE.ERROR,
        message: setupErrorMessage(phase),
      });
      return { status: 'error' };
    }
  });
}

function isSetupWindowSender(event) {
  return event.sender === setupWindow?.webContents;
}

function registerSetupIpc() {
  ipcMain.handle(SETUP_RETRY_CHANNEL, (event) => {
    if (!isSetupWindowSender(event) || setupStartupController.startPromise) {
      return { accepted: false };
    }

    void startDesktopWithSetup();
    return { accepted: true };
  });
  ipcMain.handle(SETUP_CONTINUE_CHANNEL, (event) => {
    if (!isSetupWindowSender(event) || !pendingStartupResult) {
      return { accepted: false };
    }

    openWorkspace(pendingStartupResult);
    return { accepted: true };
  });
}

app.whenReady().then(async () => {
  if (isHandlingSquirrelEvent) {
    return;
  }

  createSetupStartupController();
  createSetupWindow();
  registerSetupIpc();
  configureDesktopMediaCapture({
    session: session.defaultSession,
    desktopCapturer,
    rendererOrigin: getRendererOrigin(),
    platform: process.platform,
  });
  await startDesktopWithSetup();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (
    BrowserWindow.getAllWindows().length === 0 &&
    backendLifecycle?.ready &&
    activeBackendOrigin
  ) {
    const resources = resolveDesktopResourcePaths({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    });
    createWindow(activeBackendOrigin, resources);
  }
});

app.on('before-quit', (event) => {
  if (isQuitting || !backendLifecycle) {
    return;
  }

  event.preventDefault();
  isQuitting = true;
  void backendLifecycle
    .stop()
    .finally(() => ollamaLifecycle?.stop())
    .finally(() => app.exit());
});
