import fs from 'node:fs';
import path from 'node:path';
import {
  FRONTEND_DIRECTORY,
  REPOSITORY_DIRECTORY,
  resolveWindowsBackendSourceDirectory,
} from './windows-backend-stage.mjs';
import { resolveOllamaDownloadDirectory } from './ollama-runtime.mjs';

export const WINDOWS_APPLICATION_ID = 'com.mkeses.ai-meeting-note-tool';
export const WINDOWS_PRODUCT_NAME = 'AI Meeting Note Tool';
export const WINDOWS_NSIS_DIRECTORY_NAME = 'windows-installer-nsis';

export function resolveWindowsNsisOutputDirectory({
  repositoryDirectory = REPOSITORY_DIRECTORY,
  pathApi = path,
} = {}) {
  return pathApi.join(repositoryDirectory, 'dist', WINDOWS_NSIS_DIRECTORY_NAME);
}

export function resolveWindowsNsisArtifactPath({
  outputDirectory = resolveWindowsNsisOutputDirectory(),
  version,
  pathApi = path,
}) {
  return pathApi.join(
    outputDirectory,
    `${WINDOWS_PRODUCT_NAME} Setup ${version}.exe`
  );
}

export function createWindowsNsisConfiguration({
  frontendDirectory = FRONTEND_DIRECTORY,
  repositoryDirectory = REPOSITORY_DIRECTORY,
  outputDirectory = resolveWindowsNsisOutputDirectory({ repositoryDirectory }),
  backendDirectory = resolveWindowsBackendSourceDirectory({
    repositoryDirectory,
  }),
  ollamaDirectory = resolveOllamaDownloadDirectory({ repositoryDirectory }),
} = {}) {
  return {
    appId: WINDOWS_APPLICATION_ID,
    productName: WINDOWS_PRODUCT_NAME,
    directories: {
      app: frontendDirectory,
      output: outputDirectory,
    },
    asar: true,
    files: [
      'dist/**',
      'electron/**',
      'package.json',
      '!electron/**/*.node-test.mjs',
    ],
    extraResources: [
      {
        from: backendDirectory,
        to: 'backend',
        filter: ['**/*'],
      },
      {
        from: ollamaDirectory,
        to: 'ollama',
        filter: ['**/*'],
      },
    ],
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
    },
    nsis: {
      artifactName: WINDOWS_PRODUCT_NAME + ' Setup ${version}.${ext}',
      oneClick: false,
      perMachine: false,
      selectPerMachineByDefault: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: WINDOWS_PRODUCT_NAME,
      runAfterFinish: true,
    },
  };
}

export function validateWindowsNsisOutput({
  outputDirectory,
  version,
  fsApi = fs,
  pathApi = path,
}) {
  const artifactPath = resolveWindowsNsisArtifactPath({
    outputDirectory,
    version,
    pathApi,
  });
  const unpackedResourcesDirectory = pathApi.join(
    outputDirectory,
    'win-unpacked',
    'resources'
  );
  const requiredPaths = [
    artifactPath,
    pathApi.join(unpackedResourcesDirectory, 'app.asar'),
    pathApi.join(
      unpackedResourcesDirectory,
      'backend',
      'ai-meeting-note-backend.exe'
    ),
    pathApi.join(
      unpackedResourcesDirectory,
      'backend',
      '_internal',
      'ctranslate2',
      'ctranslate2.dll'
    ),
    pathApi.join(
      unpackedResourcesDirectory,
      'backend',
      '_internal',
      'ctranslate2',
      'cudnn64_9.dll'
    ),
    pathApi.join(unpackedResourcesDirectory, 'ollama', 'ollama.exe'),
    pathApi.join(
      unpackedResourcesDirectory,
      'ollama',
      'lib',
      'ollama',
      'cuda_v12',
      'cublas64_12.dll'
    ),
    pathApi.join(
      unpackedResourcesDirectory,
      'ollama',
      'lib',
      'ollama',
      'cuda_v12',
      'cublasLt64_12.dll'
    ),
    pathApi.join(
      unpackedResourcesDirectory,
      'ollama',
      'lib',
      'ollama',
      'cuda_v12',
      'cudart64_12.dll'
    ),
    pathApi.join(
      unpackedResourcesDirectory,
      'ollama',
      'lib',
      'ollama',
      'CUDNN_LICENSE.txt'
    ),
  ];

  for (const requiredPath of requiredPaths) {
    if (!fsApi.existsSync(requiredPath)) {
      throw new Error(`Windows NSIS package is incomplete: ${requiredPath}`);
    }
  }

  const obsoleteSquirrelArtifacts = ['RELEASES', '.nupkg'].filter((suffix) =>
    fsApi
      .readdirSync(outputDirectory)
      .some((entry) => entry === suffix || entry.endsWith(suffix))
  );

  if (obsoleteSquirrelArtifacts.length > 0) {
    throw new Error(
      `Windows NSIS output contains Squirrel artifacts: ${obsoleteSquirrelArtifacts.join(', ')}`
    );
  }

  if (fsApi.existsSync(pathApi.join(unpackedResourcesDirectory, 'models'))) {
    throw new Error(
      'Windows NSIS package must not contain downloaded model data.'
    );
  }

  return { artifactPath, unpackedResourcesDirectory };
}
