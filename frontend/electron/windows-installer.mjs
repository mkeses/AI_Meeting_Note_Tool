import path from 'node:path';
import { REPOSITORY_DIRECTORY } from './windows-backend-stage.mjs';

export const WINDOWS_INSTALLER_DIRECTORY_NAME = 'windows-installer';
export const WINDOWS_INSTALLER_SETUP_EXECUTABLE_NAME =
  'AI Meeting Note Tool Setup.exe';
export const WINDOWS_INSTALLER_DESCRIPTION =
  'Local AI meeting transcription and notes.';

export function resolveWindowsInstallerOutputDirectory({
  repositoryDirectory = REPOSITORY_DIRECTORY,
  pathApi = path,
} = {}) {
  return pathApi.join(
    repositoryDirectory,
    'dist',
    WINDOWS_INSTALLER_DIRECTORY_NAME
  );
}

export function createWindowsInstallerOptions({
  applicationDirectory,
  outputDirectory = resolveWindowsInstallerOutputDirectory(),
  applicationName,
}) {
  return {
    appDirectory: applicationDirectory,
    outputDirectory,
    authors: applicationName,
    title: applicationName,
    description: WINDOWS_INSTALLER_DESCRIPTION,
    exe: `${applicationName}.exe`,
    setupExe: WINDOWS_INSTALLER_SETUP_EXECUTABLE_NAME,
    noMsi: true,
  };
}

export async function createWindowsInstallerArtifact({
  applicationDirectory,
  applicationName,
  createInstaller,
  outputDirectory,
}) {
  const options = createWindowsInstallerOptions({
    applicationDirectory,
    outputDirectory,
    applicationName,
  });

  await createInstaller(options);

  return options;
}
