/**
 * Central place for environment-dependent connection settings.
 *
 * VITE_WS_URL, if set, is used as-is (e.g. "wss://api.example.com/ws/transcribe"
 * for a remote/production backend). If it's not set, we fall back to
 * deriving a sensible local-dev WebSocket URL from the current page's
 * hostname, so this keeps working out of the box in the dev container
 * without requiring a .env file for local development.
 */
export function getTranscribeWebSocketUrl(): string {
  const configuredUrl = import.meta.env.VITE_WS_URL as string | undefined;

  if (configuredUrl && configuredUrl.trim()) {
    return configuredUrl.trim();
  }

  const isSecurePage = window.location.protocol === 'https:';
  const wsProtocol = isSecurePage ? 'wss' : 'ws';
  const backendPort = (import.meta.env.VITE_BACKEND_PORT as string) || '8000';

  return `${wsProtocol}://${window.location.hostname}:${backendPort}/ws/transcribe`;
}
