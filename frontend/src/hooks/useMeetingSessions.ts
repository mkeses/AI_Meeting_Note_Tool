import { useCallback, useEffect, useState } from 'react';

type MeetingType = 'general' | 'design_review' | 'debug_sync' | 'standup';

export type SavedSession = {
  id: string;
  sourceKey: string;
  filename: string;
  createdAt: string;
  meetingType: MeetingType;
  rawText: string;
  cleanedText: string;
};

/**
 * Manages meeting session CRUD operations.
 * Currently uses localStorage; designed to be swapped for a backend API later.
 */
export function useMeetingSessions() {
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>(() => {
    try {
      const storedSessions = localStorage.getItem('meeting-sessions');

      if (!storedSessions) {
        return [];
      }

      const parsedSessions = JSON.parse(
        storedSessions
      ) as Partial<SavedSession>[];

      return parsedSessions.map((session) => ({
        id: session.id || crypto.randomUUID(),
        sourceKey: session.sourceKey || session.id || crypto.randomUUID(),
        filename: session.filename || 'Untitled session',
        createdAt: session.createdAt || new Date().toISOString(),
        meetingType: session.meetingType || 'general',
        rawText: session.rawText || '',
        cleanedText: session.cleanedText || '',
      }));
    } catch (error) {
      console.error('Failed to load saved sessions:', error);
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('meeting-sessions', JSON.stringify(savedSessions));
    } catch (error) {
      console.error('Failed to save sessions:', error);
    }
  }, [savedSessions]);

  const openSavedSession = useCallback(
    (
      session: SavedSession,
      isRecording: boolean,
      isProcessing: boolean
    ): {
      activeSessionId: string;
      rawText: string;
      editedRawText: string;
      cleanedText: string;
      meetingType: MeetingType;
      sessionFilename: string;
      sessionInputType: 'recording' | 'audio-file' | 'text';
    } | null => {
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
        sessionInputType:
          session.filename === 'Pasted transcript'
            ? 'text'
            : session.filename === 'recording.webm'
              ? 'recording'
              : 'audio-file',
      };
    },
    []
  );

  const saveSession = useCallback(
    (
      activeSessionId: string | null,
      sessionFilename: string | null,
      editedRawText: string,
      cleanedText: string | null,
      meetingType: MeetingType
    ) => {
      if (!activeSessionId) {
        return null;
      }

      const safeCleanedText = cleanedText ?? '';
      const safeFilename = sessionFilename?.trim() || 'Untitled session';

      let savedId: string | null = null;

      setSavedSessions((currentSessions) =>
        currentSessions.map((session) => {
          if (session.id === activeSessionId) {
            savedId = session.id;
            return {
              ...session,
              filename: safeFilename,
              rawText: editedRawText,
              cleanedText: safeCleanedText,
              meetingType,
            };
          }
          return session;
        })
      );

      return savedId;
    },
    []
  );

  const addSession = useCallback(
    (
      newSession: SavedSession
    ): { activeSessionId: string; sessionExists: boolean } => {
      let sessionExists = false;
      let activeId = newSession.id;

      setSavedSessions((currentSessions) => {
        const existingSession = currentSessions.find(
          (session) => session.sourceKey === newSession.sourceKey
        );

        if (existingSession) {
          sessionExists = true;
          activeId = existingSession.id;
          return currentSessions.map((session) =>
            session.id === existingSession.id
              ? {
                  ...session,
                  filename: newSession.filename,
                  createdAt: newSession.createdAt,
                  meetingType: newSession.meetingType,
                  rawText: newSession.rawText,
                  cleanedText: newSession.cleanedText,
                }
              : session
          );
        }

        return [newSession, ...currentSessions];
      });

      return { activeSessionId: activeId, sessionExists };
    },
    []
  );

  const deleteSession = useCallback(
    (
      sessionId: string
    ): { wasActive: boolean; activeSessionId: string | null } => {
      const wasActive = false;

      setSavedSessions((currentSessions) =>
        currentSessions.filter((session) => session.id !== sessionId)
      );

      return { wasActive, activeSessionId: null };
    },
    []
  );

  return {
    savedSessions,
    openSavedSession,
    saveSession,
    addSession,
    deleteSession,
  };
}
