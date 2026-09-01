import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type NewSavedSession,
  type SavedSession,
  useMeetingSessions,
} from './useMeetingSessions';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createSession(overrides: Partial<SavedSession> = {}): SavedSession {
  return {
    id: 'session-1',
    sourceKey: 'source-1',
    filename: 'Meeting notes',
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    meetingType: 'general',
    rawText: 'Raw transcript',
    cleanedText: 'Cleaned transcript',
    sourceType: 'recording',
    notes: 'Follow up on the design decision.',
    ...overrides,
  };
}

function createNewSession(
  overrides: Partial<NewSavedSession> = {}
): NewSavedSession {
  return {
    id: 'session-1',
    sourceKey: 'source-1',
    filename: 'Meeting notes',
    createdAt: '2026-09-01T12:00:00.000Z',
    meetingType: 'general',
    rawText: 'Raw transcript',
    cleanedText: 'Cleaned transcript',
    sourceType: 'recording',
    notes: 'Follow up on the design decision.',
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

describe('useMeetingSessions', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads server meetings without changing existing localStorage data', async () => {
    const legacySessions = JSON.stringify([{ id: 'legacy-session' }]);
    localStorage.setItem('meeting-sessions', legacySessions);
    const serverSession = createSession();
    fetchMock.mockResolvedValueOnce(jsonResponse([serverSession]));

    const { result } = renderHook(() => useMeetingSessions());

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(fetchMock).toHaveBeenCalledWith('/api/meetings', undefined);
    expect(result.current.savedSessions).toEqual([serverSession]);
    expect(localStorage.getItem('meeting-sessions')).toBe(legacySessions);
  });

  it('exposes an error and recovery state when the initial request fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network unavailable'));

    const { result } = renderHook(() => useMeetingSessions());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.savedSessions).toEqual([]);
    expect(result.current.error).toBe(
      'Failed to load saved meetings: Network unavailable'
    );
  });

  it('creates a meeting from the server response with the client ID, sourceKey, and sourceType', async () => {
    const newSession = createNewSession({
      id: 'client-created-id',
      sourceKey: 'recording:client-source',
      sourceType: 'recording',
      notes: 'Persist this note.',
    });
    const createdSession = createSession({
      ...newSession,
      updatedAt: '2026-09-01T12:01:00.000Z',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    fetchMock.mockResolvedValueOnce(jsonResponse(createdSession, 201));

    const { result } = renderHook(() => useMeetingSessions());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let addResult: Awaited<ReturnType<typeof result.current.addSession>> = null;
    await act(async () => {
      addResult = await result.current.addSession(newSession);
    });

    expect(addResult).toEqual({
      activeSessionId: 'client-created-id',
      sessionExists: false,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSession),
    });
    expect(result.current.savedSessions).toEqual([createdSession]);
  });

  it('does not add a meeting when the POST request fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'Unavailable' }, 503)
    );

    const { result } = renderHook(() => useMeetingSessions());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addSession(createNewSession());
    });

    expect(result.current.savedSessions).toEqual([]);
    expect(result.current.error).toBe(
      'Failed to save meeting: Request failed with status 503'
    );
  });

  it('patches the selected meeting and leaves unrelated sessions unchanged', async () => {
    const sessionToUpdate = createSession({ id: 'update-1' });
    const unrelatedSession = createSession({
      id: 'keep-1',
      sourceKey: 'keep-source',
      filename: 'Keep this meeting',
    });
    const updatedSession = createSession({
      ...sessionToUpdate,
      filename: 'Updated meeting',
      rawText: 'Edited raw transcript',
      cleanedText: '',
      meetingType: 'design_review',
      updatedAt: '2026-09-01T12:05:00.000Z',
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse([sessionToUpdate, unrelatedSession])
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(updatedSession));

    const { result } = renderHook(() => useMeetingSessions());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let savedId: Awaited<ReturnType<typeof result.current.saveSession>> = null;
    await act(async () => {
      savedId = await result.current.saveSession(
        sessionToUpdate.id,
        ' Updated meeting ',
        'Edited raw transcript',
        null,
        'design_review'
      );
    });

    expect(savedId).toBe(sessionToUpdate.id);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/meetings/update-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'Updated meeting',
        rawText: 'Edited raw transcript',
        cleanedText: '',
        meetingType: 'design_review',
      }),
    });
    expect(result.current.savedSessions).toEqual([
      updatedSession,
      unrelatedSession,
    ]);
  });

  it('preserves the previous meeting state when PATCH fails', async () => {
    const session = createSession({ id: 'update-1' });
    fetchMock.mockResolvedValueOnce(jsonResponse([session]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'Unavailable' }, 503)
    );

    const { result } = renderHook(() => useMeetingSessions());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.saveSession(
        session.id,
        'Changed title',
        'Changed text',
        'Changed cleanup',
        'standup'
      );
    });

    expect(result.current.savedSessions).toEqual([session]);
    expect(result.current.error).toBe(
      'Failed to save meeting: Request failed with status 503'
    );
  });

  it('updates an existing sourceKey through PATCH instead of creating a duplicate', async () => {
    const existingSession = createSession({ id: 'existing-id' });
    const replacement = createSession({
      ...existingSession,
      filename: 'Replacement transcript',
      rawText: 'Replacement raw text',
      updatedAt: '2026-09-01T12:10:00.000Z',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse([existingSession]));
    fetchMock.mockResolvedValueOnce(jsonResponse(replacement));

    const { result } = renderHook(() => useMeetingSessions());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addSession(
        createNewSession({
          id: 'new-client-id',
          sourceKey: existingSession.sourceKey,
          filename: 'Replacement transcript',
          rawText: 'Replacement raw text',
        })
      );
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/meetings/existing-id',
      expect.objectContaining({ method: 'PATCH' })
    );
    expect(result.current.savedSessions).toEqual([replacement]);
  });

  it('removes a meeting only after DELETE succeeds', async () => {
    const deletedSession = createSession({ id: 'delete-1' });
    const remainingSession = createSession({
      id: 'keep-1',
      sourceKey: 'keep-source',
    });
    const pendingDelete = createDeferred<Response>();
    fetchMock.mockResolvedValueOnce(
      jsonResponse([deletedSession, remainingSession])
    );
    fetchMock.mockReturnValueOnce(pendingDelete.promise);

    const { result } = renderHook(() => useMeetingSessions());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let deletePromise: ReturnType<typeof result.current.deleteSession>;
    act(() => {
      deletePromise = result.current.deleteSession(deletedSession.id);
    });

    expect(result.current.savedSessions).toEqual([
      deletedSession,
      remainingSession,
    ]);

    await act(async () => {
      pendingDelete.resolve(new Response(null, { status: 204 }));
      await deletePromise;
    });

    expect(result.current.savedSessions).toEqual([remainingSession]);
  });

  it('preserves a meeting when DELETE fails', async () => {
    const session = createSession({ id: 'delete-1' });
    fetchMock.mockResolvedValueOnce(jsonResponse([session]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'Unavailable' }, 503)
    );

    const { result } = renderHook(() => useMeetingSessions());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.deleteSession(session.id);
    });

    expect(result.current.savedSessions).toEqual([session]);
    expect(result.current.error).toBe(
      'Failed to delete meeting: Request failed with status 503'
    );
  });

  it('opens a loaded session without an additional API request', async () => {
    const session = createSession({ sourceType: 'text' });
    fetchMock.mockResolvedValueOnce(jsonResponse([session]));

    const { result } = renderHook(() => useMeetingSessions());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const opened = result.current.openSavedSession(session, false, false);

    expect(opened?.sessionInputType).toBe('text');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
