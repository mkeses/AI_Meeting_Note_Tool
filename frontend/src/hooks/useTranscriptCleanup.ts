import { useCallback, useEffect, useState } from 'react';
import { fetchApi } from '../api';

interface UseTranscriptCleanupOptions {
  useLLM: boolean;
  meetingType: string;
}

/**
 * Manages LLM-based transcript cleanup: loading the system prompt,
 * calling the /api/clean endpoint, and regenerating cleanup on demand.
 */
export function useTranscriptCleanup({
  useLLM,
  meetingType,
}: UseTranscriptCleanupOptions) {
  const [systemPrompt, setSystemPrompt] = useState('');
  const [defaultSystemPrompt, setDefaultSystemPrompt] = useState('');
  const [isLoadingPrompt, setIsLoadingPrompt] = useState(true);
  const [isCleaningWithLLM, setIsCleaningWithLLM] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const loadPrompt = async () => {
      try {
        const response = await fetchApi('/api/system-prompt');

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const data = (await response.json()) as { default_prompt: string };

        if (mounted) {
          setSystemPrompt(data.default_prompt);
          setDefaultSystemPrompt(data.default_prompt);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('Failed to load system prompt:', err);

        if (mounted) {
          setError(`Failed to load system prompt: ${message}`);
        }
      } finally {
        if (mounted) {
          setIsLoadingPrompt(false);
        }
      }
    };

    void loadPrompt();

    return () => {
      mounted = false;
    };
  }, []);

  const cleanTranscription = useCallback(
    async (text: string): Promise<string> => {
      if (!useLLM || !text.trim()) {
        setIsCleaningWithLLM(false);
        return '';
      }

      setIsCleaningWithLLM(true);

      try {
        const response = await fetchApi('/api/clean', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            ...(systemPrompt.trim() ? { system_prompt: systemPrompt } : {}),
            meeting_type: meetingType,
          }),
        });

        if (!response.ok) {
          throw new Error(`Cleaning failed with status ${response.status}`);
        }

        const data = (await response.json()) as {
          success: boolean;
          text?: string;
          error?: string;
        };

        if (!data.success) {
          throw new Error(
            data.error || 'The backend rejected the cleaning request'
          );
        }

        const cleaned = data.text || '';
        return cleaned;
      } catch (err) {
        console.error('LLM cleaning failed:', err);
        setError(
          'LLM cleaning failed. Your transcription is unaffected — check the backend terminal for details.'
        );
        return '';
      } finally {
        setIsCleaningWithLLM(false);
      }
    },
    [meetingType, systemPrompt, useLLM]
  );

  const regenerateCleanup = useCallback(
    async (editedRawText: string): Promise<void> => {
      if (!editedRawText.trim() || isCleaningWithLLM) {
        return;
      }

      setError(null);
      await cleanTranscription(editedRawText);
    },
    [cleanTranscription, isCleaningWithLLM]
  );

  return {
    systemPrompt,
    defaultSystemPrompt,
    isLoadingPrompt,
    isCleaningWithLLM,
    error,
    setSystemPrompt,
    setDefaultSystemPrompt,
    setIsLoadingPrompt,
    setIsCleaningWithLLM,
    setError,
    cleanTranscription,
    regenerateCleanup,
  };
}
