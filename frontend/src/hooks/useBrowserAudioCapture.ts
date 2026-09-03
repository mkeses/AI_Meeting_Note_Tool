import { useCallback, useEffect, useRef, useState } from 'react';
import { getTranscribeWebSocketUrl } from '../config';
import pcmProcessorUrl from '../audio/pcm-processor.ts?worker&url';

export interface UseBrowserAudioCaptureOptions {
  includeMicrophone?: boolean;
  onError?: (message: string) => void;
  onProcessingStateChange?: (isProcessing: boolean) => void;
  onRecordingSecondsChange?: (seconds: number) => void;
  onSocketMessage?: (event: MessageEvent) => void;
}

const START_MESSAGE = JSON.stringify({
  type: 'start',
  sample_rate: 48000,
  channels: 1,
  include_microphone: true,
  language: 'en',
});

const PCM_CHUNK_SIZE = 16_000;

/**
 * Captures microphone audio in a browser and streams raw PCM to the live
 * transcription WebSocket. Desktop/system-audio capture remains in
 * useAudioCapture.
 */
export function useBrowserAudioCapture({
  includeMicrophone = true,
  onError,
  onProcessingStateChange,
  onRecordingSecondsChange,
  onSocketMessage,
}: UseBrowserAudioCaptureOptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const liveSocketRef = useRef<WebSocket | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const microphoneSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const pcmProcessorRef = useRef<AudioWorkletNode | null>(null);
  const recordingIntervalRef = useRef<number | null>(null);
  const recordingSecondsRef = useRef(0);
  const pcmBufferRef = useRef(new Uint8Array(0));
  const isStartingRef = useRef(false);
  const isRecordingRef = useRef(false);
  const isStoppingRef = useRef(false);

  const reportError = useCallback(
    (message: string) => {
      setError(message);
      onError?.(message);
    },
    [onError]
  );

  const clearRecordingTimer = useCallback(() => {
    if (recordingIntervalRef.current !== null) {
      window.clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
  }, []);

  const releaseAudioResources = useCallback(() => {
    clearRecordingTimer();

    const microphoneSource = microphoneSourceRef.current;
    microphoneSourceRef.current = null;

    if (microphoneSource) {
      try {
        microphoneSource.disconnect();
      } catch {
        // The node may already be disconnected by the browser.
      }
    }

    const pcmProcessor = pcmProcessorRef.current;
    pcmProcessorRef.current = null;

    if (pcmProcessor) {
      pcmProcessor.port.onmessage = null;

      try {
        pcmProcessor.disconnect();
      } catch {
        // The node may already be disconnected by the browser.
      }
    }

    const microphoneStream = microphoneStreamRef.current;
    microphoneStreamRef.current = null;

    microphoneStream?.getTracks().forEach((track) => track.stop());

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;

    if (audioContext) {
      try {
        void audioContext.close().catch(() => undefined);
      } catch {
        // The context may already be closed by the browser.
      }
    }

    pcmBufferRef.current = new Uint8Array(0);
  }, [clearRecordingTimer]);

  const closeSocket = useCallback((reason = 'Recording ended') => {
    const socket = liveSocketRef.current;

    if (!socket) {
      return;
    }

    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    liveSocketRef.current = null;

    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      try {
        socket.close(1000, reason);
      } catch {
        // The browser may have closed the socket concurrently.
      }
    }
  }, []);

  const resetRecordingState = useCallback(() => {
    isRecordingRef.current = false;
    isStartingRef.current = false;
    isStoppingRef.current = false;
    setIsRecording(false);
    setRecordingSeconds(0);
  }, []);

  const handleSocketFailure = useCallback(
    (message: string) => {
      releaseAudioResources();
      closeSocket('Live transcription failed');
      resetRecordingState();
      onProcessingStateChange?.(false);
      reportError(message);
    },
    [
      closeSocket,
      onProcessingStateChange,
      releaseAudioResources,
      reportError,
      resetRecordingState,
    ]
  );

  const startRecording = useCallback(async () => {
    if (isRecordingRef.current || isStartingRef.current) {
      return;
    }

    isStartingRef.current = true;
    isStoppingRef.current = false;
    setError(null);
    onError?.('');

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone capture is not supported by this browser.');
      }

      if (typeof AudioContext === 'undefined') {
        throw new Error('Audio processing is not supported by this browser.');
      }

      if (typeof AudioWorkletNode === 'undefined') {
        throw new Error('Audio processing is not supported by this browser.');
      }

      const microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      microphoneStreamRef.current = microphoneStream;

      microphoneStream.getAudioTracks().forEach((track) => {
        track.enabled = includeMicrophone;
      });

      if (microphoneStream.getAudioTracks().length === 0) {
        throw new Error('No microphone audio track was captured.');
      }

      const audioContext = new AudioContext({
        latencyHint: 'interactive',
        sampleRate: 48000,
      });
      audioContextRef.current = audioContext;

      await audioContext.audioWorklet.addModule(pcmProcessorUrl);

      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const microphoneSource =
        audioContext.createMediaStreamSource(microphoneStream);
      const pcmProcessor = new AudioWorkletNode(audioContext, 'pcm-processor');
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;

      microphoneSource.connect(pcmProcessor);
      pcmProcessor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      microphoneSourceRef.current = microphoneSource;
      pcmProcessorRef.current = pcmProcessor;

      const socket = new WebSocket(getTranscribeWebSocketUrl());
      liveSocketRef.current = socket;

      socket.onmessage = (event) => {
        onSocketMessage?.(event);

        if (typeof event.data !== 'string') {
          return;
        }

        try {
          const message = JSON.parse(event.data) as { type?: string };

          if (message.type === 'final') {
            closeSocket();
          }
        } catch {
          // Message parsing remains owned by the live transcript hook.
        }
      };

      pcmProcessor.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const activeSocket = liveSocketRef.current;

        if (
          !isRecordingRef.current ||
          isStoppingRef.current ||
          !activeSocket ||
          activeSocket.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        const incoming = new Uint8Array(event.data);
        const combined = new Uint8Array(
          pcmBufferRef.current.length + incoming.length
        );
        combined.set(pcmBufferRef.current);
        combined.set(incoming, pcmBufferRef.current.length);
        pcmBufferRef.current = combined;

        while (
          pcmBufferRef.current.length >= PCM_CHUNK_SIZE &&
          activeSocket.readyState === WebSocket.OPEN &&
          isRecordingRef.current &&
          !isStoppingRef.current
        ) {
          try {
            activeSocket.send(pcmBufferRef.current.slice(0, PCM_CHUNK_SIZE));
            pcmBufferRef.current = pcmBufferRef.current.slice(PCM_CHUNK_SIZE);
          } catch {
            handleSocketFailure('Live transcription was interrupted.');
            return;
          }
        }
      };

      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const resolveOnce = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };

        const rejectOnce = (message: string) => {
          if (!settled) {
            settled = true;
            reject(new Error(message));
          }
        };

        socket.onopen = () => {
          if (socket.readyState !== WebSocket.OPEN) {
            rejectOnce('Could not connect to live transcription.');
            return;
          }

          try {
            socket.send(START_MESSAGE);
            resolveOnce();
          } catch {
            rejectOnce('Could not connect to live transcription.');
          }
        };

        socket.onerror = () => {
          rejectOnce('Could not connect to live transcription.');
        };

        socket.onclose = (event) => {
          void event;
          rejectOnce('Could not connect to live transcription.');
        };
      });

      socket.onopen = null;
      socket.onerror = () => {
        if (!isStoppingRef.current) {
          handleSocketFailure('Live transcription was interrupted.');
        }
      };
      socket.onclose = () => {
        if (liveSocketRef.current === socket) {
          liveSocketRef.current = null;
        }

        if (isRecordingRef.current && !isStoppingRef.current) {
          handleSocketFailure('Live transcription was interrupted.');
        }
      };

      isStartingRef.current = false;
      isRecordingRef.current = true;
      setIsRecording(true);
      recordingSecondsRef.current = 0;
      setRecordingSeconds(0);
      onRecordingSecondsChange?.(0);

      recordingIntervalRef.current = window.setInterval(() => {
        recordingSecondsRef.current += 1;
        setRecordingSeconds(recordingSecondsRef.current);
        onRecordingSecondsChange?.(recordingSecondsRef.current);
      }, 1000);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : undefined;
      const isPermissionDenied =
        (typeof DOMException !== 'undefined' &&
          caughtError instanceof DOMException &&
          (caughtError.name === 'NotAllowedError' ||
            caughtError.name === 'PermissionDeniedError')) ||
        message === 'Permission denied';
      const userMessage = isPermissionDenied
        ? 'Microphone access was denied. Allow microphone access and try again.'
        : message === 'No microphone audio track was captured.'
          ? message
          : message === 'Microphone capture is not supported by this browser.'
            ? message
            : message === 'Audio processing is not supported by this browser.'
              ? message
              : message === 'Could not connect to live transcription.'
                ? message
                : message ===
                    'Live transcription connection closed unexpectedly.'
                  ? message
                  : 'Could not start browser microphone capture.';

      releaseAudioResources();
      closeSocket('Recording startup failed');
      resetRecordingState();
      onProcessingStateChange?.(false);
      reportError(userMessage);
    }
  }, [
    closeSocket,
    handleSocketFailure,
    includeMicrophone,
    onError,
    onProcessingStateChange,
    onRecordingSecondsChange,
    onSocketMessage,
    releaseAudioResources,
    reportError,
    resetRecordingState,
  ]);

  const stopRecording = useCallback(() => {
    if (!isRecordingRef.current) {
      return;
    }

    isStoppingRef.current = true;
    isRecordingRef.current = false;
    setIsRecording(false);
    clearRecordingTimer();
    releaseAudioResources();

    const socket = liveSocketRef.current;

    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'stop' }));
        onProcessingStateChange?.(true);
        return;
      } catch {
        handleSocketFailure('Live transcription was interrupted.');
        return;
      }
    }

    closeSocket('Recording ended');
    isStoppingRef.current = false;
    onProcessingStateChange?.(false);
  }, [
    clearRecordingTimer,
    closeSocket,
    handleSocketFailure,
    onProcessingStateChange,
    releaseAudioResources,
  ]);

  const cleanupAudioCapture = useCallback(() => {
    releaseAudioResources();
    closeSocket('Capture cleaned up');
    resetRecordingState();
  }, [closeSocket, releaseAudioResources, resetRecordingState]);

  useEffect(() => {
    microphoneStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = includeMicrophone;
    });
  }, [includeMicrophone]);

  useEffect(() => cleanupAudioCapture, [cleanupAudioCapture]);

  return {
    cleanupAudioCapture,
    error,
    isRecording,
    liveSocketRef,
    recordingSeconds,
    startRecording,
    stopRecording,
  };
}
