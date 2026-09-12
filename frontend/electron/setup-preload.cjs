const { contextBridge, ipcRenderer } = require('electron');
const { createSetupBridge } = require('./setup-preload-api.cjs');

contextBridge.exposeInMainWorld('meetingSetup', createSetupBridge(ipcRenderer));
