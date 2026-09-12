import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  PACKAGED_OLLAMA_DIRECTORY_NAME,
  PACKAGED_OLLAMA_EXECUTABLE_NAME,
} from './desktop-runtime.mjs';

export const OLLAMA_VERSION = '0.34.0';
export const OLLAMA_ARCHIVE_NAME = 'ollama-windows-amd64.zip';
export const OLLAMA_ARCHIVE_URL =
  `https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/${OLLAMA_ARCHIVE_NAME}`;
export const OLLAMA_ARCHIVE_SHA256 =
  'a7dd1b174f39d3d1b8a25d4cbc86045d0e190b17187bfdcbe2f2ee3b5a11470e';

function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function resolveBundledOllamaPaths({
  resourcesDirectory,
  pathApi = path,
} = {}) {
  const runtimeDirectory = pathApi.join(
    resourcesDirectory,
    PACKAGED_OLLAMA_DIRECTORY_NAME
  );

  return {
    runtimeDirectory,
    executablePath: pathApi.join(
      runtimeDirectory,
      PACKAGED_OLLAMA_EXECUTABLE_NAME
    ),
  };
}

export function resolveOllamaDownloadDirectory({
  repositoryDirectory,
  pathApi = path,
} = {}) {
  return pathApi.join(
    repositoryDirectory,
    'dist',
    'ollama-runtime',
    `v${OLLAMA_VERSION}`
  );
}

export function validateOllamaRuntime({
  sourceDirectory,
  fsApi = fs,
  pathApi = path,
} = {}) {
  const executablePath = pathApi.join(
    sourceDirectory,
    PACKAGED_OLLAMA_EXECUTABLE_NAME
  );

  if (!fsApi.existsSync(sourceDirectory)) {
    throw new Error(`Ollama runtime is missing: ${sourceDirectory}.`);
  }

  if (!fsApi.statSync(sourceDirectory).isDirectory()) {
    throw new Error(`Ollama runtime must be a directory: ${sourceDirectory}.`);
  }

  if (!fsApi.existsSync(executablePath) || !fsApi.statSync(executablePath).isFile()) {
    throw new Error(`Ollama runtime is incomplete: ${executablePath} is missing.`);
  }

  return { sourceDirectory, executablePath };
}

export function stageOllamaRuntime({
  sourceDirectory,
  resourcesDirectory,
  fsApi = fs,
  pathApi = path,
} = {}) {
  const source = validateOllamaRuntime({ sourceDirectory, fsApi, pathApi });
  const destination = resolveBundledOllamaPaths({
    resourcesDirectory,
    pathApi,
  });

  fsApi.mkdirSync(resourcesDirectory, { recursive: true });
  fsApi.rmSync(destination.runtimeDirectory, { recursive: true, force: true });
  fsApi.cpSync(source.sourceDirectory, destination.runtimeDirectory, {
    recursive: true,
  });

  return {
    ...source,
    destinationDirectory: destination.runtimeDirectory,
    destinationExecutablePath: destination.executablePath,
  };
}

function downloadFile(url, destinationPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('Too many redirects while downloading Ollama.'));
      return;
    }

    const request = https.get(url, (response) => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          downloadFile(response.headers.location, destinationPath, redirects + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(`Ollama download failed with HTTP ${response.statusCode}.`)
          );
          return;
        }

        const output = fs.createWriteStream(destinationPath);
        const hash = crypto.createHash('sha256');

        response.on('data', (chunk) => hash.update(chunk));
        response.on('error', (error) => {
          output.destroy();
          reject(error);
        });
        output.on('error', reject);
        output.on('finish', () => {
          resolve(hash.digest('hex'));
        });
        response.pipe(output);
      });

    request.on('error', reject);
  });
}

export async function ensureOllamaRuntimeDownloaded({
  repositoryDirectory,
  downloadDirectory = resolveOllamaDownloadDirectory({ repositoryDirectory }),
  fsApi = fs,
  pathApi = path,
  execFileSyncImpl = execFileSync,
} = {}) {
  try {
    return validateOllamaRuntime({
      sourceDirectory: downloadDirectory,
      fsApi,
      pathApi,
    });
  } catch (error) {
    if (!String(error?.message ?? '').includes('is missing')) {
      throw error;
    }
  }

  const temporaryDirectory = fsApi.mkdtempSync(
    pathApi.join(os.tmpdir(), 'ai-meeting-note-ollama-')
  );
  const archivePath = pathApi.join(temporaryDirectory, OLLAMA_ARCHIVE_NAME);
  const extractedDirectory = pathApi.join(temporaryDirectory, 'extracted');

  try {
    fsApi.mkdirSync(extractedDirectory, { recursive: true });
    const digest = await downloadFile(OLLAMA_ARCHIVE_URL, archivePath);

    if (digest !== OLLAMA_ARCHIVE_SHA256) {
      throw new Error('Ollama download checksum verification failed.');
    }

    const expandCommand = [
      'Expand-Archive',
      '-LiteralPath',
      quotePowerShellLiteral(archivePath),
      '-DestinationPath',
      quotePowerShellLiteral(extractedDirectory),
      '-Force',
    ].join(' ');
    execFileSyncImpl('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      expandCommand,
    ]);

    const runtime = validateOllamaRuntime({
      sourceDirectory: extractedDirectory,
      fsApi,
      pathApi,
    });
    fsApi.rmSync(downloadDirectory, { recursive: true, force: true });
    fsApi.mkdirSync(pathApi.dirname(downloadDirectory), { recursive: true });
    fsApi.cpSync(runtime.sourceDirectory, downloadDirectory, {
      recursive: true,
    });

    return validateOllamaRuntime({
      sourceDirectory: downloadDirectory,
      fsApi,
      pathApi,
    });
  } finally {
    fsApi.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
