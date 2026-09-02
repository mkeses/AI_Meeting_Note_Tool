import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { handleWindowsSquirrelEvent } from './windows-squirrel.mjs';

const EXECUTABLE_PATH =
  'C:\\Users\\Ada\\AppData\\Local\\AI Meeting Note Tool\\app-0.1.0\\AI Meeting Note Tool.exe';

function runSquirrelEvent(squirrelEvent) {
  const spawned = [];
  const scheduled = [];
  let quitCalls = 0;

  const handled = handleWindowsSquirrelEvent({
    platform: 'win32',
    argv: ['electron', squirrelEvent],
    execPath: EXECUTABLE_PATH,
    pathApi: path.win32,
    spawnProcess: (...arguments_) => {
      spawned.push(arguments_);
      return { unref() {} };
    },
    quit: () => {
      quitCalls += 1;
    },
    scheduleQuit: (...arguments_) => {
      scheduled.push(arguments_);
    },
  });

  return { handled, quitCalls, scheduled, spawned };
}

test('creates shortcuts for Squirrel install and update events', () => {
  for (const squirrelEvent of ['--squirrel-install', '--squirrel-updated']) {
    const result = runSquirrelEvent(squirrelEvent);

    assert.equal(result.handled, true);
    assert.deepEqual(result.spawned, [
      [
        'C:\\Users\\Ada\\AppData\\Local\\AI Meeting Note Tool\\Update.exe',
        ['--createShortcut', 'AI Meeting Note Tool.exe'],
        { detached: true, stdio: 'ignore' },
      ],
    ]);
    assert.equal(result.scheduled.length, 1);
    assert.equal(result.scheduled[0][1], 1_000);
  }
});

test('removes shortcuts for a Squirrel uninstall event', () => {
  const result = runSquirrelEvent('--squirrel-uninstall');

  assert.equal(result.handled, true);
  assert.deepEqual(result.spawned[0][1], [
    '--removeShortcut',
    'AI Meeting Note Tool.exe',
  ]);
  assert.equal(result.scheduled.length, 1);
});

test('quits obsolete installers without starting the application', () => {
  const result = runSquirrelEvent('--squirrel-obsolete');

  assert.equal(result.handled, true);
  assert.equal(result.spawned.length, 0);
  assert.equal(result.quitCalls, 1);
  assert.equal(result.scheduled.length, 0);
});

test('leaves normal and non-Windows startup unchanged', () => {
  const normal = runSquirrelEvent('--normal-startup');

  assert.equal(normal.handled, false);
  assert.equal(normal.spawned.length, 0);

  const handledOnLinux = handleWindowsSquirrelEvent({
    platform: 'linux',
    argv: ['electron', '--squirrel-install'],
    execPath: '/opt/ai-meeting-note-tool/AI Meeting Note Tool',
    spawnProcess: () => {
      throw new Error('Must not spawn on non-Windows platforms.');
    },
    quit: () => {
      throw new Error('Must not quit on non-Windows platforms.');
    },
  });

  assert.equal(handledOnLinux, false);
});
