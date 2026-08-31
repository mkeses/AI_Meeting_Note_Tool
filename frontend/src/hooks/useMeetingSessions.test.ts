import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SavedSession, useMeetingSessions } from './useMeetingSessions';

const storageKey = 'meeting-sessions';

function createSession(overrides: Partial<SavedSession> = {}): SavedSession {
  return {
    id: 'session-1',
    sourceKey: 'source-1',
    filename: 'Meeting notes',
    createdAt: '2026-08-31T12:00:00.000Z',
    meetingType: 'general',
    rawText: 'Raw transcript',
    cleanedText: 'Cleaned transcript',
    ...overrides,
  };
}

describe('useMeetingSessions', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with empty sessions when localStorage is empty', () => {
    const { result } = renderHook(() => useMeetingSessions());

    expect(result.current.savedSessions).toEqual([]);
  });

  it('loads sessions from localStorage', () => {
    const mockSession = {
      id: 'test-1',
      sourceKey: 'test-key',
      filename: 'Test meeting',
      createdAt: new Date().toISOString(),
      meetingType: 'general' as const,
      rawText: 'Raw transcript',
      cleanedText: 'Cleaned transcript',
    };

    localStorage.setItem('meeting-sessions', JSON.stringify([mockSession]));

    const { result } = renderHook(() => useMeetingSessions());

    expect(result.current.savedSessions).toHaveLength(1);
    expect(result.current.savedSessions[0]?.filename).toBe('Test meeting');
  });

  it('adds a new session', () => {
    const { result } = renderHook(() => useMeetingSessions());

    const newSession = {
      id: 'new-1',
      sourceKey: 'new-key',
      filename: 'New meeting',
      createdAt: new Date().toISOString(),
      meetingType: 'standup' as const,
      rawText: 'New raw',
      cleanedText: 'New cleaned',
    };

    act(() => {
      result.current.addSession(newSession);
    });

    expect(result.current.savedSessions).toHaveLength(1);
    expect(result.current.savedSessions[0]?.filename).toBe('New meeting');
  });

  it('persists a newly added session with the hook session shape', () => {
    const { result } = renderHook(() => useMeetingSessions());
    const newSession = createSession({
      id: 'added-1',
      sourceKey: 'added-source',
      meetingType: 'standup',
    });

    act(() => {
      result.current.addSession(newSession);
    });

    const storedSessions = JSON.parse(
      localStorage.getItem(storageKey) || '[]'
    ) as SavedSession[];

    expect(storedSessions).toEqual([newSession]);
    expect(storedSessions).toEqual(result.current.savedSessions);
  });

  it('updates an existing session by sourceKey', () => {
    const existingSession = {
      id: 'existing-1',
      sourceKey: 'existing-key',
      filename: 'Old name',
      createdAt: new Date().toISOString(),
      meetingType: 'general' as const,
      rawText: 'Old raw',
      cleanedText: 'Old cleaned',
    };

    localStorage.setItem('meeting-sessions', JSON.stringify([existingSession]));

    const { result } = renderHook(() => useMeetingSessions());

    expect(result.current.savedSessions[0]?.filename).toBe('Old name');

    const updatedSession = {
      ...existingSession,
      filename: 'Updated name',
      rawText: 'Updated raw',
    };

    act(() => {
      result.current.addSession(updatedSession);
    });

    expect(result.current.savedSessions).toHaveLength(1);
    expect(result.current.savedSessions[0]?.filename).toBe('Updated name');
  });

  it('deletes a session', () => {
    const sessionToDelete = {
      id: 'delete-1',
      sourceKey: 'delete-key',
      filename: 'To delete',
      createdAt: new Date().toISOString(),
      meetingType: 'general' as const,
      rawText: 'Raw',
      cleanedText: 'Cleaned',
    };

    localStorage.setItem('meeting-sessions', JSON.stringify([sessionToDelete]));

    const { result } = renderHook(() => useMeetingSessions());

    expect(result.current.savedSessions).toHaveLength(1);

    act(() => {
      result.current.deleteSession('delete-1');
    });

    expect(result.current.savedSessions).toHaveLength(0);
  });

  it('persists updates without changing unrelated sessions', () => {
    const sessionToUpdate = createSession({
      id: 'update-1',
      sourceKey: 'update-source',
      filename: 'Original meeting',
    });
    const unrelatedSession = createSession({
      id: 'keep-1',
      sourceKey: 'keep-source',
      filename: 'Keep this meeting',
    });

    localStorage.setItem(
      storageKey,
      JSON.stringify([sessionToUpdate, unrelatedSession])
    );

    const { result } = renderHook(() => useMeetingSessions());

    act(() => {
      result.current.saveSession(
        sessionToUpdate.id,
        ' Updated meeting ',
        'Edited raw transcript',
        null,
        'design_review'
      );
    });

    const storedSessions = JSON.parse(
      localStorage.getItem(storageKey) || '[]'
    ) as SavedSession[];

    expect(storedSessions).toEqual([
      {
        ...sessionToUpdate,
        filename: 'Updated meeting',
        rawText: 'Edited raw transcript',
        cleanedText: '',
        meetingType: 'design_review',
      },
      unrelatedSession,
    ]);
  });

  it('persists a deletion while preserving other sessions', () => {
    const sessionToDelete = createSession({
      id: 'delete-1',
      sourceKey: 'delete-source',
    });
    const remainingSession = createSession({
      id: 'keep-1',
      sourceKey: 'keep-source',
    });

    localStorage.setItem(
      storageKey,
      JSON.stringify([sessionToDelete, remainingSession])
    );

    const { result } = renderHook(() => useMeetingSessions());

    act(() => {
      result.current.deleteSession(sessionToDelete.id);
    });

    expect(JSON.parse(localStorage.getItem(storageKey) || '[]')).toEqual([
      remainingSession,
    ]);
  });

  it('restores sessions after a fresh mount', () => {
    const sessions = [
      createSession({ id: 'remount-1', sourceKey: 'remount-source-1' }),
      createSession({ id: 'remount-2', sourceKey: 'remount-source-2' }),
    ];
    localStorage.setItem(storageKey, JSON.stringify(sessions));

    const firstMount = renderHook(() => useMeetingSessions());

    expect(firstMount.result.current.savedSessions).toEqual(sessions);

    firstMount.unmount();

    const secondMount = renderHook(() => useMeetingSessions());

    expect(secondMount.result.current.savedSessions).toEqual(sessions);
  });

  it('recovers safely from malformed stored JSON', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    localStorage.setItem(storageKey, '{invalid JSON');

    expect(() => {
      const { result } = renderHook(() => useMeetingSessions());

      expect(result.current.savedSessions).toEqual([]);
    }).not.toThrow();
  });

  it('normalizes incomplete stored sessions using the existing defaults', () => {
    localStorage.setItem(storageKey, JSON.stringify([{ id: 'incomplete-1' }]));

    const { result } = renderHook(() => useMeetingSessions());
    const restoredSession = result.current.savedSessions[0];

    expect(restoredSession).toMatchObject({
      id: 'incomplete-1',
      sourceKey: 'incomplete-1',
      filename: 'Untitled session',
      meetingType: 'general',
      rawText: '',
      cleanedText: '',
    });
    expect(restoredSession?.createdAt).toEqual(expect.any(String));
    expect(JSON.parse(localStorage.getItem(storageKey) || '[]')).toEqual(
      result.current.savedSessions
    );
  });

  it('falls back to an empty session list when a stored entry is invalid', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const validSession = createSession();
    localStorage.setItem(storageKey, JSON.stringify([validSession, null]));

    const { result } = renderHook(() => useMeetingSessions());

    expect(result.current.savedSessions).toEqual([]);
    expect(JSON.parse(localStorage.getItem(storageKey) || '[]')).toEqual([]);
  });

  it('openSavedSession returns null when recording or processing', () => {
    const { result } = renderHook(() => useMeetingSessions());

    const session = {
      id: 'open-1',
      sourceKey: 'open-key',
      filename: 'To open',
      createdAt: new Date().toISOString(),
      meetingType: 'general' as const,
      rawText: 'Raw',
      cleanedText: 'Cleaned',
    };

    const opened = result.current.openSavedSession(session, true, false);

    expect(opened).toBeNull();
  });

  it('openSavedSession returns session data when not recording or processing', () => {
    const { result } = renderHook(() => useMeetingSessions());

    const session = {
      id: 'open-1',
      sourceKey: 'open-key',
      filename: 'recording.webm',
      createdAt: new Date().toISOString(),
      meetingType: 'design_review' as const,
      rawText: 'Raw transcript',
      cleanedText: 'Cleaned transcript',
    };

    const opened = result.current.openSavedSession(session, false, false);

    expect(opened).not.toBeNull();
    expect(opened?.meetingType).toBe('design_review');
    expect(opened?.sessionInputType).toBe('recording');
  });
});
