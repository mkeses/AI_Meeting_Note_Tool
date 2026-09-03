function normalizeBackendOrigin(origin: string): string {
  const url = new URL(origin.trim());

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The desktop backend origin must use http:// or https://.');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The desktop backend origin must be a plain origin.');
  }

  return url.origin;
}

function appendTranscriptionPath(url: URL): string {
  const configuredPath = url.pathname.replace(/\/+$/, '');

  if (!configuredPath.endsWith('/ws/transcribe')) {
    url.pathname = `${configuredPath}/ws/transcribe`;
  }

  return url.toString();
}

function getDesktopBackendOrigin(): string | null {
  const origin = window.meetingDesktop?.backendOrigin;

  return origin ? normalizeBackendOrigin(origin) : null;
}

function getConfiguredBackendOrigin(): string | null {
  const origin = import.meta.env.VITE_BACKEND_URL as string | undefined;
  return origin && origin.trim() ? normalizeBackendOrigin(origin) : null;
}

export function getDefaultTranscribeWebSocketUrl(
  isProduction: boolean,
  location: Pick<Location, 'host' | 'hostname' | 'protocol'>,
  backendPort: string
): string {
  const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';

  if (isProduction) {
    return `${wsProtocol}://${location.host}/ws/transcribe`;
  }

  return `${wsProtocol}://${location.hostname}:${backendPort}/ws/transcribe`;
}

/**
 * Returns an API path for browser/Vite development, or a loopback API URL for
 * the Electron renderer. Electron supplies its backend origin through the
 * context-isolated preload bridge.
 */
export function getBackendApiUrl(path: string): string {
  const desktopBackendOrigin = getDesktopBackendOrigin();

  if (!desktopBackendOrigin) {
    const configuredBackendOrigin = getConfiguredBackendOrigin();
    return configuredBackendOrigin
      ? new URL(path, configuredBackendOrigin).toString()
      : path;
  }

  return new URL(path, desktopBackendOrigin).toString();
}

/**
 * Central place for environment-dependent connection settings.
 *
 * Electron uses its runtime loopback backend origin. Browser/Vite development
 * continues to support VITE_WS_URL and its existing local fallback.
 */
export function getTranscribeWebSocketUrl(): string {
  const desktopBackendOrigin = getDesktopBackendOrigin();

  if (desktopBackendOrigin) {
    const url = new URL(desktopBackendOrigin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    return appendTranscriptionPath(url);
  }

  const configuredUrl = import.meta.env.VITE_WS_URL as string | undefined;

  if (configuredUrl && configuredUrl.trim()) {
    const url = new URL(configuredUrl.trim());

    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error('VITE_WS_URL must use the ws:// or wss:// protocol.');
    }

    return appendTranscriptionPath(url);
  }

  const configuredBackendOrigin = getConfiguredBackendOrigin();
  if (configuredBackendOrigin) {
    const url = new URL(configuredBackendOrigin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return appendTranscriptionPath(url);
  }

  const backendPort = (import.meta.env.VITE_BACKEND_PORT as string) || '8000';

  return getDefaultTranscribeWebSocketUrl(
    import.meta.env.PROD,
    window.location,
    backendPort
  );
}
