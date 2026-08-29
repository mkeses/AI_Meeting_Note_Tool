/**
 * Central place for environment-dependent connection settings.
 *
 * VITE_WS_URL may be a WebSocket host/base URL or the full transcription
 * endpoint. The fixed /ws/transcribe endpoint is added to base URLs. If it is
 * not set, we derive a sensible local-development URL from the current page's
 * hostname, so this keeps working out of the box in the dev container without
 * requiring a .env file.
 */
export function getTranscribeWebSocketUrl(): string {
  const configuredUrl = import.meta.env.VITE_WS_URL as string | undefined;

  if (configuredUrl && configuredUrl.trim()) {
    const url = new URL(configuredUrl.trim());

    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error('VITE_WS_URL must use the ws:// or wss:// protocol.');
    }

    const configuredPath = url.pathname.replace(/\/+$/, '');
    if (!configuredPath.endsWith('/ws/transcribe')) {
      url.pathname = `${configuredPath}/ws/transcribe`;
    }

    return url.toString();
  }

  const isSecurePage = window.location.protocol === 'https:';
  const wsProtocol = isSecurePage ? 'wss' : 'ws';
  const backendPort = (import.meta.env.VITE_BACKEND_PORT as string) || '8000';

  return `${wsProtocol}://${window.location.hostname}:${backendPort}/ws/transcribe`;
}
