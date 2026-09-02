import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  WINDOWS_INSTALLER_DIRECTORY_NAME,
  WINDOWS_INSTALLER_DESCRIPTION,
  WINDOWS_INSTALLER_SETUP_EXECUTABLE_NAME,
  createWindowsInstallerArtifact,
  createWindowsInstallerOptions,
  resolveWindowsInstallerOutputDirectory,
} from './windows-installer.mjs';

const APPLICATION_NAME = 'AI Meeting Note Tool';

test('resolves a Windows installer directory outside the packaged app', () => {
  const outputDirectory = resolveWindowsInstallerOutputDirectory({
    repositoryDirectory: 'C:\\workspace\\ai-meeting-note-tool',
    pathApi: path.win32,
  });

  assert.equal(
    outputDirectory,
    `C:\\workspace\\ai-meeting-note-tool\\dist\\${WINDOWS_INSTALLER_DIRECTORY_NAME}`
  );
});

test('creates a Squirrel installer from the complete packaged application directory', async () => {
  const options = createWindowsInstallerOptions({
    applicationDirectory:
      'C:\\workspace\\dist\\windows-electron\\AI Meeting Note Tool-win32-x64',
    outputDirectory: 'C:\\workspace\\dist\\windows-installer',
    applicationName: APPLICATION_NAME,
  });
  const receivedOptions = [];

  const result = await createWindowsInstallerArtifact({
    applicationDirectory: options.appDirectory,
    outputDirectory: options.outputDirectory,
    applicationName: APPLICATION_NAME,
    createInstaller: async (installerOptions) => {
      receivedOptions.push(installerOptions);
    },
  });

  assert.deepEqual(result, options);
  assert.deepEqual(receivedOptions, [options]);
  assert.equal(options.exe, 'AI Meeting Note Tool.exe');
  assert.equal(options.description, WINDOWS_INSTALLER_DESCRIPTION);
  assert.equal(options.setupExe, WINDOWS_INSTALLER_SETUP_EXECUTABLE_NAME);
  assert.equal(options.noMsi, true);
});
