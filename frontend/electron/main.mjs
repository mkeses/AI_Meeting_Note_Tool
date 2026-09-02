import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const developmentRendererUrl =
  process.env.ELECTRON_RENDERER_URL ?? 'http://127.0.0.1:3000';
const useProductionRenderer =
  app.isPackaged || process.argv.includes('--production');

function getBackendOrigin() {
  const candidate =
    process.env.ELECTRON_BACKEND_ORIGIN ?? 'http://127.0.0.1:8000';
  const origin = new URL(candidate);

  if (
    (origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('ELECTRON_BACKEND_ORIGIN must be a plain HTTP(S) origin.');
  }

  return origin.origin;
}

function createWindow() {
  const backendOrigin = getBackendOrigin();
  const window = new BrowserWindow({
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

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (useProductionRenderer) {
    void window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
    return;
  }

  void window.loadURL(developmentRendererUrl);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
