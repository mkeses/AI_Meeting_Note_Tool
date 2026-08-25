import { useCallback, useEffect, useRef, useState } from 'react';

import styles from './App.module.css';
import { ErrorMessage } from './components/ErrorMessage';
import { RecordButton } from './components/RecordButton';
import { TextInputZone } from './components/TextInputZone';
import { TranscriptionResults } from './components/TranscriptionResults';
import { UploadZone } from './components/UploadZone';
import liveStyles from './liveTranscript.module.css';

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
type SavedSession = {
  id: string;
  sourceKey: string;
  filename: string;
  createdAt: string;
  meetingType: MeetingType;
  rawText: string;
  cleanedText: string;
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

function formatSessionDate(createdAt: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(createdAt));
}

function normalizeForCompare(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function joinNonEmpty(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [rawText, setRawText] = useState<string | null>(null);
  const [editedRawText, setEditedRawText] = useState('');
  const [cleanedText, setCleanedText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useLLM, setUseLLM] = useState(true);
  const [includeMicrophone, setIncludeMicrophone] = useState(true);
  const [isLiveTranscriptEdited, setIsLiveTranscriptEdited] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [defaultSystemPrompt, setDefaultSystemPrompt] = useState('');
  const [isLoadingPrompt, setIsLoadingPrompt] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [isCleaningWithLLM, setIsCleaningWithLLM] = useState(false);
  const [meetingType, setMeetingType] = useState<MeetingType>('general');
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  // Live transcript display state.
  // `liveCommittedText` is the white, editable region.
  // `livePartialText` is the gray, read-only region that is still
  // being transcribed and can change at any moment.
  const [liveCommittedText, setLiveCommittedText] = useState('');
  const [livePartialText, setLivePartialText] = useState('');

  const [sessionFilename, setSessionFilename] = useState<string | null>(null);
  const [sessionInputType, setSessionInputType] =
    useState<SessionInputType>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingSourceKeyRef = useRef<string | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const isKeyDownRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const activeStreamsRef = useRef<MediaStream[]>([]);
  const isStoppingRecordingRef = useRef(false);
  const liveTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // --- Live transcript ownership model ---
  //
  // isLiveTranscriptEditedRef: once true, the user owns the committed
  // text. The backend may no longer overwrite it directly.
  //
  // liveUserCommittedTextRef: the authoritative committed text that is
  // shown in the editable textarea. Before the first edit this simply
  // mirrors the backend's committed_text. After the first edit, new
  // committed speech recognized by the backend is appended to this
  // value instead of replacing it.
  //
  // backendCommittedBaselineRef: the last backend committed_text we
  // have already incorporated into liveUserCommittedTextRef. Used to
  // detect the *new* suffix of speech the backend has recognized since
  // the last update, because the backend re-transcribes the full
  // recording on every live update rather than sending only new text.
  //
  // livePartialTextRef: mirror of the current partial (gray) text.
  // Partial text is always provisional, so it is always safe to let
  // the backend replace it, edited or not.
  const isLiveTranscriptEditedRef = useRef(false);
  const liveUserCommittedTextRef = useRef('');
  const backendCommittedBaselineRef = useRef('');
  const livePartialTextRef = useRef('');

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

  const resetLiveState = useCallback(() => {
    isLiveTranscriptEditedRef.current = false;
    liveUserCommittedTextRef.current = '';
    backendCommittedBaselineRef.current = '';
    livePartialTextRef.current = '';

    setIsLiveTranscriptEdited(false);
    setLiveCommittedText('');
    setLivePartialText('');
  }, []);

  const openSavedSession = useCallback(
    (session: SavedSession) => {
      if (isRecording || isProcessing) {
        return;
      }

      setActiveSessionId(session.id);
      setRawText(session.rawText);
      setEditedRawText(session.rawText);
      setCleanedText(session.cleanedText);
      setMeetingType(session.meetingType);
      setSessionFilename(session.filename);
      setSessionInputType(
        session.filename === 'Pasted transcript'
          ? 'text'
          : session.filename === 'recording.webm'
            ? 'recording'
            : 'audio-file'
      );
      resetLiveState();
      setError(null);
      setIsCopied(false);
      setIsCleaningWithLLM(false);
      setRecordingSeconds(0);
    },
    [isProcessing, isRecording, resetLiveState]
  );

  const saveChanges = useCallback(() => {
    if (!activeSessionId) {
      return;
    }

    const safeCleanedText = cleanedText ?? '';
    const safeFilename = sessionFilename?.trim() || 'Untitled session';

    setSavedSessions((currentSessions) =>
      currentSessions.map((session) =>
        session.id === activeSessionId
          ? {
              ...session,
              filename: safeFilename,
              rawText: editedRawText,
              cleanedText: safeCleanedText,
              meetingType,
            }
          : session
      )
    );

    setSaveMessage('Saved');

    window.setTimeout(() => {
      setSaveMessage(null);
    }, 2000);
  }, [
    activeSessionId,
    cleanedText,
    editedRawText,
    meetingType,
    sessionFilename,
  ]);

  const deleteSavedSession = useCallback(
    (sessionId: string) => {
      setSavedSessions((currentSessions) =>
        currentSessions.filter((session) => session.id !== sessionId)
      );

      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setRawText(null);
        setEditedRawText('');
        setCleanedText(null);
        setSessionFilename(null);
        setSessionInputType(null);
        resetLiveState();
        setError(null);
        setIsCopied(false);
        setIsCleaningWithLLM(false);
        setRecordingSeconds(0);
      }
    },
    [activeSessionId, resetLiveState]
  );

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

    return () => window.clearInterval(intervalId);
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
        return '';
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

        const cleaned = data.text || '';
        setCleanedText(cleaned);
        return cleaned;
      } catch (err) {
        console.error('LLM cleaning failed:', err);
        setError(LLM_CLEANING_ERROR);
        return '';
      } finally {
        setIsCleaningWithLLM(false);
      }
    },
    [meetingType, systemPrompt, useLLM]
  );

  const regenerateCleanup = useCallback(async () => {
    if (!editedRawText.trim() || isCleaningWithLLM) {
      return;
    }

    setError(null);
    await cleanTranscription(editedRawText);
  }, [cleanTranscription, editedRawText, isCleaningWithLLM]);

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

      setSavedSessions((currentSessions) => {
        const existingSession = currentSessions.find(
          (session) => session.sourceKey === newSession.sourceKey
        );

        if (existingSession) {
          setActiveSessionId(existingSession.id);

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

        setActiveSessionId(newSession.id);
        return [newSession, ...currentSessions];
      });

      setSessionFilename(filename);
      setSessionInputType(
        filename === 'recording.webm' ? 'recording' : 'audio-file'
      );
    },
    [cleanTranscription, meetingType]
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
    [processFinalTranscript]
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
    let socket: WebSocket | null = null;
    let recordingStopped = false;

    isStoppingRecordingRef.current = false;
    resetLiveState();
    setRecordingSeconds(0);
    setSessionFilename('recording.webm');
    setSessionInputType('recording');

    recordingSourceKeyRef.current = `recording:${crypto.randomUUID()}`;

    const closeSocket = () => {
      if (!socket) {
        return;
      }

      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.onopen = null;

      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close(1000, 'Recording ended');
      }

      if (liveSocketRef.current === socket) {
        liveSocketRef.current = null;
      }

      socket = null;
    };

    try {
      socket = new WebSocket('ws://localhost:8000/ws/transcribe');

      await new Promise<void>((resolve, reject) => {
        if (!socket) {
          reject(new Error('Could not create live transcription socket.'));
          return;
        }

        let settled = false;

        const resolveOnce = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };

        const rejectOnce = (error: Error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        };

        socket.onopen = () => {
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            rejectOnce(
              new Error('Live transcription socket did not open correctly.')
            );
            return;
          }

          socket.send(
            JSON.stringify({
              type: 'start',
              sample_rate: 48000,
              channels: 1,
              include_microphone: includeMicrophone,
              language: 'en',
            })
          );

          resolveOnce();
        };

        socket.onmessage = (event: MessageEvent) => {
          if (typeof event.data !== 'string') {
            return;
          }

          try {
            const message = JSON.parse(event.data) as {
              type: string;
              text?: string;
              committed_text?: string;
              partial_text?: string;
            };

            if (message.type === 'transcript') {
              const backendCommittedText =
                typeof message.committed_text === 'string'
                  ? message.committed_text
                  : '';
              const partialText =
                typeof message.partial_text === 'string'
                  ? message.partial_text
                  : '';

              // Partial (gray) text is always provisional. The backend
              // is always allowed to replace it, whether or not the
              // user has edited the committed text.
              livePartialTextRef.current = partialText;
              setLivePartialText(partialText);

              if (!isLiveTranscriptEditedRef.current) {
                liveUserCommittedTextRef.current = backendCommittedText;
                backendCommittedBaselineRef.current = backendCommittedText;
                setLiveCommittedText(backendCommittedText);
                return;
              }

              const baselineWordCount = normalizeForCompare(
                backendCommittedBaselineRef.current
              )
                .split(' ')
                .filter(Boolean).length;

              const incomingWords = normalizeForCompare(backendCommittedText)
                .split(' ')
                .filter(Boolean);

              if (incomingWords.length > baselineWordCount) {
                const newSuffix = incomingWords
                  .slice(baselineWordCount)
                  .join(' ')
                  .trim();

                if (newSuffix) {
                  const updatedCommittedText = joinNonEmpty(
                    liveUserCommittedTextRef.current,
                    newSuffix
                  );

                  liveUserCommittedTextRef.current = updatedCommittedText;
                  setLiveCommittedText(updatedCommittedText);
                }

                backendCommittedBaselineRef.current = backendCommittedText;
              }
              // If word count did not grow, do nothing and keep the existing
              // baseline — we'll re-check on the next update rather than risk
              // misaligning text on a transcription that shrank or stayed flat.
            }

            if (message.type === 'final') {
              const backendFinalText =
                typeof message.text === 'string' ? message.text : '';

              const finalText = isLiveTranscriptEditedRef.current
                ? joinNonEmpty(
                    liveUserCommittedTextRef.current,
                    livePartialTextRef.current
                  )
                : backendFinalText;

              setIsProcessing(true);

              void processFinalTranscript(finalText, 'recording.webm')
                .catch((error: unknown) => {
                  console.error(
                    'Failed to process final WebSocket transcript:',
                    error
                  );

                  const errorMessage =
                    error instanceof Error ? error.message : 'Unknown error';

                  setError(`Processing failed: ${errorMessage}`);
                })
                .finally(() => {
                  resetLiveState();
                  setIsProcessing(false);
                });
            }
          } catch (error) {
            console.error('Could not parse WebSocket message:', error);
          }
        };

        socket.onerror = () => {
          rejectOnce(new Error('Could not connect to live transcription.'));
        };

        socket.onclose = (event) => {
          if (liveSocketRef.current === socket) {
            liveSocketRef.current = null;
          }

          if (!settled) {
            rejectOnce(
              new Error(
                event.reason || 'Live transcription socket closed unexpectedly.'
              )
            );
          }
        };
      });

      liveSocketRef.current = socket;

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

      if (includeMicrophone) {
        microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }

      const microphoneTracks = microphoneStream?.getAudioTracks() ?? [];

      if (includeMicrophone && microphoneTracks.length === 0) {
        throw new Error('No microphone audio track was captured.');
      }

      const videoTrack = displayVideoTracks[0];

      if (videoTrack) {
        videoTrack.onended = () => {
          const recorder = mediaRecorderRef.current;

          if (recorder && recorder.state !== 'inactive') {
            recorder.stop();
          }

          setIsRecording(false);
        };
      }

      audioContext = new AudioContext({
        latencyHint: 'interactive',
        sampleRate: 48000,
      });

      await audioContext.audioWorklet.addModule('/src/audio/pcm-processor.ts');

      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const destination = audioContext.createMediaStreamDestination();
      const pcmProcessor = new AudioWorkletNode(audioContext, 'pcm-processor');
      let pcmBuffer = new Uint8Array(0);

      pcmProcessor.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (isStoppingRecordingRef.current) {
          return;
        }

        const incoming = new Uint8Array(event.data);
        const combined = new Uint8Array(pcmBuffer.length + incoming.length);

        combined.set(pcmBuffer);
        combined.set(incoming, pcmBuffer.length);
        pcmBuffer = combined;

        const chunkSize = 16_000;

        while (
          !isStoppingRecordingRef.current &&
          pcmBuffer.length >= chunkSize &&
          liveSocketRef.current?.readyState === WebSocket.OPEN
        ) {
          const socketToSend = liveSocketRef.current;

          if (!socketToSend) {
            break;
          }

          try {
            socketToSend.send(pcmBuffer.slice(0, chunkSize));
            pcmBuffer = pcmBuffer.slice(chunkSize);
          } catch (error) {
            console.error('Could not send PCM data:', error);
            break;
          }
        }
      };

      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      pcmProcessor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      if (microphoneStream) {
        const microphoneSource =
          audioContext.createMediaStreamSource(microphoneStream);

        microphoneSource.connect(destination);
        microphoneSource.connect(pcmProcessor);
      }

      const liveDesktopTracks = desktopTracks.filter(
        (track) => track.readyState === 'live'
      );

      if (liveDesktopTracks.length > 0) {
        const desktopStream = new MediaStream(liveDesktopTracks);
        const desktopSource =
          audioContext.createMediaStreamSource(desktopStream);

        desktopSource.connect(destination);
        desktopSource.connect(pcmProcessor);
      }

      if (destination.stream.getAudioTracks().length === 0) {
        throw new Error('The mixed audio stream contains no audio tracks.');
      }

      const mimeType = getSupportedMimeType();
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
      activeStreamsRef.current = [
        displayStream,
        ...(microphoneStream ? [microphoneStream] : []),
      ];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setError('The browser recorder encountered an error.');
        setIsRecording(false);
        setIsProcessing(false);
      };

      recorder.onstop = async () => {
        if (recordingStopped) {
          return;
        }

        recordingStopped = true;

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

        console.log(
          'Recording complete; final transcript is handled by WebSocket.'
        );
      };

      recorder.start(250);
      setIsRecording(true);
    } catch (err) {
      closeSocket();
      await cleanupAudioCapture();
      mediaRecorderRef.current = null;
      setIsRecording(false);
      setIsProcessing(false);

      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(`Audio capture failed: ${message}`);
    }
  }, [
    cleanupAudioCapture,
    includeMicrophone,
    isProcessing,
    isRecording,
    processFinalTranscript,
    resetLiveState,
  ]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    const socket = liveSocketRef.current;

    if (!recorder || recorder.state === 'inactive') {
      return;
    }

    isStoppingRecordingRef.current = true;

    try {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'stop' }));
      }

      recorder.stop();
      setIsRecording(false);
      setIsProcessing(true);
    } catch (error) {
      console.error('Failed to stop recording:', error);
      isStoppingRecordingRef.current = false;
      setIsRecording(false);
      setIsProcessing(false);
      setError(
        error instanceof Error ? error.message : 'Failed to stop recording.'
      );
    }
  }, []);

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
      resetLiveState();

      void uploadAudio(new Blob([file], { type: file.type }), file.name);
    },
    [resetLiveState, uploadAudio]
  );

  const handleDragEnter = useCallback(() => setIsDragging(true), []);
  const handleDragLeave = useCallback(() => setIsDragging(false), []);

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

  const handleLiveTranscriptChange = (
    event: React.ChangeEvent<HTMLTextAreaElement>
  ) => {
    const nextCommittedText = event.currentTarget.value;

    // Marking this ref true synchronously is what protects the user's
    // edit: any WebSocket message handled after this point in the
    // event loop will see isLiveTranscriptEditedRef.current === true
    // and will stop overwriting the committed text directly.
    isLiveTranscriptEditedRef.current = true;
    setIsLiveTranscriptEdited(true);

    liveUserCommittedTextRef.current = nextCommittedText;
    setLiveCommittedText(nextCommittedText);
  };

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

    setActiveSessionId(null);
    setRawText(null);
    setEditedRawText('');
    setCleanedText(null);
    resetLiveState();
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
                        onClick={() => openSavedSession(session)}
                        disabled={isRecording || isProcessing}
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
                        disabled={isRecording || isProcessing}
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
                  disabled={isRecording || isProcessing}
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

              {(isRecording || liveCommittedText || livePartialText) && (
                <div className={liveStyles.liveTranscript} aria-live="polite">
                  <div className={liveStyles.header}>
                    <div className={liveStyles.title}>Live transcript</div>
                    {isRecording && (
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
                      onChange={handleLiveTranscriptChange}
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

                  {!liveCommittedText && !livePartialText && isRecording && (
                    <div className={liveStyles.emptyText}>
                      Waiting for speech…
                    </div>
                  )}

                  {isRecording && (
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
                onRegenerateCleanup={regenerateCleanup}
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
                    disabled={!activeSessionId || isRecording || isProcessing}
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
