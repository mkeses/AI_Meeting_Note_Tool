import path from 'node:path';

const INSTALL_OR_UPDATE_EVENTS = new Set([
  '--squirrel-install',
  '--squirrel-updated',
]);
const SQUIRREL_EVENTS = new Set([
  ...INSTALL_OR_UPDATE_EVENTS,
  '--squirrel-uninstall',
  '--squirrel-obsolete',
]);

export function handleWindowsSquirrelEvent({
  platform,
  argv,
  execPath,
  spawnProcess,
  quit,
  scheduleQuit = setTimeout,
  pathApi = path,
}) {
  const squirrelEvent = argv[1];

  if (platform !== 'win32' || !SQUIRREL_EVENTS.has(squirrelEvent)) {
    return false;
  }

  if (squirrelEvent === '--squirrel-obsolete') {
    quit();
    return true;
  }

  const updateExecutablePath = pathApi.resolve(
    pathApi.dirname(execPath),
    '..',
    'Update.exe'
  );
  const shortcutArgument = INSTALL_OR_UPDATE_EVENTS.has(squirrelEvent)
    ? '--createShortcut'
    : '--removeShortcut';

  try {
    spawnProcess(
      updateExecutablePath,
      [shortcutArgument, pathApi.basename(execPath)],
      {
        detached: true,
        stdio: 'ignore',
      }
    )?.unref?.();
  } catch {
    // Squirrel's updater may already be unavailable during uninstall.
  }

  scheduleQuit(quit, 1_000);
  return true;
}
