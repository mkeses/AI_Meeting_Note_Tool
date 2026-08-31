import type { MutableRefObject } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudioCapture } from './useAudioCapture';

type TestTrack = {
  onended: (() => void) | null;
  readyState: MediaStreamTrackState;
  stop: () => void;
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = FakeWebSocket.CONNECTING;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ reason: reason || '' } as CloseEvent);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  fail() {
    this.onerror?.(new Event('error'));
  }

  serverClose(reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ reason } as CloseEvent);
  }

  send(data: string) {
    this.sent.push(data);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static workletError: Error | null = null;

  audioWorklet = {
    addModule: vi.fn(() => {
      if (FakeAudioContext.workletError) {
        return Promise.reject(FakeAudioContext.workletError);
      }

      return Promise.resolve();
    }),
  };
  close = vi.fn(() => Promise.resolve());
  destination = {} as AudioDestinationNode;
  state: AudioContextState = 'running';

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    return {
      connect: vi.fn(),
      gain: { value: 1 },
    };
  }

  createMediaStreamDestination() {
    return {
      stream: createStream([createTrack()], []),
    };
  }

  createMediaStreamSource() {
    return { connect: vi.fn() };
  }

  resume() {
    return Promise.resolve();
  }
}

class FakeMediaRecorder {
  static constructionError: Error | null = null;
  static instances: FakeMediaRecorder[] = [];
  static startError: Error | null = null;

  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: ((event: Event) => void | Promise<void>) | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  readonly startCalls: number[] = [];
  stopCalls = 0;
  stopCompletion: Promise<void> | null = null;

  constructor() {
    if (FakeMediaRecorder.constructionError) {
      throw FakeMediaRecorder.constructionError;
    }

    FakeMediaRecorder.instances.push(this);
  }

  static isTypeSupported() {
    return true;
  }

  emitData(blob: Blob) {
    this.ondataavailable?.({ data: blob } as BlobEvent);
  }

  emitError() {
    this.state = 'inactive';
    this.onerror?.();
  }

  emitStop() {
    const result = this.onstop?.(new Event('stop'));
    if (result instanceof Promise) {
      this.stopCompletion = result;
    }
  }

  start(timeslice?: number) {
    if (FakeMediaRecorder.startError) {
      throw FakeMediaRecorder.startError;
    }

    this.state = 'recording';

    if (timeslice !== undefined) {
      this.startCalls.push(timeslice);
    }
  }

  stop() {
    if (this.state === 'inactive') {
      return;
    }

    this.state = 'inactive';
    this.stopCalls += 1;
    this.emitStop();
  }
}

class FakeAudioWorkletNode {
  port: { onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null } = {
    onmessage: null,
  };

  connect() {}
}

class FakeMediaStream {
  constructor(private readonly tracks: MediaStreamTrack[]) {}

  getAudioTracks() {
    return this.tracks;
  }
}

function createTrack(): TestTrack {
  return {
    onended: null,
    readyState: 'live',
    stop: vi.fn(),
  };
}

function createStream(
  audioTracks: TestTrack[],
  videoTracks: TestTrack[]
): MediaStream {
  return {
    getAudioTracks: () => audioTracks,
    getTracks: () => [...audioTracks, ...videoTracks],
    getVideoTracks: () => videoTracks,
  } as unknown as MediaStream;
}

function configureBrowser(
  getDisplayMedia: (
    constraints?: DisplayMediaStreamOptions
  ) => Promise<MediaStream>,
  getUserMedia: (constraints?: MediaStreamConstraints) => Promise<MediaStream>
) {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('crypto', { randomUUID: () => 'recording-id' });
  vi.stubGlobal('navigator', {
    mediaDevices: { getDisplayMedia, getUserMedia },
  });
}

function renderAudioCapture() {
  const onError = vi.fn<(message: string) => void>();
  const onProcessingStateChange = vi.fn<(isProcessing: boolean) => void>();
  const onRecordingSecondsChange = vi.fn<(seconds: number) => void>();
  const onRecordingStateChange = vi.fn<(isRecording: boolean) => void>();
  const hook = renderHook(() =>
    useAudioCapture({
      includeMicrophone: true,
      onError,
      onProcessingStateChange,
      onRecordingSecondsChange,
      onRecordingStateChange,
    })
  );
  const liveSocketRef: MutableRefObject<WebSocket | null> = { current: null };
  const recordingSourceKeyRef: MutableRefObject<string | null> = {
    current: null,
  };

  return {
    ...hook,
    liveSocketRef,
    onError,
    onProcessingStateChange,
    onRecordingSecondsChange,
    onRecordingStateChange,
    recordingSourceKeyRef,
    resetLiveState: vi.fn(),
    setSessionFilename: vi.fn<(filename: string) => void>(),
    setSessionInputType:
      vi.fn<(type: 'recording' | 'audio-file' | 'text') => void>(),
  };
}

async function startRecording(
  capture: ReturnType<typeof renderAudioCapture>
): Promise<FakeWebSocket> {
  const { socket, startPromise } = beginRecording(capture);

  act(() => {
    socket.open();
  });

  await act(async () => {
    await startPromise;
  });

  return socket;
}

function beginRecording(capture: ReturnType<typeof renderAudioCapture>) {
  const startPromise = capture.result.current.startRecording(
    capture.liveSocketRef,
    capture.resetLiveState,
    capture.setSessionFilename,
    capture.setSessionInputType,
    capture.recordingSourceKeyRef
  );
  const socket = FakeWebSocket.instances[0];

  if (!socket) {
    throw new Error('Expected live transcription to create a WebSocket.');
  }

  return { socket, startPromise };
}

describe('useAudioCapture startup cleanup', () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    FakeAudioContext.workletError = null;
    FakeMediaRecorder.constructionError = null;
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.startError = null;
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('releases display tracks when microphone initialization fails', async () => {
    const displayAudioTrack = createTrack();
    const displayVideoTrack = createTrack();
    const getDisplayMedia =
      vi.fn<
        (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>
      >();
    const getUserMedia =
      vi.fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>();

    getDisplayMedia.mockResolvedValue(
      createStream([displayAudioTrack], [displayVideoTrack])
    );
    getUserMedia.mockRejectedValue(new Error('Microphone permission denied'));
    configureBrowser(getDisplayMedia, getUserMedia);

    const capture = renderAudioCapture();
    const socket = await startRecording(capture);

    expect(socket.sent).toEqual([
      JSON.stringify({
        type: 'start',
        sample_rate: 48000,
        channels: 1,
        include_microphone: true,
        language: 'en',
      }),
    ]);
    expect(displayAudioTrack.stop).toHaveBeenCalledTimes(1);
    expect(displayVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(socket.closeCalls).toEqual([
      { code: 1000, reason: 'Recording ended' },
    ]);
    expect(capture.liveSocketRef.current).toBeNull();
    expect(capture.result.current.isRecording).toBe(false);
    expect(capture.onRecordingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onProcessingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onError).toHaveBeenLastCalledWith(
      'Audio capture failed: Microphone permission denied'
    );
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('recovers when desktop capture permission is denied', async () => {
    const getDisplayMedia =
      vi.fn<
        (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>
      >();
    const getUserMedia =
      vi.fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>();

    getDisplayMedia.mockRejectedValue(new Error('Screen sharing was denied'));
    configureBrowser(getDisplayMedia, getUserMedia);

    const capture = renderAudioCapture();
    const socket = await startRecording(capture);

    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(socket.closeCalls).toEqual([
      { code: 1000, reason: 'Recording ended' },
    ]);
    expect(capture.liveSocketRef.current).toBeNull();
    expect(capture.result.current.isRecording).toBe(false);
    expect(capture.onRecordingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onProcessingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onError).toHaveBeenLastCalledWith(
      'Audio capture failed: Screen sharing was denied'
    );
  });

  it('cleans up desktop capture when the microphone has no audio track', async () => {
    const displayAudioTrack = createTrack();
    const displayVideoTrack = createTrack();
    const getDisplayMedia =
      vi.fn<
        (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>
      >();
    const getUserMedia =
      vi.fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>();

    getDisplayMedia.mockResolvedValue(
      createStream([displayAudioTrack], [displayVideoTrack])
    );
    getUserMedia.mockResolvedValue(createStream([], []));
    configureBrowser(getDisplayMedia, getUserMedia);

    const capture = renderAudioCapture();
    const socket = await startRecording(capture);

    expect(displayAudioTrack.stop).toHaveBeenCalledTimes(1);
    expect(displayVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(socket.closeCalls).toEqual([
      { code: 1000, reason: 'Recording ended' },
    ]);
    expect(capture.liveSocketRef.current).toBeNull();
    expect(capture.result.current.isRecording).toBe(false);
    expect(capture.onRecordingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onProcessingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onError).toHaveBeenLastCalledWith(
      'Audio capture failed: No microphone audio track was captured.'
    );
  });

  it('releases streams and closes AudioContext when worklet initialization fails', async () => {
    const displayAudioTrack = createTrack();
    const displayVideoTrack = createTrack();
    const microphoneTrack = createTrack();
    const getDisplayMedia =
      vi.fn<
        (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>
      >();
    const getUserMedia =
      vi.fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>();

    getDisplayMedia.mockResolvedValue(
      createStream([displayAudioTrack], [displayVideoTrack])
    );
    getUserMedia.mockResolvedValue(createStream([microphoneTrack], []));
    FakeAudioContext.workletError = new Error(
      'Audio worklet initialization failed'
    );
    configureBrowser(getDisplayMedia, getUserMedia);
    vi.stubGlobal('AudioContext', FakeAudioContext);

    const capture = renderAudioCapture();
    const socket = await startRecording(capture);
    const audioContext = FakeAudioContext.instances[0];

    if (!audioContext) {
      throw new Error('Expected recording startup to create an AudioContext.');
    }

    expect(displayAudioTrack.stop).toHaveBeenCalledTimes(1);
    expect(displayVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(audioContext.close).toHaveBeenCalledTimes(1);
    expect(socket.closeCalls).toEqual([
      { code: 1000, reason: 'Recording ended' },
    ]);
    expect(capture.liveSocketRef.current).toBeNull();
    expect(capture.result.current.isRecording).toBe(false);
    expect(capture.onRecordingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onProcessingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onError).toHaveBeenLastCalledWith(
      'Audio capture failed: Audio worklet initialization failed'
    );
  });

  it('releases resources when MediaRecorder construction fails', async () => {
    const displayAudioTrack = createTrack();
    const displayVideoTrack = createTrack();
    const microphoneTrack = createTrack();
    const getDisplayMedia =
      vi.fn<
        (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>
      >();
    const getUserMedia =
      vi.fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>();

    getDisplayMedia.mockResolvedValue(
      createStream([displayAudioTrack], [displayVideoTrack])
    );
    getUserMedia.mockResolvedValue(createStream([microphoneTrack], []));
    FakeMediaRecorder.constructionError = new Error(
      'MediaRecorder constructor failed'
    );
    configureBrowser(getDisplayMedia, getUserMedia);

    const capture = renderAudioCapture();
    const socket = await startRecording(capture);
    const audioContext = FakeAudioContext.instances[0];

    if (!audioContext) {
      throw new Error('Expected recording startup to create an AudioContext.');
    }

    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(displayAudioTrack.stop).toHaveBeenCalledTimes(1);
    expect(displayVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(audioContext.close).toHaveBeenCalledTimes(1);
    expect(socket.closeCalls).toEqual([
      { code: 1000, reason: 'Recording ended' },
    ]);
    expect(capture.liveSocketRef.current).toBeNull();
    expect(capture.result.current.isRecording).toBe(false);
    expect(capture.onError).toHaveBeenLastCalledWith(
      'Audio capture failed: MediaRecorder constructor failed'
    );
  });

  it('releases resources when MediaRecorder start fails', async () => {
    const displayAudioTrack = createTrack();
    const displayVideoTrack = createTrack();
    const microphoneTrack = createTrack();
    const getDisplayMedia =
      vi.fn<
        (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>
      >();
    const getUserMedia =
      vi.fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>();

    getDisplayMedia.mockResolvedValue(
      createStream([displayAudioTrack], [displayVideoTrack])
    );
    getUserMedia.mockResolvedValue(createStream([microphoneTrack], []));
    FakeMediaRecorder.startError = new Error('MediaRecorder failed to start');
    configureBrowser(getDisplayMedia, getUserMedia);

    const capture = renderAudioCapture();
    const socket = await startRecording(capture);
    const audioContext = FakeAudioContext.instances[0];

    if (!audioContext) {
      throw new Error('Expected recording startup to create an AudioContext.');
    }

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(displayAudioTrack.stop).toHaveBeenCalledTimes(1);
    expect(displayVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(audioContext.close).toHaveBeenCalledTimes(1);
    expect(socket.closeCalls).toEqual([
      { code: 1000, reason: 'Recording ended' },
    ]);
    expect(capture.liveSocketRef.current).toBeNull();
    expect(capture.result.current.isRecording).toBe(false);
    expect(capture.onError).toHaveBeenLastCalledWith(
      'Audio capture failed: MediaRecorder failed to start'
    );
  });

  it('uses the configured socket, then stops the recorder and resources once', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_WS_URL', 'wss://transcription.example.test/api');

    const displayAudioTrack = createTrack();
    const displayVideoTrack = createTrack();
    const microphoneTrack = createTrack();
    const getDisplayMedia =
      vi.fn<
        (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>
      >();
    const getUserMedia =
      vi.fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>();

    getDisplayMedia.mockResolvedValue(
      createStream([displayAudioTrack], [displayVideoTrack])
    );
    getUserMedia.mockResolvedValue(createStream([microphoneTrack], []));
    configureBrowser(getDisplayMedia, getUserMedia);

    const capture = renderAudioCapture();
    const socket = await startRecording(capture);
    const recorder = FakeMediaRecorder.instances[0];
    const audioContext = FakeAudioContext.instances[0];

    if (!recorder || !audioContext) {
      throw new Error('Expected recording startup to create its resources.');
    }

    expect(socket.url).toBe(
      'wss://transcription.example.test/api/ws/transcribe'
    );
    expect(socket.sent).toEqual([
      JSON.stringify({
        type: 'start',
        sample_rate: 48000,
        channels: 1,
        include_microphone: true,
        language: 'en',
      }),
    ]);
    expect(recorder.startCalls).toEqual([250]);
    expect(capture.result.current.isRecording).toBe(true);
    expect(capture.liveSocketRef.current).toBe(socket);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(capture.onRecordingSecondsChange).toHaveBeenNthCalledWith(1, 0);
    expect(capture.onRecordingSecondsChange).toHaveBeenNthCalledWith(2, 1);

    recorder.emitData(new Blob(['audio']));

    act(() => {
      capture.result.current.stopRecording(capture.liveSocketRef);
      capture.result.current.stopRecording(capture.liveSocketRef);
    });

    expect(socket.sent).toEqual([
      JSON.stringify({
        type: 'start',
        sample_rate: 48000,
        channels: 1,
        include_microphone: true,
        language: 'en',
      }),
      JSON.stringify({ type: 'stop' }),
    ]);
    expect(recorder.stopCalls).toBe(1);
    expect(capture.result.current.isRecording).toBe(false);
    expect(capture.onRecordingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onProcessingStateChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      await recorder.stopCompletion;
    });

    expect(displayAudioTrack.stop).toHaveBeenCalledTimes(1);
    expect(displayVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(audioContext.close).toHaveBeenCalledTimes(1);
    expect(capture.liveSocketRef.current).toBe(socket);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(capture.onRecordingSecondsChange).toHaveBeenCalledTimes(2);

    act(() => {
      socket.serverClose('Final transcript sent');
    });

    expect(capture.liveSocketRef.current).toBeNull();
  });

  it('recovers when the WebSocket errors before recording starts', async () => {
    const getDisplayMedia =
      vi.fn<
        (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>
      >();
    const getUserMedia =
      vi.fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>();
    configureBrowser(getDisplayMedia, getUserMedia);

    const capture = renderAudioCapture();
    const { socket, startPromise } = beginRecording(capture);

    act(() => {
      socket.fail();
    });

    await act(async () => {
      await startPromise;
    });

    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toEqual([
      { code: 1000, reason: 'Recording ended' },
    ]);
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(capture.liveSocketRef.current).toBeNull();
    expect(capture.result.current.isRecording).toBe(false);
    expect(capture.onRecordingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onProcessingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onError).toHaveBeenLastCalledWith(
      'Audio capture failed: Could not connect to live transcription.'
    );
  });

  it('recovers when the WebSocket closes before recording starts', async () => {
    const getDisplayMedia =
      vi.fn<
        (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>
      >();
    const getUserMedia =
      vi.fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>();
    configureBrowser(getDisplayMedia, getUserMedia);

    const capture = renderAudioCapture();
    const { socket, startPromise } = beginRecording(capture);

    act(() => {
      socket.serverClose('Backend unavailable');
    });

    await act(async () => {
      await startPromise;
    });

    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toEqual([]);
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(capture.liveSocketRef.current).toBeNull();
    expect(capture.result.current.isRecording).toBe(false);
    expect(capture.onRecordingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onProcessingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onError).toHaveBeenLastCalledWith(
      'Audio capture failed: Backend unavailable'
    );
  });

  it('terminates the timer and live transcription when the recorder errors', async () => {
    vi.useFakeTimers();

    const displayAudioTrack = createTrack();
    const displayVideoTrack = createTrack();
    const microphoneTrack = createTrack();
    const getDisplayMedia =
      vi.fn<
        (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>
      >();
    const getUserMedia =
      vi.fn<(constraints?: MediaStreamConstraints) => Promise<MediaStream>>();

    getDisplayMedia.mockResolvedValue(
      createStream([displayAudioTrack], [displayVideoTrack])
    );
    getUserMedia.mockResolvedValue(createStream([microphoneTrack], []));
    configureBrowser(getDisplayMedia, getUserMedia);

    const capture = renderAudioCapture();
    const socket = await startRecording(capture);
    const recorder = FakeMediaRecorder.instances[0];
    const audioContext = FakeAudioContext.instances[0];

    if (!recorder || !audioContext) {
      throw new Error('Expected recording startup to create its resources.');
    }

    recorder.emitData(new Blob(['audio']));

    act(() => {
      recorder.emitError();
    });

    expect(capture.result.current.isRecording).toBe(false);
    expect(capture.onRecordingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onProcessingStateChange).toHaveBeenLastCalledWith(false);
    expect(capture.onError).toHaveBeenLastCalledWith(
      'The browser recorder encountered an error.'
    );

    act(() => {
      recorder.emitStop();
    });

    await act(async () => {
      await recorder.stopCompletion;
    });

    expect(displayAudioTrack.stop).toHaveBeenCalledTimes(1);
    expect(displayVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(audioContext.close).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect({
      recordingSeconds: capture.onRecordingSecondsChange.mock.calls.map(
        ([seconds]) => seconds
      ),
      socketMessages: socket.sent,
    }).toEqual({
      recordingSeconds: [0],
      socketMessages: [
        JSON.stringify({
          type: 'start',
          sample_rate: 48000,
          channels: 1,
          include_microphone: true,
          language: 'en',
        }),
        JSON.stringify({ type: 'stop' }),
      ],
    });
  });
});
