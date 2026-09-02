import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { packager } from '@electron/packager';
import {
  FRONTEND_DIRECTORY,
  REPOSITORY_DIRECTORY,
  resolveWindowsBackendSourceDirectory,
  stageWindowsBackend,
  validateWindowsBackendArtifact,
} from './windows-backend-stage.mjs';
import {
  WINDOWS_INSTALLER_SETUP_EXECUTABLE_NAME,
  createWindowsInstallerArtifact,
  resolveWindowsInstallerOutputDirectory,
} from './windows-installer.mjs';

const require = createRequire(import.meta.url);
const { createWindowsInstaller } = require('electron-winstaller');

export const PACKAGE_NAME = 'AI Meeting Note Tool';
const OUTPUT_DIRECTORY = path.join(
  REPOSITORY_DIRECTORY,
  'dist',
  'windows-electron'
);

function requireWindowsX64() {
  if (process.platform !== 'win32' || os.arch() !== 'x64') {
    throw new Error(
      'Windows x64 is required to package the desktop application with its Windows backend.'
    );
  }
}

export async function packageWindowsApplication({
  packagerImpl = packager,
  createInstaller = createWindowsInstaller,
} = {}) {
  requireWindowsX64();

  const sourceDirectory = resolveWindowsBackendSourceDirectory();
  validateWindowsBackendArtifact({ sourceDirectory });

  const applicationDirectories = await packagerImpl({
    dir: FRONTEND_DIRECTORY,
    out: OUTPUT_DIRECTORY,
    name: PACKAGE_NAME,
    platform: 'win32',
    arch: 'x64',
    asar: true,
    overwrite: true,
    prune: true,
  });

  for (const applicationDirectory of applicationDirectories) {
    stageWindowsBackend({
      sourceDirectory,
      resourcesDirectory: path.join(applicationDirectory, 'resources'),
    });
  }

  const installerOutputDirectory = resolveWindowsInstallerOutputDirectory();

  for (const applicationDirectory of applicationDirectories) {
    await createWindowsInstallerArtifact({
      applicationDirectory,
      applicationName: PACKAGE_NAME,
      createInstaller,
      outputDirectory: installerOutputDirectory,
    });
  }

  for (const applicationDirectory of applicationDirectories) {
    console.log(`Packaged Windows desktop app: ${applicationDirectory}`);
  }

  console.log(
    `Windows installer: ${path.join(
      installerOutputDirectory,
      WINDOWS_INSTALLER_SETUP_EXECUTABLE_NAME
    )}`
  );
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  packageWindowsApplication().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
