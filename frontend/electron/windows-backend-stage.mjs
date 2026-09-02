import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGED_BACKEND_DIRECTORY_NAME,
  PACKAGED_BACKEND_EXECUTABLE_NAME,
} from './desktop-runtime.mjs';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
export const FRONTEND_DIRECTORY = path.resolve(currentDirectory, '..');
export const REPOSITORY_DIRECTORY = path.resolve(FRONTEND_DIRECTORY, '..');
export const PYINSTALLER_BACKEND_DIRECTORY_NAME = 'ai-meeting-note-backend';

export function resolveWindowsBackendSourceDirectory({
  repositoryDirectory = REPOSITORY_DIRECTORY,
  pathApi = path,
} = {}) {
  return pathApi.join(
    repositoryDirectory,
    'backend',
    'dist',
    'windows-backend',
    PYINSTALLER_BACKEND_DIRECTORY_NAME
  );
}

export function resolvePackagedBackendDirectory({
  resourcesDirectory,
  pathApi = path,
}) {
  return pathApi.join(resourcesDirectory, PACKAGED_BACKEND_DIRECTORY_NAME);
}

export function validateWindowsBackendArtifact({
  sourceDirectory = resolveWindowsBackendSourceDirectory(),
  fsApi = fs,
  pathApi = path,
} = {}) {
  if (!fsApi.existsSync(sourceDirectory)) {
    throw new Error(
      `Windows backend artifact is missing: ${sourceDirectory}. ` +
        'Run the backend Windows PyInstaller build first.'
    );
  }

  if (!fsApi.statSync(sourceDirectory).isDirectory()) {
    throw new Error(
      `Windows backend artifact must be a directory: ${sourceDirectory}.`
    );
  }

  const executablePath = pathApi.join(
    sourceDirectory,
    PACKAGED_BACKEND_EXECUTABLE_NAME
  );
  const internalDirectory = pathApi.join(sourceDirectory, '_internal');

  if (
    !fsApi.existsSync(executablePath) ||
    !fsApi.statSync(executablePath).isFile()
  ) {
    throw new Error(
      `Windows backend artifact is incomplete: ${executablePath} is missing.`
    );
  }

  if (
    !fsApi.existsSync(internalDirectory) ||
    !fsApi.statSync(internalDirectory).isDirectory()
  ) {
    throw new Error(
      `Windows backend artifact is incomplete: ${internalDirectory} is missing.`
    );
  }

  return { sourceDirectory, executablePath, internalDirectory };
}

export function stageWindowsBackend({
  resourcesDirectory,
  sourceDirectory = resolveWindowsBackendSourceDirectory(),
  fsApi = fs,
  pathApi = path,
}) {
  const artifact = validateWindowsBackendArtifact({
    sourceDirectory,
    fsApi,
    pathApi,
  });
  const destinationDirectory = resolvePackagedBackendDirectory({
    resourcesDirectory,
    pathApi,
  });

  fsApi.mkdirSync(resourcesDirectory, { recursive: true });
  fsApi.rmSync(destinationDirectory, { recursive: true, force: true });
  fsApi.cpSync(artifact.sourceDirectory, destinationDirectory, {
    recursive: true,
  });

  return {
    ...artifact,
    destinationDirectory,
    destinationExecutablePath: pathApi.join(
      destinationDirectory,
      PACKAGED_BACKEND_EXECUTABLE_NAME
    ),
  };
}
