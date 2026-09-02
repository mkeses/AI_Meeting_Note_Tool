import { useCallback, useEffect, useRef, useState } from 'react';
import { getBackendApiUrl } from '../config';

export type MeetingType =
  | 'general'
  | 'design_review'
  | 'debug_sync'
  | 'standup';

export type MeetingSourceType = 'recording' | 'audio-file' | 'text';

export type SavedSession = {
  id: string;
  sourceKey: string;
  filename: string;
  createdAt: string;
  updatedAt: string;
  meetingType: MeetingType;
  rawText: string;
  cleanedText: string;
  sourceType: MeetingSourceType;
  notes: string;
};

export type NewSavedSession = Omit<SavedSession, 'updatedAt'>;

type AddSessionResult = {
  activeSessionId: string;
  sessionExists: boolean;
};

type OpenedSession = {
  activeSessionId: string;
  rawText: string;
  editedRawText: string;
  cleanedText: string;
  meetingType: MeetingType;
  sessionFilename: string;
  sessionInputType: MeetingSourceType;
  sessionCreatedAt: string;
  notes: string;
};

type UseMeetingSessionsOptions = {
  enabled?: boolean;
  onUnauthenticated?: () => void;
};

class UnauthenticatedMeetingRequestError extends Error {
  constructor() {
    super('Your session has expired. Sign in to continue.');
  }
}

const meetingTypes: MeetingType[] = [
  'general',
  'design_review',
  'debug_sync',
  'standup',
];

const meetingSourceTypes: MeetingSourceType[] = [
  'recording',
  'audio-file',
  'text',
];

function isMeetingType(value: unknown): value is MeetingType {
  return (
    typeof value === 'string' && meetingTypes.includes(value as MeetingType)
  );
}

function isMeetingSourceType(value: unknown): value is MeetingSourceType {
  return (
    typeof value === 'string' &&
    meetingSourceTypes.includes(value as MeetingSourceType)
  );
}

function isSavedSession(value: unknown): value is SavedSession {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const session = value as Record<string, unknown>;

  return (
    typeof session.id === 'string' &&
    typeof session.sourceKey === 'string' &&
    typeof session.filename === 'string' &&
    typeof session.createdAt === 'string' &&
    typeof session.updatedAt === 'string' &&
    isMeetingType(session.meetingType) &&
    typeof session.rawText === 'string' &&
    typeof session.cleanedText === 'string' &&
    isMeetingSourceType(session.sourceType) &&
    typeof session.notes === 'string'
  );
}

function parseSavedSession(value: unknown): SavedSession {
  if (!isSavedSession(value)) {
    throw new Error('Meeting API returned invalid session data');
  }

  return value;
}

function parseSavedSessions(value: unknown): SavedSession[] {
  if (!Array.isArray(value)) {
    throw new Error('Meeting API returned an invalid session list');
  }

  return value.map(parseSavedSession);
}

async function fetchMeetingJson(
  url: string,
  init?: RequestInit,
  onUnauthenticated?: () => void
): Promise<unknown> {
  const response = await fetch(url, { ...init, credentials: 'include' });

  if (response.status === 401) {
    onUnauthenticated?.();
    throw new UnauthenticatedMeetingRequestError();
  }

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json() as Promise<unknown>;
}

function mergeLoadedSessions(
  loadedSessions: SavedSession[],
  currentSessions: SavedSession[]
): SavedSession[] {
  const currentById = new Map(
    currentSessions.map((session) => [session.id, session])
  );
  const loadedIds = new Set(loadedSessions.map((session) => session.id));

  return [
    ...loadedSessions.map((session) => currentById.get(session.id) ?? session),
    ...currentSessions.filter((session) => !loadedIds.has(session.id)),
  ];
}

function formatRequestError(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return `Failed to ${action}: ${message}`;
}

/**
 * Manages meeting-session CRUD through the backend persistence API.
 * Existing browser localStorage data is deliberately left untouched for a later
 * migration/import step.
 */
export function useMeetingSessions({
  enabled = true,
  onUnauthenticated,
}: UseMeetingSessionsOptions = {}) {
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const notesSaveRevisionRef = useRef(new Map<string, number>());

  useEffect(() => {
    let mounted = true;

    if (!enabled) {
      setSavedSessions([]);
      setError(null);
      setIsLoading(false);

      return () => {
        mounted = false;
      };
    }

    const loadSessions = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetchMeetingJson(
          getBackendApiUrl('/api/meetings'),
          undefined,
          onUnauthenticated
        );
        const loadedSessions = parseSavedSessions(response);

        if (mounted) {
          setSavedSessions((currentSessions) =>
            mergeLoadedSessions(loadedSessions, currentSessions)
          );
        }
      } catch (loadError) {
        console.error('Failed to load saved meetings:', loadError);

        if (mounted) {
          setError(formatRequestError('load saved meetings', loadError));
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    void loadSessions();

    return () => {
      mounted = false;
    };
  }, [enabled, onUnauthenticated]);

  const openSavedSession = useCallback(
    (
      session: SavedSession,
      isRecording: boolean,
      isProcessing: boolean
    ): OpenedSession | null => {
      if (isRecording || isProcessing) {
        return null;
      }

      return {
        activeSessionId: session.id,
        rawText: session.rawText,
        editedRawText: session.rawText,
        cleanedText: session.cleanedText,
        meetingType: session.meetingType,
        sessionFilename: session.filename,
        sessionInputType: session.sourceType,
        sessionCreatedAt: session.createdAt,
        notes: session.notes,
      };
    },
    []
  );

  const searchSessions = useCallback(
    async (query: string): Promise<SavedSession[] | null> => {
      if (!enabled) {
        return null;
      }

      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        return [];
      }

      try {
        const response = await fetchMeetingJson(
          getBackendApiUrl(
            `/api/meetings/search?q=${encodeURIComponent(normalizedQuery)}`
          ),
          undefined,
          onUnauthenticated
        );
        const sessions = parseSavedSessions(response);

        setError(null);
        return sessions;
      } catch (searchError) {
        console.error('Failed to search meetings:', searchError);
        setError(formatRequestError('search meetings', searchError));
        return null;
      }
    },
    [enabled, onUnauthenticated]
  );

  const saveSession = useCallback(
    async (
      activeSessionId: string | null,
      sessionFilename: string | null,
      editedRawText: string,
      cleanedText: string | null,
      meetingType: MeetingType
    ): Promise<string | null> => {
      if (!enabled || !activeSessionId) {
        return null;
      }

      const safeCleanedText = cleanedText ?? '';
      const safeFilename = sessionFilename?.trim() || 'Untitled session';
      const currentSession = savedSessions.find(
        (session) => session.id === activeSessionId
      );
      const changes: Record<string, string> = {};

      if (!currentSession || currentSession.filename !== safeFilename) {
        changes.filename = safeFilename;
      }

      if (!currentSession || currentSession.rawText !== editedRawText) {
        changes.rawText = editedRawText;
      }

      if (!currentSession || currentSession.cleanedText !== safeCleanedText) {
        changes.cleanedText = safeCleanedText;
      }

      if (!currentSession || currentSession.meetingType !== meetingType) {
        changes.meetingType = meetingType;
      }

      if (Object.keys(changes).length === 0) {
        return activeSessionId;
      }

      try {
        const response = await fetchMeetingJson(
          getBackendApiUrl(
            `/api/meetings/${encodeURIComponent(activeSessionId)}`
          ),
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(changes),
          },
          onUnauthenticated
        );
        const updatedSession = parseSavedSession(response);

        setSavedSessions((currentSessions) =>
          currentSessions.map((session) =>
            session.id === updatedSession.id
              ? { ...updatedSession, notes: session.notes }
              : session
          )
        );
        setError(null);
        return updatedSession.id;
      } catch (saveError) {
        console.error('Failed to save session:', saveError);
        setError(formatRequestError('save meeting', saveError));
        return null;
      }
    },
    [enabled, onUnauthenticated, savedSessions]
  );

  const saveNotes = useCallback(
    async (
      activeSessionId: string | null,
      notes: string
    ): Promise<SavedSession | null> => {
      if (!enabled || !activeSessionId) {
        return null;
      }

      const nextRevision =
        (notesSaveRevisionRef.current.get(activeSessionId) ?? 0) + 1;
      notesSaveRevisionRef.current.set(activeSessionId, nextRevision);

      try {
        const response = await fetchMeetingJson(
          getBackendApiUrl(
            `/api/meetings/${encodeURIComponent(activeSessionId)}`
          ),
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ notes }),
          },
          onUnauthenticated
        );
        const updatedSession = parseSavedSession(response);

        if (
          notesSaveRevisionRef.current.get(activeSessionId) === nextRevision
        ) {
          setSavedSessions((currentSessions) =>
            currentSessions.map((session) =>
              session.id === updatedSession.id ? updatedSession : session
            )
          );
          setError(null);
        }
        return updatedSession;
      } catch (saveError) {
        console.error('Failed to save notes:', saveError);

        if (
          notesSaveRevisionRef.current.get(activeSessionId) === nextRevision
        ) {
          setError(formatRequestError('save notes', saveError));
        }
        return null;
      }
    },
    [enabled, onUnauthenticated]
  );

  const addSession = useCallback(
    async (newSession: NewSavedSession): Promise<AddSessionResult | null> => {
      if (!enabled) {
        return null;
      }

      const existingSession = savedSessions.find(
        (session) => session.sourceKey === newSession.sourceKey
      );

      try {
        if (existingSession) {
          const response = await fetchMeetingJson(
            getBackendApiUrl(
              `/api/meetings/${encodeURIComponent(existingSession.id)}`
            ),
            {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                filename: newSession.filename,
                meetingType: newSession.meetingType,
                rawText: newSession.rawText,
                cleanedText: newSession.cleanedText,
                sourceType: newSession.sourceType,
                notes: newSession.notes,
              }),
            },
            onUnauthenticated
          );
          const updatedSession = parseSavedSession(response);

          setSavedSessions((currentSessions) =>
            currentSessions.map((session) =>
              session.id === updatedSession.id ? updatedSession : session
            )
          );
          setError(null);
          return {
            activeSessionId: updatedSession.id,
            sessionExists: true,
          };
        }

        const response = await fetchMeetingJson(
          getBackendApiUrl('/api/meetings'),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(newSession),
          },
          onUnauthenticated
        );
        const createdSession = parseSavedSession(response);

        setSavedSessions((currentSessions) => [
          createdSession,
          ...currentSessions,
        ]);
        setError(null);
        return {
          activeSessionId: createdSession.id,
          sessionExists: false,
        };
      } catch (addError) {
        console.error('Failed to save session:', addError);
        setError(formatRequestError('save meeting', addError));
        return null;
      }
    },
    [enabled, onUnauthenticated, savedSessions]
  );

  const deleteSession = useCallback(
    async (
      sessionId: string
    ): Promise<{
      wasActive: boolean;
      activeSessionId: string | null;
    } | null> => {
      if (!enabled) {
        return null;
      }

      try {
        const response = await fetch(
          getBackendApiUrl(`/api/meetings/${encodeURIComponent(sessionId)}`),
          {
            method: 'DELETE',
            credentials: 'include',
          }
        );

        if (response.status === 401) {
          onUnauthenticated?.();
          throw new UnauthenticatedMeetingRequestError();
        }

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        setSavedSessions((currentSessions) =>
          currentSessions.filter((session) => session.id !== sessionId)
        );
        setError(null);
        return { wasActive: false, activeSessionId: null };
      } catch (deleteError) {
        console.error('Failed to delete session:', deleteError);
        setError(formatRequestError('delete meeting', deleteError));
        return null;
      }
    },
    [enabled, onUnauthenticated]
  );

  return {
    savedSessions,
    isLoading,
    error,
    openSavedSession,
    searchSessions,
    saveSession,
    saveNotes,
    addSession,
    deleteSession,
  };
}
