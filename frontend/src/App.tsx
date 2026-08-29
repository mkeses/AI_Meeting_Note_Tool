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
import type { SavedSession } from './hooks/useMeetingSessions';
import { usePushToTalk } from './hooks/usePushToTalk';

interface TranscriptionResponse {
  success: boolean;
  text?: string;
  error?: string;
}

type MeetingType = 'general' | 'design_review' | 'debug_sync' | 'standup';
type SessionInputType = 'recording' | 'audio-file' | 'text' | null;

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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const recordingSourceKeyRef = useRef<string | null>(null);
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
    openSavedSession,
    saveSession,
    addSession,
    deleteSession,
  } = sessions;

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

      const newSession: SavedSession = {
        id: crypto.randomUUID(),
        sourceKey:
          filename === 'recording.webm'
            ? recordingSourceKeyRef.current ||
              `recording:${crypto.randomUUID()}`
            : `audio-file:${filename}`,
        filename,
        createdAt: new Date().toISOString(),
        meetingType,
        rawText: finalText,
        cleanedText: cleaned,
      };

      const { activeSessionId: newActiveId } = addSession(newSession);
      setActiveSessionId(newActiveId);

      setSessionFilename(filename);
      setSessionInputType(
        filename === 'recording.webm' ? 'recording' : 'audio-file'
      );

      setCleanedText(cleaned);
    },
    [addSession, cleanTranscription, meetingType]
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

  // Push-to-talk keyboard shortcuts
  usePushToTalk({
    isRecording: audioIsRecording,
    isProcessing,
    startRecording: () =>
      audioStartRecording(
        liveSocketRef,
        resetLiveTranscriptState,
        setSessionFilename,
        setSessionInputType,
        recordingSourceKeyRef,
        handleSocketMessage
      ),
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

  const saveChanges = useCallback(() => {
    const savedId = saveSession(
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
    }
  }, [
    activeSessionId,
    sessionFilename,
    editedRawText,
    cleanedText,
    meetingType,
    saveSession,
  ]);

  const deleteSavedSession = useCallback(
    (sessionId: string) => {
      const { wasActive } = deleteSession(sessionId);

      if (wasActive || activeSessionId === sessionId) {
        setActiveSessionId(null);
        setRawText(null);
        setEditedRawText('');
        setCleanedText(null);
        setSessionFilename(null);
        setSessionInputType(null);
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

  const startRecording = useCallback(async () => {
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
    setSessionFilename,
    setSessionInputType,
    recordingSourceKeyRef,
    handleSocketMessage,
  ]);

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
              <div className={styles.recentSessionsList}>
                {savedSessions.length === 0 ? (
                  <div className={styles.emptyRecentSessions}>
                    No saved sessions yet.
                  </div>
                ) : (
                  savedSessions.slice(0, 5).map((session) => (
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
                          } = result;

                          setActiveSessionId(newActiveId);
                          setRawText(rawText);
                          setEditedRawText(editedRawText);
                          setCleanedText(cleanedText);
                          setMeetingType(meetingType);
                          setSessionFilename(sessionFilename);
                          setSessionInputType(sessionInputType);
                          resetLiveTranscriptState();
                          setError(null);
                          setIsCopied(false);
                          setIsCleaningWithLLM(false);
                          setRecordingSeconds(0);
                        }}
                        disabled={audioIsRecording || isProcessing}
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
                        onClick={() => deleteSavedSession(session.id)}
                        disabled={audioIsRecording || isProcessing}
                        aria-label={`Delete ${session.filename}`}
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
              <button className={styles.navItem} type="button">
                Saved notes
              </button>
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

          <aside className={styles.sessionPanel} aria-label="Current session">
            <section className={styles.sessionCard}>
              <h2 className={styles.sessionCardTitle}>Current session</h2>
              {sessionFilename ? (
                <>
                  <input
                    className={styles.sessionFilenameInput}
                    value={sessionFilename}
                    onChange={(event) => setSessionFilename(event.target.value)}
                    placeholder="Session name"
                    aria-label="Session name"
                  />
                  <button
                    type="button"
                    className={styles.saveChangesButton}
                    onClick={saveChanges}
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
                    {sessionInputType === 'recording'
                      ? 'Audio recording'
                      : sessionInputType === 'audio-file'
                        ? 'Uploaded audio file'
                        : 'Pasted transcript'}
                  </div>
                  {sessionInputType === 'recording' && (
                    <div className={styles.sessionDuration}>
                      {formatDuration(recordingSeconds)}
                    </div>
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
