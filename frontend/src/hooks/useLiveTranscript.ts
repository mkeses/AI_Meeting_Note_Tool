import { useCallback, useRef, useState } from 'react';

interface UseLiveTranscriptOptions {
  processFinalTranscript: (
    finalText: string,
    filename: string
  ) => void | Promise<void>;
  onError: (message: string) => void;
  onProcessingStateChange: (isProcessing: boolean) => void;
}

/**
 * Manages live transcription WebSocket message handling,
 * word-diffing edit protection, and committed/partial text state.
 */
export function useLiveTranscript({
  processFinalTranscript,
  onError,
  onProcessingStateChange,
}: UseLiveTranscriptOptions) {
  const [liveCommittedText, setLiveCommittedText] = useState('');
  const [livePartialText, setLivePartialText] = useState('');
  const [isLiveTranscriptEdited, setIsLiveTranscriptEdited] = useState(false);

  const liveSocketRef = useRef<WebSocket | null>(null);
  const isLiveTranscriptEditedRef = useRef(false);
  const liveUserCommittedTextRef = useRef('');
  const backendCommittedBaselineRef = useRef('');
  const livePartialTextRef = useRef('');

  const normalizeForCompare = (text: string): string => {
    return text.trim().replace(/\s+/g, ' ');
  };

  const joinNonEmpty = (...parts: string[]): string => {
    return parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' ');
  };

  const resetLiveTranscriptState = useCallback(() => {
    isLiveTranscriptEditedRef.current = false;
    liveUserCommittedTextRef.current = '';
    backendCommittedBaselineRef.current = '';
    livePartialTextRef.current = '';

    setIsLiveTranscriptEdited(false);
    setLiveCommittedText('');
    setLivePartialText('');
  }, []);

  const handleSocketMessage = useCallback(
    (event: MessageEvent) => {
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

          onProcessingStateChange(true);

          Promise.resolve(processFinalTranscript(finalText, 'recording.webm'))
            .catch((error: unknown) => {
              console.error(
                'Failed to process final WebSocket transcript:',
                error
              );

              const errorMessage =
                error instanceof Error ? error.message : 'Unknown error';

              onError(`Processing failed: ${errorMessage}`);
            })
            .finally(() => {
              resetLiveTranscriptState();
              onProcessingStateChange(false);
            });
        }
      } catch (error) {
        console.error('Could not parse WebSocket message:', error);
      }
    },
    [
      onError,
      onProcessingStateChange,
      processFinalTranscript,
      resetLiveTranscriptState,
    ]
  );

  const handleLiveTranscriptChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const nextCommittedText = event.currentTarget.value;

      // Marking this ref true synchronously is what protects the user's
      // edit: any WebSocket message handled after this point in the
      // event loop will see isLiveTranscriptEditedRef.current === true
      // and will stop overwriting the committed text directly.
      isLiveTranscriptEditedRef.current = true;
      setIsLiveTranscriptEdited(true);

      liveUserCommittedTextRef.current = nextCommittedText;
      setLiveCommittedText(nextCommittedText);
    },
    []
  );

  return {
    liveCommittedText,
    livePartialText,
    isLiveTranscriptEdited,
    liveSocketRef,
    handleSocketMessage,
    handleLiveTranscriptChange,
    resetLiveTranscriptState,
  };
}
