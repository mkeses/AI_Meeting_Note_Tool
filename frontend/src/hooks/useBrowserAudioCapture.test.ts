import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserAudioCapture } from './useBrowserAudioCapture';

type TestTrack = {
  enabled: boolean;
  readyState: MediaStreamTrackState;
  stop: ReturnType<typeof vi.fn>;
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
  readonly sent: Array<string | ArrayBuffer | Uint8Array> = [];

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

  send(data: string | ArrayBuffer | Uint8Array) {
    this.sent.push(data);
  }

  message(data: string | ArrayBuffer) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static workletError: Error | null = null;

  readonly audioWorklet = {
    addModule: vi.fn(() => {
      if (FakeAudioContext.workletError) {
        return Promise.reject(FakeAudioContext.workletError);
      }

      return Promise.resolve();
    }),
  };
  readonly close = vi.fn(() => Promise.resolve());
  readonly destination = {} as AudioDestinationNode;
  readonly state: AudioContextState = 'running';

  constructor(readonly options?: AudioContextOptions) {
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    return {
      connect: vi.fn(),
      gain: { value: 1 },
    };
  }

  createMediaStreamSource() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as MediaStreamAudioSourceNode;
  }
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];

  readonly port: {
    onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null;
  } = { onmessage: null };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();

  constructor() {
    FakeAudioWorkletNode.instances.push(this);
  }
}

function createTrack(): TestTrack {
  return {
    enabled: true,
    readyState: 'live',
    stop: vi.fn(),
  };
}

function createMicrophoneStream(track: TestTrack): MediaStream {
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

function configureBrowser(getUserMedia: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
}

function renderBrowserCapture(initialIncludeMicrophone = true) {
  const onError = vi.fn();
  const onProcessingStateChange = vi.fn();
  const onRecordingSecondsChange = vi.fn();
  const onSocketMessage = vi.fn();
  const capture = renderHook(
    ({ includeMicrophone }) =>
      useBrowserAudioCapture({
        includeMicrophone,
        onError,
        onProcessingStateChange,
        onRecordingSecondsChange,
        onSocketMessage,
      }),
    { initialProps: { includeMicrophone: initialIncludeMicrophone } }
  );

  return {
    ...capture,
    onError,
    onProcessingStateChange,
    onRecordingSecondsChange,
    onSocketMessage,
  };
}

async function startCapture(capture: ReturnType<typeof renderBrowserCapture>) {
  const startPromise = capture.result.current.startRecording();
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

  const socket = FakeWebSocket.instances[0];

  if (!socket) {
    throw new Error('Expected browser capture to create a WebSocket.');
  }

  act(() => socket.open());
  await act(async () => {
    await startPromise;
  });

  return socket;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeAudioContext.instances = [];
  FakeAudioWorkletNode.instances = [];
  FakeAudioContext.workletError = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useBrowserAudioCapture', () => {
  it('captures microphone-only audio and sends the existing PCM protocol', async () => {
    const microphoneTrack = createTrack();
    const getUserMedia = vi
      .fn()
      .mockResolvedValue(createMicrophoneStream(microphoneTrack));
    configureBrowser(getUserMedia);
    vi.stubEnv('VITE_WS_URL', 'wss://transcription.example.test/api');
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: getDisplayMedia,
    });

    const capture = renderBrowserCapture();
    const socket = await startCapture(capture);

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(getDisplayMedia).not.toHaveBeenCalled();
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
    expect(capture.result.current.isRecording).toBe(true);

    const audioContext = FakeAudioContext.instances[0];
    const processor = FakeAudioWorkletNode.instances[0];

    expect(audioContext?.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(audioContext?.options).toEqual({
      latencyHint: 'interactive',
      sampleRate: 48000,
    });
    expect(processor).toBeDefined();
  });

  it('sends binary PCM frames and stops/cleans up the microphone session', async () => {
    const microphoneTrack = createTrack();
    const getUserMedia = vi
      .fn()
      .mockResolvedValue(createMicrophoneStream(microphoneTrack));
    configureBrowser(getUserMedia);

    const capture = renderBrowserCapture();
    const socket = await startCapture(capture);

    const workletNode = FakeAudioWorkletNode.instances[0];

    expect(workletNode).toBeDefined();
    workletNode?.port.onmessage?.({
      data: new ArrayBuffer(16_000),
    } as MessageEvent<ArrayBuffer>);

    const binaryFrame = socket.sent[1];
    expect(binaryFrame).toBeInstanceOf(Uint8Array);
    expect((binaryFrame as Uint8Array).byteLength).toBe(16_000);

    act(() => capture.result.current.stopRecording());

    expect(socket.sent[2]).toBe(JSON.stringify({ type: 'stop' }));
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalledTimes(1);
    expect(capture.result.current.isRecording).toBe(false);
    expect(capture.onProcessingStateChange).toHaveBeenLastCalledWith(true);

    act(() => {
      socket.message(JSON.stringify({ type: 'final', text: 'done' }));
    });

    expect(socket.closeCalls).toEqual([
      { code: 1000, reason: 'Recording ended' },
    ]);
    expect(capture.onSocketMessage).toHaveBeenCalledTimes(1);
  });

  it('enables or disables the microphone track without changing the capture path', async () => {
    const microphoneTrack = createTrack();
    const getUserMedia = vi
      .fn()
      .mockResolvedValue(createMicrophoneStream(microphoneTrack));
    configureBrowser(getUserMedia);

    const capture = renderBrowserCapture(false);
    await startCapture(capture);

    expect(microphoneTrack.enabled).toBe(false);

    capture.rerender({ includeMicrophone: true });

    expect(microphoneTrack.enabled).toBe(true);
  });

  it('does not call display capture and reports microphone permission failure', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValue(
        new DOMException('Permission denied', 'NotAllowedError')
      );
    configureBrowser(getUserMedia);
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: getDisplayMedia,
    });

    const capture = renderBrowserCapture();

    await act(async () => {
      await capture.result.current.startRecording();
    });

    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(capture.result.current.isRecording).toBe(false);
    expect(capture.result.current.error).toBe(
      'Microphone access was denied. Allow microphone access and try again.'
    );
  });

  it('cleans up when AudioWorklet initialization fails', async () => {
    const microphoneTrack = createTrack();
    const getUserMedia = vi
      .fn()
      .mockResolvedValue(createMicrophoneStream(microphoneTrack));
    configureBrowser(getUserMedia);
    FakeAudioContext.workletError = new Error('worklet failed');

    const capture = renderBrowserCapture();

    await act(async () => {
      await capture.result.current.startRecording();
    });

    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(capture.result.current.error).toBe(
      'Could not start browser microphone capture.'
    );
  });

  it('cleans up when the WebSocket fails before recording starts', async () => {
    const microphoneTrack = createTrack();
    const getUserMedia = vi
      .fn()
      .mockResolvedValue(createMicrophoneStream(microphoneTrack));
    configureBrowser(getUserMedia);

    const capture = renderBrowserCapture();
    const startPromise = capture.result.current.startRecording();

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const socket = FakeWebSocket.instances[0];

    if (!socket) {
      throw new Error('Expected browser capture to create a WebSocket.');
    }

    act(() => socket.fail());
    await act(async () => {
      await startPromise;
    });

    expect(socket.closeCalls).toEqual([
      { code: 1000, reason: 'Recording startup failed' },
    ]);
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalledTimes(1);
    expect(capture.result.current.isRecording).toBe(false);
    expect(capture.result.current.error).toBe(
      'Could not connect to live transcription.'
    );
  });
});
