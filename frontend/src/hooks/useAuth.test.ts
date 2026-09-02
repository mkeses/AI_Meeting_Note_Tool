import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from './useAuth';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const user = {
  id: 'user-1',
  login: 'matth',
  createdAt: '2026-09-02T12:00:00.000Z',
};

describe('useAuth', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the local browser and Electron workflow auth-free when auth is disabled', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Not found' }, 404));

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.status).toBe('local'));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', {
      credentials: 'include',
    });
  });

  it('signs in with an HttpOnly cookie request and retains no token in browser state', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'Sign in required' }, 401)
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(user));

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));

    await act(async () => {
      await result.current.login('matth', 'not-stored-in-browser');
    });

    expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: 'matth',
        password: 'not-stored-in-browser',
      }),
      credentials: 'include',
    });
    expect(result.current.status).toBe('authenticated');
    expect(result.current.user).toEqual(user);
  });

  it('creates an account and returns to sign-in without treating registration as a session', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'Sign in required' }, 401)
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(user, 201));

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.status).toBe('unauthenticated'));

    await act(async () => {
      await result.current.register('matth', 'new-password');
    });

    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.user).toBeNull();
    expect(result.current.message).toBe(
      'Account created. Sign in to open your workspace.'
    );
  });
});
