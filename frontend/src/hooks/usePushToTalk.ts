import { useEffect, useRef } from 'react';

interface UsePushToTalkOptions {
  isRecording: boolean;
  isProcessing: boolean;
  startRecording: () => void | Promise<void>;
  stopRecording: () => void;
}

/**
 * Binds the "hold V to record" push-to-talk shortcut.
 * Ignores keydown while the user is typing in an input/textarea/contentEditable,
 * and ignores OS key-repeat events so a held key doesn't retrigger start.
 */
export function usePushToTalk({
  isRecording,
  isProcessing,
  startRecording,
  stopRecording,
}: UsePushToTalkOptions) {
  const isKeyDownRef = useRef(false);

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

      if (!isKeyDownRef.current) {
        // This key-up doesn't correspond to a press we registered as a
        // push-to-talk hold (e.g. it was typed into a text field), so it
        // should not affect the recording state.
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
}
