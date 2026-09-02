import { app, BrowserWindow, dialog, net, protocol } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  BackendLifecycleManager,
  createLifecycleLogger,
} from './desktop-backend.mjs';
import {
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_RENDERER_SCHEME,
  resolveRendererAssetPath,
} from './desktop-protocol.mjs';
import {
  initializeDesktopRuntime,
  resolveDesktopResourcePaths,
} from './desktop-runtime.mjs';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
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

app.setName('AI Meeting Note Tool');

const desktopRuntime = initializeDesktopRuntime({
  platform: process.platform,
  localAppData: process.env.LOCALAPPDATA,
  userDataPath: app.getPath('userData'),
});

app.setPath('userData', desktopRuntime.paths.electronUserDataDirectory);
app.setPath('sessionData', desktopRuntime.paths.electronSessionDataDirectory);
app.setAppLogsPath(desktopRuntime.paths.logsDirectory);

const developmentRendererUrl =
  process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:3000';
const useProductionRenderer =
  app.isPackaged || process.argv.includes('--production');
let mainWindow = null;
let backendLifecycle = null;
let activeBackendOrigin = null;
let isQuitting = false;

function getRendererOrigin() {
  return useProductionRenderer
    ? DESKTOP_RENDERER_ORIGIN
    : new URL(developmentRendererUrl).origin;
}

function getDevelopmentBackendDirectory() {
  if (app.isPackaged) {
    throw new Error('The packaged Python backend is not available yet.');
  }

  return path.resolve(app.getAppPath(), '..', 'backend');
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

async function startDesktopApplication() {
  const resources = resolveDesktopResourcePaths({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
  const backendWorkingDirectory = getDevelopmentBackendDirectory();

  if (!fs.existsSync(backendWorkingDirectory)) {
    throw new Error('The development Python backend directory is unavailable.');
  }

  if (useProductionRenderer) {
    registerRendererProtocol(resources);
  }

  backendLifecycle = createBackendLifecycle();
  const backend = await backendLifecycle.start({
    desktopRuntime,
    backendWorkingDirectory,
    rendererOrigin: getRendererOrigin(),
    backendCommand: process.env.ELECTRON_BACKEND_COMMAND ?? 'uv',
  });

  activeBackendOrigin = backend.origin;
  createWindow(backend.origin, resources);
}

app.whenReady().then(async () => {
  try {
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
  void backendLifecycle.stop().finally(() => app.exit());
});
