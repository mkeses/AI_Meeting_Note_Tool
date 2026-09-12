const STATUS_CHANNEL = 'meeting-setup-status';
const RETRY_CHANNEL = 'meeting-setup-retry';
const CONTINUE_CHANNEL = 'meeting-setup-continue';

function createSetupBridge(ipcRenderer) {
  return Object.freeze({
    subscribe(callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('Setup status callback must be a function.');
      }

      const listener = (_event, status) => callback(status);
      ipcRenderer.on(STATUS_CHANNEL, listener);
      return () => ipcRenderer.removeListener(STATUS_CHANNEL, listener);
    },
    retry: () => ipcRenderer.invoke(RETRY_CHANNEL),
    continueWithoutCleanup: () => ipcRenderer.invoke(CONTINUE_CHANNEL),
  });
}

module.exports = { createSetupBridge };
