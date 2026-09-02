import os from 'node:os';
import path from 'node:path';
import { packager } from '@electron/packager';
import {
  FRONTEND_DIRECTORY,
  REPOSITORY_DIRECTORY,
  resolveWindowsBackendSourceDirectory,
  stageWindowsBackend,
  validateWindowsBackendArtifact,
} from './windows-backend-stage.mjs';

const PACKAGE_NAME = 'AI Meeting Note Tool';
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

async function packageWindowsApplication() {
  requireWindowsX64();

  const sourceDirectory = resolveWindowsBackendSourceDirectory();
  validateWindowsBackendArtifact({ sourceDirectory });

  const applicationDirectories = await packager({
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

  for (const applicationDirectory of applicationDirectories) {
    console.log(`Packaged Windows desktop app: ${applicationDirectory}`);
  }
}

packageWindowsApplication().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
