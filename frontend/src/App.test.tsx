import type { MutableRefObject } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SocketMessageHandler = (event: MessageEvent) => void;

const audioCaptureState = vi.hoisted(() => ({
  onSocketMessage: undefined as SocketMessageHandler | undefined,
}));

const cleanupState = vi.hoisted(() => ({
  cleanTranscription: vi.fn(() => Promise.resolve('')),
  regenerateCleanup: vi.fn(() => Promise.resolve()),
}));

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());

vi.mock('./hooks/useAudioCapture', async () => {
  const React = await import('react');

  return {
    useAudioCapture: () => {
      const [isRecording, setIsRecording] = React.useState(false);

      const startRecording = (
        _liveSocketRef: MutableRefObject<WebSocket | null>,
        _resetLiveState: () => void,
        _setSessionFilename: (filename: string) => void,
        _setSessionInputType: (type: string) => void,
        _recordingSourceKeyRef: MutableRefObject<string | null>,
        onSocketMessage?: SocketMessageHandler
      ) => {
        audioCaptureState.onSocketMessage = onSocketMessage;
        setIsRecording(true);
        return Promise.resolve();
      };

      return {
        isRecording,
        startRecording,
        stopRecording: () => setIsRecording(false),
        getAudioBlob: () => null,
        cleanupAudioCapture: () => Promise.resolve(),
      };
    },
  };
});

vi.mock('./hooks/useTranscriptCleanup', () => ({
  useTranscriptCleanup: () => ({
    systemPrompt: '',
    defaultSystemPrompt: '',
    isLoadingPrompt: false,
    isCleaningWithLLM: false,
    error: null,
    setSystemPrompt: vi.fn(),
    setDefaultSystemPrompt: vi.fn(),
    setIsLoadingPrompt: vi.fn(),
    setIsCleaningWithLLM: vi.fn(),
    setError: vi.fn(),
    cleanTranscription: cleanupState.cleanTranscription,
    regenerateCleanup: cleanupState.regenerateCleanup,
  }),
}));

import App from './App';

function transcriptMessage(
  committedText: string,
  partialText: string
): MessageEvent<string> {
  return new MessageEvent('message', {
    data: JSON.stringify({
      type: 'transcript',
      committed_text: committedText,
      partial_text: partialText,
    }),
  });
}

describe('App live transcript editor', () => {
  beforeEach(() => {
    audioCaptureState.onSocketMessage = undefined;
    cleanupState.cleanTranscription.mockClear();
    cleanupState.regenerateCleanup.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves the focused committed-text selection when live text is appended', async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Start recording' }));

    const textareaCandidate = await screen.findByRole('textbox', {
      name: 'Committed live transcript',
    });

    if (!(textareaCandidate instanceof HTMLTextAreaElement)) {
      throw new Error(
        'Expected the committed transcript editor to be a textarea.'
      );
    }

    const textarea = textareaCandidate;
    const handleSocketMessage = audioCaptureState.onSocketMessage;

    if (!handleSocketMessage) {
      throw new Error(
        'Expected recording to register a socket message handler.'
      );
    }

    act(() => {
      handleSocketMessage(transcriptMessage('alpha beta', ''));
    });

    textarea.focus();
    textarea.setSelectionRange(6, 10);
    await user.keyboard('revised');

    expect(textarea).toHaveValue('alpha revised');

    textarea.setSelectionRange(2, 7);
    fireEvent.select(textarea);

    act(() => {
      handleSocketMessage(transcriptMessage('alpha beta gamma', ''));
    });

    expect(textarea).toHaveValue('alpha revised gamma');
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(7);
  });
});
