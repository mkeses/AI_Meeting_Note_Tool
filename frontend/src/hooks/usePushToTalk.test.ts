import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePushToTalk } from './usePushToTalk';

function dispatchVKey(
  target: EventTarget,
  type: 'keydown' | 'keyup',
  options: KeyboardEventInit = {}
) {
  const event = new KeyboardEvent(type, {
    key: 'v',
    bubbles: true,
    cancelable: true,
    ...options,
  });

  target.dispatchEvent(event);

  return event;
}

describe('usePushToTalk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('starts recording when V is pressed outside of inputs', () => {
    const startRecording = vi.fn();
    const stopRecording = vi.fn();

    renderHook(() =>
      usePushToTalk({
        isRecording: false,
        isProcessing: false,
        startRecording,
        stopRecording,
      })
    );

    dispatchVKey(window, 'keydown');

    expect(startRecording).toHaveBeenCalledTimes(1);
  });

  it('stops recording when V is released after the recording state rerenders', () => {
    const startRecording = vi.fn();
    const stopRecording = vi.fn();

    const { rerender } = renderHook(
      ({ isRecording }) =>
        usePushToTalk({
          isRecording,
          isProcessing: false,
          startRecording,
          stopRecording,
        }),
      { initialProps: { isRecording: false } }
    );

    act(() => {
      dispatchVKey(window, 'keydown');
    });

    expect(startRecording).toHaveBeenCalledTimes(1);

    rerender({ isRecording: true });

    act(() => {
      dispatchVKey(window, 'keyup');
    });

    expect(stopRecording).toHaveBeenCalledTimes(1);
  });

  it('does not start recording more than once for a held V key', () => {
    const startRecording = vi.fn();
    const stopRecording = vi.fn();

    renderHook(() =>
      usePushToTalk({
        isRecording: false,
        isProcessing: false,
        startRecording,
        stopRecording,
      })
    );

    act(() => {
      dispatchVKey(window, 'keydown');
      dispatchVKey(window, 'keydown', { repeat: true });
      dispatchVKey(window, 'keydown');
    });

    expect(startRecording).toHaveBeenCalledTimes(1);
  });

  it('ignores V key interaction in text entry elements', () => {
    const startRecording = vi.fn();
    const stopRecording = vi.fn();
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const contentEditable = document.createElement('div');
    contentEditable.contentEditable = 'true';
    // jsdom does not implement HTMLElement.isContentEditable, which is the
    // browser property the hook uses to recognize this real editable element.
    Object.defineProperty(contentEditable, 'isContentEditable', {
      value: true,
    });
    document.body.append(input, textarea, contentEditable);

    renderHook(() =>
      usePushToTalk({
        isRecording: false,
        isProcessing: false,
        startRecording,
        stopRecording,
      })
    );

    act(() => {
      for (const target of [input, textarea, contentEditable]) {
        dispatchVKey(target, 'keydown');
        dispatchVKey(target, 'keyup');
      }
    });

    expect(startRecording).not.toHaveBeenCalled();
    expect(stopRecording).not.toHaveBeenCalled();
  });

  it('does not start recording when already recording', () => {
    const startRecording = vi.fn();
    const stopRecording = vi.fn();

    renderHook(() =>
      usePushToTalk({
        isRecording: true,
        isProcessing: false,
        startRecording,
        stopRecording,
      })
    );

    dispatchVKey(window, 'keydown');

    // Should not call startRecording again since already recording
    expect(startRecording).not.toHaveBeenCalled();
  });

  it('does not start recording when processing', () => {
    const startRecording = vi.fn();
    const stopRecording = vi.fn();

    renderHook(() =>
      usePushToTalk({
        isRecording: false,
        isProcessing: true,
        startRecording,
        stopRecording,
      })
    );

    dispatchVKey(window, 'keydown');

    expect(startRecording).not.toHaveBeenCalled();
  });

  it('removes its keyboard listeners when unmounted', () => {
    const startRecording = vi.fn();
    const stopRecording = vi.fn();
    const { unmount } = renderHook(() =>
      usePushToTalk({
        isRecording: false,
        isProcessing: false,
        startRecording,
        stopRecording,
      })
    );

    unmount();

    act(() => {
      dispatchVKey(window, 'keydown');
      dispatchVKey(window, 'keyup');
    });

    expect(startRecording).not.toHaveBeenCalled();
    expect(stopRecording).not.toHaveBeenCalled();
  });
});
