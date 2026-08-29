import { renderHook } from '@testing-library/react';
import { usePushToTalk } from './usePushToTalk';

describe('usePushToTalk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    const keydownEvent = new KeyboardEvent('keydown', { key: 'v' });
    window.dispatchEvent(keydownEvent);

    expect(startRecording).toHaveBeenCalledTimes(1);
  });

  it('stops recording when V is released after pressing', () => {
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

    // First press to start
    const keydownEvent = new KeyboardEvent('keydown', { key: 'v' });
    window.dispatchEvent(keydownEvent);

    // Then release
    const keyupEvent = new KeyboardEvent('keyup', { key: 'v' });
    window.dispatchEvent(keyupEvent);

    expect(stopRecording).toHaveBeenCalledTimes(1);
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

    const keydownEvent = new KeyboardEvent('keydown', { key: 'v' });
    window.dispatchEvent(keydownEvent);

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

    const keydownEvent = new KeyboardEvent('keydown', { key: 'v' });
    window.dispatchEvent(keydownEvent);

    expect(startRecording).not.toHaveBeenCalled();
  });
});
