import { useCallback, useRef, useState } from 'react';

interface UseAudioCaptureOptions {
  includeMicrophone: boolean;
  onError: (message: string) => void;
  onRecordingStateChange: (isRecording: boolean) => void;
  onProcessingStateChange: (isProcessing: boolean) => void;
  onRecordingSecondsChange: (seconds: number) => void;
  onSocketMessage?: (message: MessageEvent) => void;
}

/**
 * Manages desktop + microphone audio capture, MediaRecorder,
 * AudioContext, PCM processing, and streaming to a live WebSocket.
 */
export function useAudioCapture({
  includeMicrophone,
  onError,
  onRecordingStateChange,
  onProcessingStateChange,
  onRecordingSecondsChange,
}: UseAudioCaptureOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const activeStreamsRef = useRef<MediaStream[]>([]);
  const isStoppingRecordingRef = useRef(false);
  const recordingIntervalRef = useRef<number | null>(null);
  const recordingSecondsRef = useRef(0);

  const getSupportedMimeType = (): string | undefined => {
    if (typeof MediaRecorder === 'undefined') {
      return undefined;
    }

    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ];

    return types.find((type) => MediaRecorder.isTypeSupported(type));
  };

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

  const startRecording = useCallback(
    async (
      liveSocketRef: React.MutableRefObject<WebSocket | null>,
      resetLiveState: () => void,
      setSessionFilename: (filename: string) => void,
      setSessionInputType: (type: 'recording' | 'audio-file' | 'text') => void,
      recordingSourceKeyRef: React.MutableRefObject<string | null>,
      onSocketMessage?: (event: MessageEvent) => void
    ) => {
      if (isRecording) {
        return;
      }

      if (typeof MediaRecorder === 'undefined') {
        onError('Audio recording is not supported by this browser.');
        return;
      }

      let displayStream: MediaStream | null = null;
      let microphoneStream: MediaStream | null = null;
      let audioContext: AudioContext | null = null;
      let socket: WebSocket | null = null;
      let recordingStopped = false;

      isStoppingRecordingRef.current = false;
      resetLiveState();
      recordingSecondsRef.current = 0;
      onRecordingSecondsChange(0);
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

        if (onSocketMessage) {
          socket.onmessage = onSocketMessage;
        }

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
                  event.reason ||
                    'Live transcription socket closed unexpectedly.'
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
          throw new Error(
            'Microphone capture is not supported by this browser.'
          );
        }

        onError('');

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
            onRecordingStateChange(false);
          };
        }

        audioContext = new AudioContext({
          latencyHint: 'interactive',
          sampleRate: 48000,
        });

        await audioContext.audioWorklet.addModule(
          '/src/audio/pcm-processor.ts'
        );

        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }

        const destination = audioContext.createMediaStreamDestination();
        const pcmProcessor = new AudioWorkletNode(
          audioContext,
          'pcm-processor'
        );
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
          onError('The browser recorder encountered an error.');
          setIsRecording(false);
          onRecordingStateChange(false);
          onProcessingStateChange(false);
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
            onError(
              'The recording was empty. Check your audio permissions and try again.'
            );
            onProcessingStateChange(false);
            return;
          }

          console.log(
            'Recording complete; final transcript is handled by WebSocket.'
          );
        };

        recorder.start(250);
        setIsRecording(true);
        onRecordingStateChange(true);

        // Start the recording timer
        if (recordingIntervalRef.current) {
          window.clearInterval(recordingIntervalRef.current);
        }
        recordingIntervalRef.current = window.setInterval(() => {
          recordingSecondsRef.current += 1;
          onRecordingSecondsChange(recordingSecondsRef.current);
        }, 1000);
      } catch (err) {
        closeSocket();
        await cleanupAudioCapture();
        mediaRecorderRef.current = null;
        setIsRecording(false);
        onRecordingStateChange(false);
        onProcessingStateChange(false);

        const message = err instanceof Error ? err.message : 'Unknown error';
        onError(`Audio capture failed: ${message}`);

        if (recordingIntervalRef.current) {
          window.clearInterval(recordingIntervalRef.current);
          recordingIntervalRef.current = null;
        }
      }
    },
    [
      cleanupAudioCapture,
      includeMicrophone,
      isRecording,
      onError,
      onRecordingStateChange,
      onProcessingStateChange,
      onRecordingSecondsChange,
    ]
  );

  const stopRecording = useCallback(
    (liveSocketRef: React.MutableRefObject<WebSocket | null>) => {
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
        onRecordingStateChange(false);
        onProcessingStateChange(true);

        if (recordingIntervalRef.current) {
          window.clearInterval(recordingIntervalRef.current);
          recordingIntervalRef.current = null;
        }
      } catch (error) {
        console.error('Failed to stop recording:', error);
        isStoppingRecordingRef.current = false;
        setIsRecording(false);
        onRecordingStateChange(false);
        onProcessingStateChange(false);
        onError(
          error instanceof Error ? error.message : 'Failed to stop recording.'
        );

        if (recordingIntervalRef.current) {
          window.clearInterval(recordingIntervalRef.current);
          recordingIntervalRef.current = null;
        }
      }
    },
    [onError, onRecordingStateChange, onProcessingStateChange]
  );

  const getAudioBlob = useCallback((): Blob | null => {
    if (chunksRef.current.length === 0) {
      return null;
    }

    const mimeType = getSupportedMimeType() || 'audio/webm';
    return new Blob(chunksRef.current, { type: mimeType });
  }, []);

  return {
    isRecording,
    startRecording,
    stopRecording,
    getAudioBlob,
    cleanupAudioCapture,
  };
}
