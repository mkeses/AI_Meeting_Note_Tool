import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Arch, build, Platform } from 'electron-builder';
import {
  REPOSITORY_DIRECTORY,
  resolveWindowsBackendSourceDirectory,
  validateWindowsBackendArtifact,
} from './windows-backend-stage.mjs';
import {
  ensureOllamaRuntimeDownloaded,
  resolveOllamaDownloadDirectory,
} from './ollama-runtime.mjs';
import {
  createWindowsNsisConfiguration,
  resolveWindowsNsisOutputDirectory,
  validateWindowsNsisOutput,
} from './windows-nsis.mjs';

export const PACKAGE_NAME = 'AI Meeting Note Tool';

function requireWindowsX64() {
  if (process.platform !== 'win32' || os.arch() !== 'x64') {
    throw new Error(
      'Windows x64 is required to package the desktop application with its Windows backend.'
    );
  }
}

export async function packageWindowsApplication({
  buildImpl = build,
  packageVersion,
} = {}) {
  requireWindowsX64();

  const backendDirectory = resolveWindowsBackendSourceDirectory();
  validateWindowsBackendArtifact({ sourceDirectory: backendDirectory });
  const ollamaDirectory = resolveOllamaDownloadDirectory({
    repositoryDirectory: REPOSITORY_DIRECTORY,
  });
  await ensureOllamaRuntimeDownloaded({
    repositoryDirectory: REPOSITORY_DIRECTORY,
    downloadDirectory: ollamaDirectory,
  });

  const outputDirectory = resolveWindowsNsisOutputDirectory();
  const configuration = createWindowsNsisConfiguration({
    backendDirectory,
    ollamaDirectory,
    outputDirectory,
  });
  const artifactPaths = await buildImpl({
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    config: configuration,
  });
  const version = packageVersion ?? process.env.npm_package_version;

  if (!version) {
    throw new Error('The Windows package version is required for validation.');
  }

  const validation = validateWindowsNsisOutput({
    outputDirectory,
    version,
  });
  console.log(`Standalone Windows installer: ${validation.artifactPath}`);
  return { artifactPaths, configuration, validation };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  packageWindowsApplication().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
