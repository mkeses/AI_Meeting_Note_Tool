import fs from 'node:fs';
import path from 'node:path';

export const DESKTOP_APPLICATION_NAME = 'AI Meeting Note Tool';
export const DESKTOP_CONFIG_VERSION = 1;

export const DEFAULT_DESKTOP_RUNTIME_CONFIG = Object.freeze({
  configVersion: DESKTOP_CONFIG_VERSION,
  whisperModel: 'base.en',
  llm: Object.freeze({
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'gemma3:4b',
  }),
});

function createDefaultDesktopRuntimeConfig() {
  return {
    configVersion: DEFAULT_DESKTOP_RUNTIME_CONFIG.configVersion,
    whisperModel: DEFAULT_DESKTOP_RUNTIME_CONFIG.whisperModel,
    llm: {
      baseUrl: DEFAULT_DESKTOP_RUNTIME_CONFIG.llm.baseUrl,
      model: DEFAULT_DESKTOP_RUNTIME_CONFIG.llm.model,
    },
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readOptionalString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function resolveDesktopDataRoot({
  platform,
  localAppData,
  userDataPath,
  pathApi = path,
}) {
  if (platform === 'win32') {
    if (!localAppData) {
      throw new Error('LOCALAPPDATA is required to resolve Windows app data.');
    }

    return pathApi.join(localAppData, DESKTOP_APPLICATION_NAME);
  }

  return pathApi.join(userDataPath, DESKTOP_APPLICATION_NAME);
}

export function resolveDesktopRuntimePaths({ dataRoot, pathApi = path }) {
  return {
    dataRoot,
    configurationDirectory: pathApi.join(dataRoot, 'config'),
    configurationFilePath: pathApi.join(
      dataRoot,
      'config',
      'runtime-config.json'
    ),
    dataDirectory: pathApi.join(dataRoot, 'data'),
    databasePath: pathApi.join(dataRoot, 'data', 'meetings.db'),
    modelCacheDirectory: pathApi.join(dataRoot, 'models', 'huggingface'),
    logsDirectory: pathApi.join(dataRoot, 'logs'),
    runtimeStateDirectory: pathApi.join(dataRoot, 'runtime'),
    electronUserDataDirectory: pathApi.join(dataRoot, 'electron'),
    electronSessionDataDirectory: pathApi.join(dataRoot, 'electron', 'session'),
  };
}

export function resolveDesktopResourcePaths({
  appPath,
  resourcesPath,
  pathApi = path,
}) {
  return {
    applicationResourcesDirectory: resourcesPath,
    rendererIndexPath: pathApi.join(appPath, 'dist', 'index.html'),
  };
}

export function ensureDesktopRuntimeDirectories(paths, fsApi = fs) {
  for (const directory of [
    paths.configurationDirectory,
    paths.dataDirectory,
    paths.modelCacheDirectory,
    paths.logsDirectory,
    paths.runtimeStateDirectory,
    paths.electronUserDataDirectory,
    paths.electronSessionDataDirectory,
  ]) {
    fsApi.mkdirSync(directory, { recursive: true });
  }
}

export function parseDesktopRuntimeConfig(config) {
  if (!isPlainObject(config)) {
    throw new Error('Desktop runtime configuration must be an object.');
  }

  if (
    config.configVersion !== undefined &&
    config.configVersion !== DESKTOP_CONFIG_VERSION
  ) {
    throw new Error(
      `Unsupported desktop runtime configuration version: ${String(
        config.configVersion
      )}`
    );
  }

  if (config.llm !== undefined && !isPlainObject(config.llm)) {
    throw new Error('Desktop runtime configuration LLM settings are invalid.');
  }

  const llm = config.llm ?? {};

  return {
    configVersion: DESKTOP_CONFIG_VERSION,
    whisperModel: readOptionalString(
      config.whisperModel,
      DEFAULT_DESKTOP_RUNTIME_CONFIG.whisperModel
    ),
    llm: {
      baseUrl: readOptionalString(
        llm.baseUrl,
        DEFAULT_DESKTOP_RUNTIME_CONFIG.llm.baseUrl
      ),
      model: readOptionalString(
        llm.model,
        DEFAULT_DESKTOP_RUNTIME_CONFIG.llm.model
      ),
    },
  };
}

export function loadDesktopRuntimeConfig(paths, fsApi = fs) {
  try {
    const contents = fsApi.readFileSync(paths.configurationFilePath, 'utf8');
    return parseDesktopRuntimeConfig(JSON.parse(contents));
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      if (error instanceof SyntaxError) {
        throw new Error('Desktop runtime configuration contains invalid JSON.');
      }

      throw error;
    }
  }

  const defaults = createDefaultDesktopRuntimeConfig();

  try {
    fsApi.writeFileSync(
      paths.configurationFilePath,
      `${JSON.stringify(defaults, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );
    return defaults;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return loadDesktopRuntimeConfig(paths, fsApi);
    }

    throw error;
  }
}

export function initializeDesktopRuntime({
  platform,
  localAppData,
  userDataPath,
  pathApi = path,
  fsApi = fs,
}) {
  const dataRoot = resolveDesktopDataRoot({
    platform,
    localAppData,
    userDataPath,
    pathApi,
  });
  const paths = resolveDesktopRuntimePaths({ dataRoot, pathApi });

  ensureDesktopRuntimeDirectories(paths, fsApi);

  return {
    paths,
    config: loadDesktopRuntimeConfig(paths, fsApi),
  };
}
