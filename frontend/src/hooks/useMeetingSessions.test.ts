import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMeetingSessions } from './useMeetingSessions';

describe('useMeetingSessions', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
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
