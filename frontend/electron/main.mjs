import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
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
let backendLifecycle = null;
let ollamaLifecycle = null;
let activeBackendOrigin = null;
let isQuitting = false;

function getRendererOrigin() {
  return useProductionRenderer
    ? DESKTOP_RENDERER_ORIGIN
    : new URL(developmentRendererUrl).origin;
}

function registerRendererProtocol(resources) {
  protocol.handle(DESKTOP_RENDERER_SCHEME, (request) => {
    const assetPath = resolveRendererAssetPath({
      requestUrl: request.url,
      rendererDirectory: path.dirname(resources.rendererIndexPath),
    });

    return net.fetch(pathToFileURL(assetPath).toString());
  });
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

async function startDesktopApplication() {
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
    ollamaLifecycle = createOllamaLifecycle();
    ollamaStatus = await ollamaLifecycle.start({
      configuredBaseUrl: desktopRuntime.config.llm.baseUrl,
      model: desktopRuntime.config.llm.model,
      modelDirectory: desktopRuntime.paths.ollamaModelDirectory,
      bundledExecutablePath: resources.ollamaExecutablePath,
      externalExecutablePaths: resolveKnownOllamaExecutablePaths(),
    });
  }

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
    createWindow(backend.origin, resources);
  } catch (error) {
    await ollamaLifecycle?.stop();
    throw error;
  }
}

app.whenReady().then(async () => {
  if (isHandlingSquirrelEvent) {
    return;
  }

  try {
    configureDesktopMediaCapture({
      session: session.defaultSession,
      desktopCapturer,
      rendererOrigin: getRendererOrigin(),
      platform: process.platform,
    });
    await startDesktopApplication();
  } catch (error) {
    dialog.showErrorBox(
      'Local backend unavailable',
      'The local transcription backend could not start. Check the desktop lifecycle log and restart the app.'
    );
    app.quit();
  }
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
