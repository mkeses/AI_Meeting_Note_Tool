import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCsrfToken, fetchApi, refreshCsrfToken } from './api';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('API request CSRF handling', () => {
  beforeEach(() => {
    clearCsrfToken();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    clearCsrfToken();
    vi.unstubAllGlobals();
  });

  it('keeps safe requests credentialed without a CSRF header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await fetchApi('/api/meetings');

    expect(fetchMock).toHaveBeenCalledWith('/api/meetings', {
      credentials: 'include',
    });
  });

  it('adds the issued token only to unsafe API requests', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ csrfToken: 'signed-token' })
    );
    await refreshCsrfToken();
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await fetchApi('/api/meetings', { method: 'POST' });

    const postCall = fetchMock.mock.calls[1];
    expect(postCall).toBeDefined();
    const [, init] = postCall!;
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('signed-token');
  });

  it('rejects malformed token responses without retaining a token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ csrfToken: 123 }));

    await expect(refreshCsrfToken()).rejects.toThrow(
      'CSRF token response was invalid'
    );

    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await fetchApi('/api/meetings', { method: 'POST' });
    const postCall = fetchMock.mock.calls[1];
    expect(postCall).toBeDefined();
    const [, init] = postCall!;
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBeNull();
  });
});
