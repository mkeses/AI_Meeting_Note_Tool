import {
  useCallback,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
} from 'react';

import styles from './App.module.css';
import { ErrorMessage } from './components/ErrorMessage';
import { RecordButton } from './components/RecordButton';
import { TextInputZone } from './components/TextInputZone';
import { TranscriptionResults } from './components/TranscriptionResults';
import { UploadZone } from './components/UploadZone';
import liveStyles from './liveTranscript.module.css';
import { SettingsPanel } from './components/SettingsPanel';
import { useTranscriptCleanup } from './hooks/useTranscriptCleanup';
import { useMeetingSessions } from './hooks/useMeetingSessions';
import { useAudioCapture } from './hooks/useAudioCapture';
import { useLiveTranscript } from './hooks/useLiveTranscript.ts';
import type {
  MeetingSourceType,
  NewSavedSession,
  SavedSession,
} from './hooks/useMeetingSessions';
import { usePushToTalk } from './hooks/usePushToTalk';

interface TranscriptionResponse {
  success: boolean;
  text?: string;
  error?: string;
}

type MeetingType = 'general' | 'design_review' | 'debug_sync' | 'standup';
type SessionInputType = MeetingSourceType | null;

type RecordingMeeting = {
  id: string;
  sourceKey: string;
  createdAt: string;
  creationPromise: Promise<string | null>;
  finalizationStarted: boolean;
  cleanupStarted: boolean;
};

interface MeetingOption {
  value: MeetingType;
  label: string;
  description: string;
  sections: string;
}

const MEETING_OPTIONS: MeetingOption[] = [
  {
    value: 'general',
    label: 'General',
    description:
      'A balanced recap of discussion, decisions, action items, and questions.',
    sections: 'Summary · Decisions · Action items · Open questions',
  },
  {
    value: 'design_review',
    label: 'Design review',
    description:
      'Focuses on architecture, implementation choices, tradeoffs, risks, and constraints.',
    sections: 'Design · Decisions · Tradeoffs · Risks · Action items',
  },
  {
    value: 'debug_sync',
    label: 'Debug sync',
    description:
      'Organizes the investigation, evidence, suspected causes, blockers, and next steps.',
    sections: 'Problem · Evidence · Causes · Blockers · Next steps',
  },
  {
    value: 'standup',
    label: 'Standup',
    description:
      'Keeps the recap brief and operational, emphasizing progress and blockers.',
    sections: 'Progress · Priorities · Blockers · Action items',
  },
];

const NOTES_AUTOSAVE_DELAY_MS = 500;

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, '0'))
    .join(':');
}

function formatSessionDate(createdAt: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(createdAt));
}

function App() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [rawText, setRawText] = useState<string | null>(null);
  const [editedRawText, setEditedRawText] = useState('');
  const [cleanedText, setCleanedText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useLLM, setUseLLM] = useState(true);
  const [includeMicrophone, setIncludeMicrophone] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [meetingType, setMeetingType] = useState<MeetingType>('general');
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [sessionFilename, setSessionFilename] = useState<string | null>(null);
  const [sessionInputType, setSessionInputType] =
    useState<SessionInputType>(null);
  const [sessionCreatedAt, setSessionCreatedAt] = useState<string | null>(null);
  const [sessionNotes, setSessionNotes] = useState('');
  const [notesSaveStatus, setNotesSaveStatus] = useState<string | null>(null);
  const [meetingSearchQuery, setMeetingSearchQuery] = useState('');
  const [activeMeetingSearchQuery, setActiveMeetingSearchQuery] = useState<
    string | null
  >(null);
  const [searchResults, setSearchResults] = useState<SavedSession[] | null>(
    null
  );
  const [isSearchingMeetings, setIsSearchingMeetings] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const recordingSourceKeyRef = useRef<string | null>(null);
  const recordingMeetingRef = useRef<RecordingMeeting | null>(null);
  const sessionNotesRef = useRef('');
  const notesAutosaveTimerRef = useRef<number | null>(null);
  const notesSaveSequenceRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const liveTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const savedSelectionRef = useRef({ start: 0, end: 0 });

  const cleanup = useTranscriptCleanup({ useLLM, meetingType });

  const {
    systemPrompt,
    defaultSystemPrompt,
    isLoadingPrompt,
    isCleaningWithLLM,
    error: cleanupError,
    setSystemPrompt,
    setIsCleaningWithLLM,
    cleanTranscription,
    regenerateCleanup,
  } = cleanup;

  const audioCapture = useAudioCapture({
    includeMicrophone,
    onError: setError,
    onRecordingStateChange: () => {},
    onProcessingStateChange: setIsProcessing,
    onRecordingSecondsChange: setRecordingSeconds,
  });

  const {
    isRecording: audioIsRecording,
    startRecording: audioStartRecording,
    stopRecording: audioStopRecording,
  } = audioCapture;

  const sessions = useMeetingSessions();

  const {
    savedSessions,
    isLoading: areSessionsLoading,
    error: sessionError,
    openSavedSession,
    searchSessions,
    saveSession,
    saveNotes,
    addSession,
    deleteSession,
  } = sessions;

  useEffect(() => {
    if (sessionError) {
      setError(sessionError);
    }
  }, [sessionError]);

  useEffect(() => {
    sessionNotesRef.current = sessionNotes;
  }, [sessionNotes]);

  useEffect(() => {
    notesSaveSequenceRef.current += 1;
    setNotesSaveStatus(null);
  }, [activeSessionId]);

  useEffect(() => {
    if (
      !audioIsRecording ||
      sessionInputType !== 'recording' ||
      !recordingSourceKeyRef.current
    ) {
      return;
    }

    const sourceKey = recordingSourceKeyRef.current;
    const existingMeeting = recordingMeetingRef.current;

    if (existingMeeting?.sourceKey === sourceKey) {
      return;
    }

    const recordingMeeting: RecordingMeeting = {
      id: crypto.randomUUID(),
      sourceKey,
      createdAt: new Date().toISOString(),
      creationPromise: Promise.resolve(null),
      finalizationStarted: false,
      cleanupStarted: false,
    };

    recordingMeetingRef.current = recordingMeeting;
    recordingMeeting.creationPromise = addSession({
      id: recordingMeeting.id,
      sourceKey: recordingMeeting.sourceKey,
      filename: 'recording.webm',
      createdAt: recordingMeeting.createdAt,
      meetingType,
      rawText: '',
      cleanedText: '',
      sourceType: 'recording',
      notes: '',
    }).then((result) => result?.activeSessionId ?? null);

    void recordingMeeting.creationPromise.then((createdSessionId) => {
      if (
        createdSessionId &&
        recordingMeetingRef.current === recordingMeeting
      ) {
        setActiveSessionId(createdSessionId);
        setSessionCreatedAt(recordingMeeting.createdAt);
      }
    });
  }, [addSession, audioIsRecording, meetingType, sessionInputType]);

  useEffect(() => {
    const recordingMeeting = recordingMeetingRef.current;

    if (
      !recordingMeeting ||
      audioIsRecording ||
      isProcessing ||
      recordingMeeting.finalizationStarted ||
      recordingMeeting.cleanupStarted ||
      sessionNotesRef.current.trim()
    ) {
      return;
    }

    recordingMeeting.cleanupStarted = true;

    void recordingMeeting.creationPromise.then(async (createdSessionId) => {
      if (
        !createdSessionId ||
        recordingMeetingRef.current !== recordingMeeting ||
        recordingMeeting.finalizationStarted ||
        sessionNotesRef.current.trim()
      ) {
        return;
      }

      const deletedSession = await deleteSession(createdSessionId);

      if (deletedSession && recordingMeetingRef.current === recordingMeeting) {
        recordingMeetingRef.current = null;
        setActiveSessionId((currentSessionId) =>
          currentSessionId === createdSessionId ? null : currentSessionId
        );
        setSessionCreatedAt(null);
      }
    });
  }, [audioIsRecording, deleteSession, isProcessing]);

  const activeSavedSession = activeSessionId
    ? savedSessions.find((session) => session.id === activeSessionId)
    : null;

  useEffect(() => {
    if (
      !activeSessionId ||
      !activeSavedSession ||
      activeSavedSession.notes === sessionNotes
    ) {
      return;
    }

    const notesToSave = sessionNotes;
    const saveSequence = notesSaveSequenceRef.current + 1;
    notesSaveSequenceRef.current = saveSequence;

    notesAutosaveTimerRef.current = window.setTimeout(() => {
      notesAutosaveTimerRef.current = null;
      setNotesSaveStatus('Saving…');

      void saveNotes(activeSessionId, notesToSave).then((savedSession) => {
        if (notesSaveSequenceRef.current !== saveSequence) {
          return;
        }

        setNotesSaveStatus(savedSession ? 'Saved' : null);
      });
    }, NOTES_AUTOSAVE_DELAY_MS);

    return () => {
      if (notesAutosaveTimerRef.current !== null) {
        window.clearTimeout(notesAutosaveTimerRef.current);
        notesAutosaveTimerRef.current = null;
      }
    };
  }, [activeSavedSession, activeSessionId, saveNotes, sessionNotes]);

  const searchSavedMeetings = useCallback(
    async (query: string) => {
      const normalizedQuery = query.trim();

      if (!normalizedQuery) {
        setActiveMeetingSearchQuery(null);
        setSearchResults(null);
        return;
      }

      setIsSearchingMeetings(true);
      setActiveMeetingSearchQuery(normalizedQuery);
      const results = await searchSessions(normalizedQuery);
      setSearchResults(results ?? []);
      setIsSearchingMeetings(false);
    },
    [searchSessions]
  );

  const processFinalTranscript = useCallback(
    async (transcript: string, filename: string) => {
      const finalText = transcript.trim();

      if (!finalText) {
        setError('The transcription was empty.');
        setIsProcessing(false);
        return;
      }

      setRawText(finalText);
      setEditedRawText(finalText);

      const cleaned = await cleanTranscription(finalText);

      const sourceType: Exclude<SessionInputType, null> =
        filename === 'recording.webm' ? 'recording' : 'audio-file';
      const recordingMeeting =
        sourceType === 'recording' &&
        recordingMeetingRef.current?.sourceKey === recordingSourceKeyRef.current
          ? recordingMeetingRef.current
          : null;
      let savedSessionId: string | null = null;
      let createdAt = new Date().toISOString();

      if (recordingMeeting) {
        recordingMeeting.finalizationStarted = true;
        const createdSessionId = await recordingMeeting.creationPromise;

        if (createdSessionId) {
          savedSessionId = await saveSession(
            createdSessionId,
            filename,
            finalText,
            cleaned,
            meetingType
          );
          createdAt = recordingMeeting.createdAt;
        }
      } else {
        const newSession: NewSavedSession = {
          id: crypto.randomUUID(),
          sourceKey:
            filename === 'recording.webm'
              ? recordingSourceKeyRef.current ||
                `recording:${crypto.randomUUID()}`
              : `audio-file:${filename}`,
          filename,
          createdAt,
          meetingType,
          rawText: finalText,
          cleanedText: cleaned,
          sourceType,
          notes: sessionNotes,
        };
        const savedSession = await addSession(newSession);
        savedSessionId = savedSession?.activeSessionId ?? null;
      }

      if (savedSessionId) {
        setActiveSessionId(savedSessionId);

        if (activeMeetingSearchQuery) {
          await searchSavedMeetings(activeMeetingSearchQuery);
        }
      } else if (!recordingMeeting) {
        setActiveSessionId(null);
      }

      setSessionFilename(filename);
      setSessionInputType(sourceType);
      setSessionCreatedAt(createdAt);

      setCleanedText(cleaned);
    },
    [
      activeMeetingSearchQuery,
      addSession,
      cleanTranscription,
      meetingType,
      saveSession,
      searchSavedMeetings,
      sessionNotes,
    ]
  );

  const liveTranscript = useLiveTranscript({
    processFinalTranscript,
    onError: setError,
    onProcessingStateChange: setIsProcessing,
  });

  const {
    liveCommittedText,
    livePartialText,
    isLiveTranscriptEdited,
    liveSocketRef,
    handleSocketMessage,
    handleLiveTranscriptChange,
    resetLiveTranscriptState,
  } = liveTranscript;

  // Wrap handleLiveTranscriptChange to save cursor position before update
  const rememberTextareaSelection = useCallback(() => {
    const textarea = liveTextareaRef.current;

    if (!textarea) {
      return;
    }

    savedSelectionRef.current = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };
  }, []);

  const handleTextareaChange = (
    event: React.ChangeEvent<HTMLTextAreaElement>
  ) => {
    // Save the post-edit caret/selection before React updates the controlled value.
    rememberTextareaSelection();
    handleLiveTranscriptChange(event);
  };

  useLayoutEffect(() => {
    const textarea = liveTextareaRef.current;

    if (!textarea) {
      return;
    }

    // Don't interfere with the textarea when the user isn't actively editing it.
    if (document.activeElement !== textarea) {
      return;
    }

    const maxPosition = textarea.value.length;

    const start = Math.min(savedSelectionRef.current.start, maxPosition);
    const end = Math.min(savedSelectionRef.current.end, maxPosition);

    textarea.setSelectionRange(start, end);
  }, [liveCommittedText]);

  const beginRecording = useCallback(async () => {
    recordingMeetingRef.current = null;
    setActiveSessionId(null);
    setSessionCreatedAt(null);
    setSessionNotes('');
    setNotesSaveStatus(null);
    await audioStartRecording(
      liveSocketRef,
      resetLiveTranscriptState,
      setSessionFilename,
      setSessionInputType,
      recordingSourceKeyRef,
      handleSocketMessage
    );
  }, [
    audioStartRecording,
    liveSocketRef,
    resetLiveTranscriptState,
    handleSocketMessage,
  ]);

  // Push-to-talk keyboard shortcuts
  usePushToTalk({
    isRecording: audioIsRecording,
    isProcessing,
    startRecording: beginRecording,
    stopRecording: () => audioStopRecording(liveSocketRef),
  });

  useEffect(() => {
    if (!audioIsRecording) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRecordingSeconds((seconds) => seconds + 1);
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [audioIsRecording]);

  const saveChanges = useCallback(async () => {
    const savedId = await saveSession(
      activeSessionId,
      sessionFilename,
      editedRawText,
      cleanedText,
      meetingType
    );

    if (savedId) {
      setSaveMessage('Saved');
      window.setTimeout(() => {
        setSaveMessage(null);
      }, 2000);

      if (activeMeetingSearchQuery) {
        await searchSavedMeetings(activeMeetingSearchQuery);
      }
    }
  }, [
    activeSessionId,
    activeMeetingSearchQuery,
    sessionFilename,
    editedRawText,
    cleanedText,
    meetingType,
    saveSession,
    searchSavedMeetings,
  ]);

  const clearMeetingSearch = useCallback(() => {
    setMeetingSearchQuery('');
    setActiveMeetingSearchQuery(null);
    setSearchResults(null);
    setIsSearchingMeetings(false);
  }, []);

  const deleteSavedSession = useCallback(
    async (sessionId: string) => {
      const deletedSession = await deleteSession(sessionId);
      if (!deletedSession) {
        return;
      }

      setSearchResults((currentResults) =>
        currentResults
          ? currentResults.filter((session) => session.id !== sessionId)
          : null
      );

      const { wasActive } = deletedSession;

      if (wasActive || activeSessionId === sessionId) {
        setActiveSessionId(null);
        setRawText(null);
        setEditedRawText('');
        setCleanedText(null);
        setSessionFilename(null);
        setSessionInputType(null);
        setSessionCreatedAt(null);
        setSessionNotes('');
        setNotesSaveStatus(null);
        resetLiveTranscriptState();
        setError(null);
        setIsCopied(false);
        setIsCleaningWithLLM(false);
        setRecordingSeconds(0);
      }
    },
    [
      activeSessionId,
      deleteSession,
      resetLiveTranscriptState,
      setIsCleaningWithLLM,
    ]
  );

  const uploadAudio = useCallback(
    async (audioBlob: Blob, filename = 'recording.webm') => {
      setIsProcessing(true);
      setError(null);

      const formData = new FormData();
      formData.append('audio', audioBlob, filename);

      try {
        const response = await fetch('/api/transcribe', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          throw new Error(
            `Transcription failed with status ${response.status}`
          );
        }

        const data = (await response.json()) as TranscriptionResponse;
        await processFinalTranscript(data.text || '', filename);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('Audio processing failed:', err);
        setError(`Processing failed: ${message}`);
        setIsCleaningWithLLM(false);
      } finally {
        setIsProcessing(false);
      }
    },
    [processFinalTranscript, setIsCleaningWithLLM]
  );

  const startRecording = beginRecording;

  const stopRecording = useCallback(() => {
    audioStopRecording(liveSocketRef);
  }, [audioStopRecording, liveSocketRef]);

  const processAudioFile = useCallback(
    (file: File) => {
      if (!file || !file.type.startsWith('audio/')) {
        setError('Please select a valid audio file.');
        return;
      }

      setError(null);
      setRawText(null);
      setEditedRawText('');
      setCleanedText(null);
      setSessionCreatedAt(null);
      setSessionNotes('');
      setNotesSaveStatus(null);
      setIsCleaningWithLLM(false);
      setRecordingSeconds(0);
      setSessionFilename(file.name);
      setSessionInputType('audio-file');
      resetLiveTranscriptState();

      void uploadAudio(new Blob([file], { type: file.type }), file.name);
    },
    [resetLiveTranscriptState, setIsCleaningWithLLM, uploadAudio]
  );

  const handleDragEnter = useCallback(() => setIsDragging(true), []);
  const handleDragLeave = useCallback(() => setIsDragging(false), []);

  const handleDrop = useCallback(
    (file: File) => {
      setIsDragging(false);

      if (!isProcessing && !audioIsRecording) {
        processAudioFile(file);
      }
    },
    [isProcessing, audioIsRecording, processAudioFile]
  );

  const handleFileSelect = useCallback(
    (file: File) => {
      if (isProcessing || audioIsRecording) {
        return;
      }

      processAudioFile(file);

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [isProcessing, audioIsRecording, processAudioFile]
  );

  const handleTextSubmit = useCallback(
    async (text: string) => {
      if (!text.trim() || isProcessing || audioIsRecording) {
        return;
      }

      setError(null);
      setRawText(text);
      setEditedRawText(text);
      setCleanedText(null);
      setSessionCreatedAt(null);
      setSessionNotes('');
      setNotesSaveStatus(null);
      setIsCleaningWithLLM(false);
      setIsProcessing(true);
      setRecordingSeconds(0);
      setSessionFilename('Pasted transcript');
      setSessionInputType('text');

      try {
        await cleanTranscription(text);
      } finally {
        setIsProcessing(false);
      }
    },
    [isProcessing, audioIsRecording, setIsCleaningWithLLM, cleanTranscription]
  );

  const copyToClipboard = useCallback((text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setIsCopied(true);
        window.setTimeout(() => setIsCopied(false), 2000);
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Unknown clipboard error';
        setError(`Copy failed: ${message}`);
      });
  }, []);

  const selectedMeeting =
    MEETING_OPTIONS.find((option) => option.value === meetingType) ??
    MEETING_OPTIONS.find((option) => option.value === 'general')!;
  const isMeetingSearchActive = activeMeetingSearchQuery !== null;
  const displayedSessions = isMeetingSearchActive
    ? (searchResults ?? [])
    : savedSessions.slice(0, 5);

  const statusText = audioIsRecording
    ? 'Recording'
    : isProcessing || isCleaningWithLLM
      ? 'Processing'
      : 'Ready to record';

  const handleNewSession = () => {
    if (audioIsRecording || isProcessing) {
      return;
    }

    setActiveSessionId(null);
    setRawText(null);
    setEditedRawText('');
    setCleanedText(null);
    setSessionCreatedAt(null);
    setSessionNotes('');
    setNotesSaveStatus(null);
    resetLiveTranscriptState();
    setError(null);
    setIsCopied(false);
    setIsCleaningWithLLM(false);
    setRecordingSeconds(0);
    setSessionFilename(null);
    setSessionInputType(null);
  };

  return (
    <div className={styles.app}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <div className={styles.brandArea}>
            <div className={styles.brandMark} aria-hidden="true">
              〽
            </div>

            <div>
              <div className={styles.brandName}>Signal Notes</div>
              <div className={styles.brandSubtitle}>
                Engineering conversations, organized.
              </div>
            </div>
          </div>

          <div className={styles.headerStatus}>
            <div className={styles.statusPill}>
              <span className={styles.statusDot} />
              {statusText}
            </div>
            <button
              className={styles.settingsButton}
              type="button"
              onClick={() => setIsSettingsOpen((open) => !open)}
            >
              Settings
            </button>
          </div>
        </header>

        <div className={styles.dashboard}>
          {isSettingsOpen && (
            <div className={styles.settingsPanelRow}>
              <SettingsPanel
                useLLM={useLLM}
                systemPrompt={systemPrompt}
                isLoadingPrompt={isLoadingPrompt}
                onToggleLLM={setUseLLM}
                onPromptChange={setSystemPrompt}
              />
            </div>
          )}

          <aside className={styles.sidebar} aria-label="Workspace navigation">
            <button
              className={styles.newSessionButton}
              type="button"
              onClick={handleNewSession}
              disabled={audioIsRecording || isProcessing}
            >
              <span aria-hidden="true">+</span>
              New session
            </button>

            <nav className={styles.navGroup} aria-label="Workspace">
              <div className={styles.navLabel}>Workspace</div>
              <button
                className={`${styles.navItem} ${styles.navItemActive}`}
                type="button"
              >
                Capture
              </button>
              <button className={styles.navItem} type="button">
                Current transcript
              </button>
            </nav>

            <nav className={styles.navGroup} aria-label="Library">
              <div className={styles.navLabel}>Library</div>
              <button className={styles.navItem} type="button">
                Recent sessions
              </button>
              <form
                className={styles.meetingSearch}
                onSubmit={(event) => {
                  event.preventDefault();
                  void searchSavedMeetings(meetingSearchQuery);
                }}
              >
                <input
                  className={styles.meetingSearchInput}
                  value={meetingSearchQuery}
                  onChange={(event) => {
                    const nextQuery = event.target.value;
                    setMeetingSearchQuery(nextQuery);

                    if (!nextQuery.trim()) {
                      setActiveMeetingSearchQuery(null);
                      setSearchResults(null);
                      setIsSearchingMeetings(false);
                    }
                  }}
                  placeholder="Search meetings"
                  aria-label="Search saved meetings"
                />
                <button
                  className={styles.meetingSearchButton}
                  type="submit"
                  disabled={isSearchingMeetings || !meetingSearchQuery.trim()}
                >
                  Search
                </button>
                {isMeetingSearchActive && (
                  <button
                    className={styles.meetingSearchClearButton}
                    type="button"
                    onClick={clearMeetingSearch}
                  >
                    Clear search
                  </button>
                )}
              </form>
              <div className={styles.recentSessionsList}>
                {areSessionsLoading ? (
                  <div className={styles.emptyRecentSessions}>
                    Loading saved sessions...
                  </div>
                ) : isSearchingMeetings ? (
                  <div className={styles.emptyRecentSessions}>
                    Searching saved meetings...
                  </div>
                ) : displayedSessions.length === 0 ? (
                  <div className={styles.emptyRecentSessions}>
                    {isMeetingSearchActive
                      ? `No saved meetings match “${activeMeetingSearchQuery}”.`
                      : 'No saved sessions yet.'}
                  </div>
                ) : (
                  displayedSessions.map((session) => (
                    <div className={styles.recentSessionItem} key={session.id}>
                      <button
                        className={`${styles.recentSessionOpenButton} ${
                          activeSessionId === session.id
                            ? styles.recentSessionOpenButtonActive
                            : ''
                        }`}
                        type="button"
                        onClick={() => {
                          const result = openSavedSession(
                            session,
                            audioIsRecording,
                            isProcessing
                          );
                          if (!result) return;

                          const {
                            activeSessionId: newActiveId,
                            rawText,
                            editedRawText,
                            cleanedText,
                            meetingType,
                            sessionFilename,
                            sessionInputType,
                            sessionCreatedAt,
                            notes,
                          } = result;

                          setActiveSessionId(newActiveId);
                          setRawText(rawText);
                          setEditedRawText(editedRawText);
                          setCleanedText(cleanedText);
                          setMeetingType(meetingType);
                          setSessionFilename(sessionFilename);
                          setSessionInputType(sessionInputType);
                          setSessionCreatedAt(sessionCreatedAt);
                          setSessionNotes(notes);
                          resetLiveTranscriptState();
                          setError(null);
                          setIsCopied(false);
                          setIsCleaningWithLLM(false);
                          setRecordingSeconds(0);
                        }}
                        disabled={
                          audioIsRecording || isProcessing || areSessionsLoading
                        }
                      >
                        <div className={styles.recentSessionFilename}>
                          {session.filename}
                        </div>
                        <div className={styles.recentSessionDate}>
                          {formatSessionDate(session.createdAt)}
                        </div>
                      </button>
                      <button
                        className={styles.deleteSessionButton}
                        type="button"
                        onClick={() => void deleteSavedSession(session.id)}
                        disabled={
                          audioIsRecording || isProcessing || areSessionsLoading
                        }
                        aria-label={`Delete ${session.filename}`}
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            </nav>

            <div className={styles.localStatus}>
              <strong>Local processing</strong>
              <br />
              Whisper + OpenAI-compatible LLM
            </div>
          </aside>

          <main className={styles.workspace}>
            <section className={`${styles.card} ${styles.captureCard}`}>
              <div className={styles.cardHeader}>
                <div>
                  <h1 className={styles.cardTitle}>Capture a meeting</h1>
                  <p className={styles.cardDescription}>
                    Record your computer and microphone audio, or upload an
                    existing file.
                  </p>
                </div>
              </div>

              <div className={styles.captureContent}>
                <div className={styles.recordArea}>
                  <RecordButton
                    isRecording={audioIsRecording}
                    isProcessing={isProcessing}
                    onStartRecording={startRecording}
                    onStopRecording={stopRecording}
                  />
                  {audioIsRecording && (
                    <div className={styles.recordingTimer} aria-live="polite">
                      <span className={styles.recordingIndicator} />
                      {formatDuration(recordingSeconds)}
                    </div>
                  )}
                </div>

                <div className={styles.uploadArea}>
                  <UploadZone
                    isProcessing={isProcessing}
                    isDragging={isDragging}
                    onFileSelect={handleFileSelect}
                    onDragEnter={handleDragEnter}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    fileInputRef={fileInputRef}
                  />
                </div>
              </div>

              <details className={styles.textInputDetails}>
                <summary className={styles.promptToggle}>
                  Use an existing text transcript
                  <span aria-hidden="true">⌄</span>
                </summary>
                <div className={styles.textInputContent}>
                  <TextInputZone
                    isProcessing={isProcessing}
                    onTextSubmit={handleTextSubmit}
                  />
                </div>
              </details>
            </section>

            <section className={`${styles.card} ${styles.configCard}`}>
              <div className={styles.cardHeader}>
                <div>
                  <h2 className={styles.cardTitle}>Processing setup</h2>
                  <p className={styles.cardDescription}>
                    Choose how the transcript should be organized.
                  </p>
                </div>
              </div>

              <div className={styles.setupGroup}>
                <div className={styles.setupLabel}>Meeting preset</div>
                <div
                  className={styles.meetingOptions}
                  role="radiogroup"
                  aria-label="Meeting preset"
                >
                  {MEETING_OPTIONS.map((option) => {
                    const selected = meetingType === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`${styles.meetingOption} ${
                          selected ? styles.meetingOptionSelected : ''
                        }`}
                        onClick={() => setMeetingType(option.value)}
                      >
                        <span className={styles.meetingOptionLabel}>
                          {option.label}
                        </span>
                        <span
                          className={styles.meetingOptionCheck}
                          aria-hidden="true"
                        >
                          {selected ? '✓' : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className={styles.selectedMeetingInfo}>
                  <div className={styles.selectedMeetingTitle}>
                    {selectedMeeting.label}
                  </div>
                  <div className={styles.selectedMeetingDescription}>
                    {selectedMeeting.description}
                  </div>
                  <div className={styles.selectedMeetingSections}>
                    {selectedMeeting.sections}
                  </div>
                </div>
              </div>

              <div className={styles.setupDivider} />
              <div className={styles.cleanupRow}>
                <div>
                  <div className={styles.configLabel}>Include microphone</div>
                  <div className={styles.configHint}>
                    Capture your microphone together with the selected desktop
                    audio.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={includeMicrophone}
                  aria-label="Include microphone"
                  className={`${styles.switch} ${
                    includeMicrophone ? styles.switchOn : ''
                  }`}
                  onClick={() => setIncludeMicrophone((value) => !value)}
                  disabled={audioIsRecording || isProcessing}
                >
                  <span className={styles.switchThumb} />
                </button>
              </div>

              <div className={styles.setupDivider} />
              <div className={styles.cleanupRow}>
                <div>
                  <div className={styles.configLabel}>
                    Clean transcript with AI
                  </div>
                  <div className={styles.configHint}>
                    Remove filler words, repair grammar, and organize the
                    transcript into useful engineering sections.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useLLM}
                  aria-label="Clean transcript with AI"
                  className={`${styles.switch} ${
                    useLLM ? styles.switchOn : ''
                  }`}
                  onClick={() => setUseLLM((value) => !value)}
                >
                  <span className={styles.switchThumb} />
                </button>
              </div>

              <div className={styles.promptSection}>
                <button
                  type="button"
                  className={styles.promptToggle}
                  aria-expanded={isPromptOpen}
                  onClick={() => setIsPromptOpen((value) => !value)}
                >
                  <span>
                    <span className={styles.promptToggleTitle}>
                      Customize AI instructions
                    </span>
                    <span className={styles.promptToggleHint}>
                      Edit the full system prompt used for cleanup.
                    </span>
                  </span>
                  <span
                    className={`${styles.promptChevron} ${
                      isPromptOpen ? styles.promptChevronOpen : ''
                    }`}
                    aria-hidden="true"
                  >
                    ⌄
                  </span>
                </button>

                {isPromptOpen && (
                  <div className={styles.promptEditorArea}>
                    {isLoadingPrompt ? (
                      <p className={styles.cardDescription}>
                        Loading default prompt…
                      </p>
                    ) : (
                      <>
                        <div className={styles.promptEditorHeader}>
                          <span className={styles.promptEditorLabel}>
                            System prompt
                          </span>
                          <span className={styles.promptCharacterCount}>
                            {systemPrompt.length.toLocaleString()} characters
                          </span>
                        </div>
                        <textarea
                          className={styles.promptEditor}
                          value={systemPrompt}
                          onChange={(event) =>
                            setSystemPrompt(event.target.value)
                          }
                          aria-label="AI system prompt"
                        />
                        <div className={styles.promptEditorFooter}>
                          <span className={styles.promptEditorNote}>
                            Changes apply to the next transcript you process.
                          </span>
                          <button
                            type="button"
                            className={styles.restoreButton}
                            onClick={() => setSystemPrompt(defaultSystemPrompt)}
                            disabled={systemPrompt === defaultSystemPrompt}
                          >
                            Restore default
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </section>

            {(error || cleanupError) && (
              <div className={styles.errorArea}>
                <ErrorMessage
                  message={(error || cleanupError) ?? ''}
                  onDismiss={() => setError(null)}
                />
              </div>
            )}

            <section className={`${styles.card} ${styles.reviewCard}`}>
              <div className={styles.cardHeader}>
                <div>
                  <h2 className={styles.cardTitle}>Review your meeting</h2>
                  <p className={styles.cardDescription}>
                    Compare the original transcript with the structured recap.
                  </p>
                </div>
              </div>

              {(audioIsRecording || liveCommittedText || livePartialText) && (
                <div className={liveStyles.liveTranscript} aria-live="polite">
                  <div className={liveStyles.header}>
                    <div className={liveStyles.title}>Live transcript</div>
                    {audioIsRecording && (
                      <div className={liveStyles.status}>Listening…</div>
                    )}
                    {isLiveTranscriptEdited && (
                      <div className={liveStyles.status}>Edited</div>
                    )}
                  </div>

                  <div className={liveStyles.transcriptLine}>
                    <textarea
                      ref={liveTextareaRef}
                      value={liveCommittedText}
                      onChange={handleTextareaChange}
                      onSelect={rememberTextareaSelection}
                      onClick={rememberTextareaSelection}
                      onKeyUp={rememberTextareaSelection}
                      onFocus={rememberTextareaSelection}
                      rows={4}
                      aria-label="Committed live transcript"
                      className={liveStyles.committedEditor}
                    />

                    {livePartialText && (
                      <span
                        className={liveStyles.partialText}
                        aria-label="Provisional text, still being transcribed"
                      >
                        {liveCommittedText ? ' ' : ''}
                        {livePartialText}
                      </span>
                    )}
                  </div>

                  {!liveCommittedText &&
                    !livePartialText &&
                    audioIsRecording && (
                      <div className={liveStyles.emptyText}>
                        Waiting for speech…
                      </div>
                    )}

                  {audioIsRecording && (
                    <div className={liveStyles.notice}>
                      Faded text is still being transcribed and cannot be edited
                      yet.
                    </div>
                  )}
                </div>
              )}

              <TranscriptionResults
                rawText={rawText}
                editedRawText={editedRawText}
                onRawTextChange={setEditedRawText}
                onRegenerateCleanup={() => regenerateCleanup(editedRawText)}
                cleanedText={cleanedText}
                useLLM={useLLM}
                isCopied={isCopied}
                isCleaningWithLLM={isCleaningWithLLM}
                isProcessing={isProcessing}
                onCopy={copyToClipboard}
              />
            </section>
          </main>

          <aside className={styles.sessionPanel} aria-label="Meeting workspace">
            <section className={styles.sessionCard}>
              <h2 className={styles.sessionCardTitle}>Meeting workspace</h2>
              {sessionFilename !== null ? (
                <>
                  <input
                    className={styles.sessionFilenameInput}
                    value={sessionFilename}
                    onChange={(event) => setSessionFilename(event.target.value)}
                    placeholder="Meeting title"
                    aria-label="Meeting title"
                  />
                  <button
                    type="button"
                    className={styles.saveChangesButton}
                    onClick={() => void saveChanges()}
                    disabled={
                      !activeSessionId || audioIsRecording || isProcessing
                    }
                  >
                    Save changes
                  </button>
                  {saveMessage && (
                    <span className={styles.saveMessage}>{saveMessage}</span>
                  )}
                  <div className={styles.sessionMeta}>
                    <div>
                      {sessionInputType === 'recording'
                        ? 'Audio recording'
                        : sessionInputType === 'audio-file'
                          ? 'Uploaded audio file'
                          : 'Pasted transcript'}
                    </div>
                    <div>Meeting type: {selectedMeeting.label}</div>
                    {sessionCreatedAt && (
                      <div>Saved {formatSessionDate(sessionCreatedAt)}</div>
                    )}
                  </div>
                  {sessionInputType === 'recording' && (
                    <div className={styles.sessionDuration}>
                      {formatDuration(recordingSeconds)}
                    </div>
                  )}
                  <label
                    className={styles.sessionNotesLabel}
                    htmlFor="meeting-notes"
                  >
                    Notes
                  </label>
                  <textarea
                    className={styles.sessionNotesInput}
                    id="meeting-notes"
                    value={sessionNotes}
                    onChange={(event) => setSessionNotes(event.target.value)}
                    placeholder="Add meeting notes, follow-ups, or context..."
                    rows={7}
                    aria-label="Meeting notes"
                  />
                  {notesSaveStatus && (
                    <span className={styles.saveMessage} aria-live="polite">
                      {notesSaveStatus}
                    </span>
                  )}
                </>
              ) : (
                <p className={styles.emptySession}>
                  No audio selected. Your recording or uploaded file will appear
                  here.
                </p>
              )}
            </section>

            <section className={styles.sessionCard}>
              <h2 className={styles.sessionCardTitle}>Processing pipeline</h2>
              <div className={styles.pipeline}>
                <PipelineStep
                  label="Audio captured"
                  complete={
                    audioIsRecording || isProcessing || Boolean(rawText)
                  }
                />
                <PipelineStep
                  label="Transcription"
                  active={isProcessing}
                  complete={!isProcessing && Boolean(rawText)}
                />
                <PipelineStep
                  label="AI cleanup"
                  active={isCleaningWithLLM}
                  complete={
                    Boolean(cleanedText) || (Boolean(rawText) && !useLLM)
                  }
                />
                <PipelineStep
                  label="Review ready"
                  complete={
                    Boolean(cleanedText) || (Boolean(rawText) && !useLLM)
                  }
                />
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

interface PipelineStepProps {
  label: string;
  active?: boolean;
  complete?: boolean;
}

function PipelineStep({
  label,
  active = false,
  complete = false,
}: PipelineStepProps) {
  const className = [
    styles.pipelineStep,
    active ? styles.pipelineStepActive : '',
    complete ? styles.pipelineStepComplete : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <span className={styles.pipelineDot} />
      {label}
    </div>
  );
}

export default App;
