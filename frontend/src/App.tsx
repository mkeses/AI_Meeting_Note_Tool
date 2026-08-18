import { useCallback, useEffect, useRef, useState } from 'react';

import styles from './App.module.css';
import { ErrorMessage } from './components/ErrorMessage';
import { RecordButton } from './components/RecordButton';
import { TextInputZone } from './components/TextInputZone';
import { TranscriptionResults } from './components/TranscriptionResults';
import { UploadZone } from './components/UploadZone';

interface TranscriptionResponse {
  success: boolean;
  text?: string;
  error?: string;
}

interface CleanResponse {
  success: boolean;
  text?: string;
  error?: string;
}

interface SystemPromptResponse {
  default_prompt: string;
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

const LLM_CLEANING_ERROR =
  'LLM cleaning failed. Your transcription is unaffected — check the backend terminal for details.';

function getSupportedMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') {
    return undefined;
  }

  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];

  return types.find((type) => MediaRecorder.isTypeSupported(type));
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, '0'))
    .join(':');
}

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [rawText, setRawText] = useState<string | null>(null);
  const [cleanedText, setCleanedText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useLLM, setUseLLM] = useState(true);
  const [isCopied, setIsCopied] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [defaultSystemPrompt, setDefaultSystemPrompt] = useState('');
  const [isLoadingPrompt, setIsLoadingPrompt] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [isCleaningWithLLM, setIsCleaningWithLLM] = useState(false);
  const [meetingType, setMeetingType] = useState<MeetingType>('general');
  const [isPromptOpen, setIsPromptOpen] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const isKeyDownRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const activeStreamsRef = useRef<MediaStream[]>([]);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [sessionFilename, setSessionFilename] = useState<string | null>(null);
  const [sessionInputType, setSessionInputType] =
    useState<SessionInputType>(null);

  useEffect(() => {
    let mounted = true;

    const loadPrompt = async () => {
      try {
        const response = await fetch('/api/system-prompt');

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const data = (await response.json()) as SystemPromptResponse;

        if (mounted) {
          setSystemPrompt(data.default_prompt);
          setDefaultSystemPrompt(data.default_prompt);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';

        console.error('Failed to load system prompt:', err);

        if (mounted) {
          setError(`Failed to load system prompt: ${message}`);
        }
      } finally {
        if (mounted) {
          setIsLoadingPrompt(false);
        }
      }
    };

    void loadPrompt();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isRecording) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRecordingSeconds((seconds) => seconds + 1);
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isRecording]);

  const cleanupAudioCapture = useCallback(async () => {
    activeStreamsRef.current.forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop());
    });

    activeStreamsRef.current = [];

    if (audioContextRef.current) {
      try {
        await audioContextRef.current.close();
      } catch (err) {
        console.error('Failed to close audio context:', err);
      }

      audioContextRef.current = null;
    }
  }, []);

  const cleanTranscription = useCallback(
    async (text: string) => {
      if (!useLLM || !text.trim()) {
        setIsCleaningWithLLM(false);
        return;
      }

      setIsCleaningWithLLM(true);

      try {
        const response = await fetch('/api/clean', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            ...(systemPrompt.trim() ? { system_prompt: systemPrompt } : {}),
            meeting_type: meetingType,
          }),
        });

        if (!response.ok) {
          throw new Error(`Cleaning failed with status ${response.status}`);
        }

        const data = (await response.json()) as CleanResponse;

        if (!data.success) {
          throw new Error(
            data.error || 'The backend rejected the cleaning request'
          );
        }

        setCleanedText(data.text || '');
      } catch (err) {
        console.error('LLM cleaning failed:', err);
        setError(LLM_CLEANING_ERROR);
      } finally {
        setIsCleaningWithLLM(false);
      }
    },
    [meetingType, systemPrompt, useLLM]
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

        if (!data.success) {
          throw new Error(data.error || 'Transcription failed');
        }

        const transcript = data.text || '';
        setRawText(transcript);

        await cleanTranscription(transcript);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';

        console.error('Audio processing failed:', err);
        setError(`Processing failed: ${message}`);
        setIsCleaningWithLLM(false);
      } finally {
        setIsProcessing(false);
      }
    },
    [cleanTranscription]
  );

  const startRecording = useCallback(async () => {
    if (isRecording || isProcessing) {
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      setError('Audio recording is not supported by this browser.');
      return;
    }

    let displayStream: MediaStream | null = null;
    let microphoneStream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;

    setRecordingSeconds(0);
    setSessionFilename('recording.webm');
    setSessionInputType('recording');

    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error(
          'Desktop audio capture is not supported by this browser.'
        );
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone capture is not supported by this browser.');
      }

      setError(null);
      setRawText(null);
      setCleanedText(null);
      setIsCleaningWithLLM(false);

      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        systemAudio: 'include',
      } as DisplayMediaStreamOptions);

      const displayVideoTracks = displayStream.getVideoTracks();
      const desktopTracks = displayStream.getAudioTracks();

      console.log('Display capture result:', {
        videoTracks: displayVideoTracks.length,
        audioTracks: desktopTracks.length,
        audioTrackStates: desktopTracks.map((track) => track.readyState),
        audioTrackSettings: desktopTracks.map((track) => track.getSettings()),
      });

      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const microphoneTracks = microphoneStream.getAudioTracks();

      console.log('Microphone capture result:', {
        audioTracks: microphoneTracks.length,
        audioTrackStates: microphoneTracks.map((track) => track.readyState),
        audioTrackSettings: microphoneTracks.map((track) =>
          track.getSettings()
        ),
      });

      if (microphoneTracks.length === 0) {
        throw new Error('No microphone audio track was captured.');
      }

      const videoTrack = displayVideoTracks[0];

      if (videoTrack) {
        videoTrack.onended = () => {
          const recorder = mediaRecorderRef.current;

          if (recorder && recorder.state !== 'inactive') {
            recorder.stop();
            setIsRecording(false);
          }
        };
      }

      audioContext = new AudioContext({
        latencyHint: 'interactive',
        sampleRate: 48000,
      });

      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const destination = audioContext.createMediaStreamDestination();

      const microphoneSource =
        audioContext.createMediaStreamSource(microphoneStream);

      microphoneSource.connect(destination);

      const liveDesktopTracks = desktopTracks.filter(
        (track) => track.readyState === 'live'
      );

      if (liveDesktopTracks.length > 0) {
        const desktopStream = new MediaStream(liveDesktopTracks);
        const desktopSource =
          audioContext.createMediaStreamSource(desktopStream);

        desktopSource.connect(destination);

        console.log('Desktop audio connected.');
      } else {
        console.log(
          'No live desktop-audio track was returned. Recording microphone only.'
        );
      }

      const destinationAudioTracks = destination.stream.getAudioTracks();

      console.log('Mixed audio destination:', {
        audioTracks: destinationAudioTracks.length,
        audioTrackStates: destinationAudioTracks.map(
          (track) => track.readyState
        ),
      });

      if (destinationAudioTracks.length === 0) {
        throw new Error('The mixed audio stream contains no audio tracks.');
      }

      const mimeType = getSupportedMimeType();

      console.log('Selected MediaRecorder MIME type:', mimeType);

      const recorder = mimeType
        ? new MediaRecorder(destination.stream, {
            mimeType,
            audioBitsPerSecond: 128_000,
          })
        : new MediaRecorder(destination.stream, {
            audioBitsPerSecond: 128_000,
          });

      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      audioContextRef.current = audioContext;
      activeStreamsRef.current = [displayStream, microphoneStream];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event: Event) => {
        console.error('MediaRecorder error:', event);

        setError('The browser recorder encountered an error.');
        setIsRecording(false);
        setIsProcessing(false);
      };

      recorder.onstop = async () => {
        const audioBlob = new Blob(chunksRef.current, {
          type: mimeType || 'audio/webm',
        });

        chunksRef.current = [];
        mediaRecorderRef.current = null;

        await cleanupAudioCapture();

        if (audioBlob.size === 0) {
          setError(
            'The recording was empty. Check your audio permissions and try again.'
          );
          setIsProcessing(false);
          return;
        }

        await uploadAudio(audioBlob, 'recording.webm');
      };

      recorder.start(250);
      setIsRecording(true);
    } catch (err) {
      console.error('Audio capture failed:', err);

      displayStream?.getTracks().forEach((track) => track.stop());
      microphoneStream?.getTracks().forEach((track) => track.stop());

      if (audioContext) {
        try {
          await audioContext.close();
        } catch (closeError) {
          console.error(
            'Failed to close audio context after capture error:',
            closeError
          );
        }
      }

      audioContextRef.current = null;
      activeStreamsRef.current = [];
      mediaRecorderRef.current = null;

      const message = err instanceof Error ? err.message : 'Unknown error';

      if (err instanceof DOMException) {
        if (err.name === 'NotAllowedError') {
          setError(
            'Microphone permission was denied or screen sharing was cancelled.'
          );
        } else if (err.name === 'AbortError') {
          setError('Screen sharing was cancelled.');
        } else if (err.name === 'NotFoundError') {
          setError('No microphone or audio capture device was found.');
        } else if (err.name === 'NotReadableError') {
          setError('The selected audio device is busy or unavailable.');
        } else if (err.name === 'InvalidStateError') {
          setError(
            'The browser could not create an audio source from the selected desktop audio.'
          );
        } else {
          setError(`Audio capture failed: ${err.name}: ${message}`);
        }
      } else {
        setError(`Audio capture failed: ${message}`);
      }

      setIsRecording(false);
      setIsProcessing(false);
    }
  }, [cleanupAudioCapture, isProcessing, isRecording, uploadAudio]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;

    if (!recorder || recorder.state === 'inactive') {
      return;
    }

    recorder.stop();
    setIsRecording(false);
    setIsProcessing(true);
  }, []);

  const processAudioFile = useCallback(
    (file: File) => {
      if (!file) {
        return;
      }

      if (!file.type.startsWith('audio/')) {
        setError('Please select a valid audio file.');
        return;
      }

      setError(null);
      setRawText(null);
      setCleanedText(null);
      setIsCleaningWithLLM(false);
      setRecordingSeconds(0);
      setSessionFilename(file.name);
      setSessionInputType('audio-file');

      const audioBlob = new Blob([file], {
        type: file.type,
      });

      void uploadAudio(audioBlob, file.name);
    },
    [uploadAudio]
  );

  const handleDragEnter = useCallback(() => {
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (file: File) => {
      setIsDragging(false);

      if (!isProcessing && !isRecording) {
        processAudioFile(file);
      }
    },
    [isProcessing, isRecording, processAudioFile]
  );

  const handleFileSelect = useCallback(
    (file: File) => {
      if (isProcessing || isRecording) {
        return;
      }

      processAudioFile(file);

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [isProcessing, isRecording, processAudioFile]
  );

  const handleTextSubmit = useCallback(
    async (text: string) => {
      if (!text.trim() || isProcessing || isRecording) {
        return;
      }

      setError(null);
      setRawText(text);
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
    [cleanTranscription, isProcessing, isRecording]
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isProcessing || event.repeat || isKeyDownRef.current) {
        return;
      }

      const target = event.target as HTMLElement | null;

      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;

      if (event.key.toLowerCase() === 'v' && !isTyping) {
        event.preventDefault();
        isKeyDownRef.current = true;

        if (!isRecording) {
          void startRecording();
        }
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'v') {
        return;
      }

      isKeyDownRef.current = false;

      if (isRecording) {
        stopRecording();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isProcessing, isRecording, startRecording, stopRecording]);

  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;

      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      }

      activeStreamsRef.current.forEach((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      });

      activeStreamsRef.current = [];

      if (audioContextRef.current) {
        void audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, []);

  const selectedMeeting =
    MEETING_OPTIONS.find((option) => option.value === meetingType) ??
    MEETING_OPTIONS.find((option) => option.value === 'general')!;

  const statusText = isRecording
    ? 'Recording'
    : isProcessing || isCleaningWithLLM
      ? 'Processing'
      : 'Ready to record';

  const handleNewSession = () => {
    if (isRecording || isProcessing) {
      return;
    }

    setRawText(null);
    setCleanedText(null);
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

            <button className={styles.settingsButton} type="button">
              Settings
            </button>
          </div>
        </header>

        <div className={styles.dashboard}>
          <aside className={styles.sidebar} aria-label="Workspace navigation">
            <button
              className={styles.newSessionButton}
              type="button"
              onClick={handleNewSession}
              disabled={isRecording || isProcessing}
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
                    isRecording={isRecording}
                    isProcessing={isProcessing}
                    onStartRecording={startRecording}
                    onStopRecording={stopRecording}
                  />

                  {isRecording && (
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

            {error && (
              <div className={styles.errorArea}>
                <ErrorMessage
                  message={error}
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

              <TranscriptionResults
                rawText={rawText}
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
                  <div className={styles.sessionFilename}>
                    {sessionFilename}
                  </div>

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
                  complete={isRecording || isProcessing || Boolean(rawText)}
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
