import type { ChangeEvent } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLiveTranscript } from './useLiveTranscript';

type ProcessFinalTranscript = (
  finalText: string,
  filename: string
) => void | Promise<void>;

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

function finalMessage(text: string): MessageEvent<string> {
  return new MessageEvent('message', {
    data: JSON.stringify({ type: 'final', text }),
  });
}

function transcriptChange(value: string): ChangeEvent<HTMLTextAreaElement> {
  const textarea = document.createElement('textarea');
  textarea.value = value;

  return { currentTarget: textarea } as ChangeEvent<HTMLTextAreaElement>;
}

function renderLiveTranscript(
  processFinalTranscript = vi.fn<ProcessFinalTranscript>(),
  onError = vi.fn<(message: string) => void>(),
  onProcessingStateChange = vi.fn<(isProcessing: boolean) => void>()
) {
  const hook = renderHook(() =>
    useLiveTranscript({
      processFinalTranscript,
      onError,
      onProcessingStateChange,
    })
  );

  return {
    ...hook,
    onError,
    onProcessingStateChange,
    processFinalTranscript,
  };
}

describe('useLiveTranscript', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates committed and provisional text from live transcript messages', () => {
    const { result } = renderLiveTranscript();

    act(() => {
      result.current.handleSocketMessage(
        transcriptMessage('First sentence', 'in progress')
      );
    });

    expect(result.current.liveCommittedText).toBe('First sentence');
    expect(result.current.livePartialText).toBe('in progress');
    expect(result.current.isLiveTranscriptEdited).toBe(false);

    act(() => {
      result.current.handleSocketMessage(
        transcriptMessage('First sentence complete', 'next thought')
      );
    });

    expect(result.current.liveCommittedText).toBe('First sentence complete');
    expect(result.current.livePartialText).toBe('next thought');
  });

  it('preserves a user edit and appends only a later backend suffix', () => {
    const { result } = renderLiveTranscript();

    act(() => {
      result.current.handleSocketMessage(
        transcriptMessage('alpha beta', 'draft')
      );
      result.current.handleLiveTranscriptChange(
        transcriptChange('alpha revised')
      );
      result.current.handleSocketMessage(
        transcriptMessage('alpha beta gamma', 'new draft')
      );
    });

    expect(result.current.isLiveTranscriptEdited).toBe(true);
    expect(result.current.liveCommittedText).toBe('alpha revised gamma');
    expect(result.current.livePartialText).toBe('new draft');

    act(() => {
      result.current.handleSocketMessage(
        transcriptMessage('alpha beta gamma', 'replacement partial')
      );
      result.current.handleSocketMessage(
        transcriptMessage('alpha beta', 'shorter partial')
      );
    });

    expect(result.current.liveCommittedText).toBe('alpha revised gamma');
    expect(result.current.livePartialText).toBe('shorter partial');
  });

  it('uses the backend final text when the committed transcript was not edited', async () => {
    const processFinalTranscript = vi.fn<ProcessFinalTranscript>();
    const { onProcessingStateChange, result } = renderLiveTranscript(
      processFinalTranscript
    );

    act(() => {
      result.current.handleSocketMessage(
        finalMessage('Backend final transcript')
      );
    });

    expect(onProcessingStateChange).toHaveBeenCalledWith(true);

    await waitFor(() => {
      expect(processFinalTranscript).toHaveBeenCalledWith(
        'Backend final transcript',
        'recording.webm'
      );
      expect(result.current.liveCommittedText).toBe('');
      expect(result.current.livePartialText).toBe('');
    });

    expect(onProcessingStateChange).toHaveBeenLastCalledWith(false);
  });

  it('uses edited committed text and the latest partial text for a final message', async () => {
    const processFinalTranscript = vi.fn<ProcessFinalTranscript>();
    const { result } = renderLiveTranscript(processFinalTranscript);

    act(() => {
      result.current.handleSocketMessage(
        transcriptMessage('original words', 'draft ending')
      );
      result.current.handleLiveTranscriptChange(
        transcriptChange('edited words')
      );
      result.current.handleSocketMessage(
        finalMessage('Backend final transcript')
      );
    });

    await waitFor(() => {
      expect(processFinalTranscript).toHaveBeenCalledWith(
        'edited words draft ending',
        'recording.webm'
      );
      expect(result.current.liveCommittedText).toBe('');
      expect(result.current.livePartialText).toBe('');
    });
  });

  it('ignores malformed, binary, and unknown WebSocket messages without changing state', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const { onError, onProcessingStateChange, processFinalTranscript, result } =
      renderLiveTranscript();

    act(() => {
      result.current.handleSocketMessage(
        new MessageEvent('message', { data: 'not valid JSON' })
      );
      result.current.handleSocketMessage(
        new MessageEvent('message', { data: new ArrayBuffer(0) })
      );
      result.current.handleSocketMessage(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'ready' }),
        })
      );
    });

    expect(result.current.liveCommittedText).toBe('');
    expect(result.current.livePartialText).toBe('');
    expect(processFinalTranscript).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onProcessingStateChange).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });
});
