const { contextBridge } = require('electron');

const backendOriginArgument = process.argv.find((argument) =>
  argument.startsWith('--meeting-backend-origin=')
);
const backendOrigin = backendOriginArgument?.slice(
  '--meeting-backend-origin='.length
);

if (!backendOrigin) {
  throw new Error('Electron runtime backend origin is unavailable.');
}

contextBridge.exposeInMainWorld(
  'meetingDesktop',
  Object.freeze({ backendOrigin })
);
