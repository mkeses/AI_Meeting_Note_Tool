import { getBackendApiUrl } from './config';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_HEADER_NAME = 'X-CSRF-Token';

let csrfToken: string | null = null;

function isCsrfTokenResponse(value: unknown): value is { csrfToken: string } {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { csrfToken?: unknown }).csrfToken === 'string'
  );
}

function requestInitWithCsrf(init?: RequestInit): RequestInit {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (SAFE_METHODS.has(method) || !csrfToken) {
    return { ...init, credentials: 'include' };
  }

  const headers = new Headers(init?.headers);
  headers.set(CSRF_HEADER_NAME, csrfToken);
  return { ...init, credentials: 'include', headers };
}

/** Send an API request with the browser session and, when available, CSRF token. */
export function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  return fetch(getBackendApiUrl(path), requestInitWithCsrf(init));
}

/** Apply session and CSRF handling to an API URL already resolved by a hook. */
export function fetchApiUrl(
  url: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(url, requestInitWithCsrf(init));
}

/** Fetch a new signed CSRF token after discovering remote authentication. */
export async function refreshCsrfToken(): Promise<void> {
  const response = await fetchApi('/api/auth/csrf');
  if (!response.ok) {
    throw new Error(`CSRF token request failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isCsrfTokenResponse(payload) || payload.csrfToken.length > 512) {
    throw new Error('CSRF token response was invalid');
  }

  csrfToken = payload.csrfToken;
}

export function clearCsrfToken(): void {
  csrfToken = null;
}
