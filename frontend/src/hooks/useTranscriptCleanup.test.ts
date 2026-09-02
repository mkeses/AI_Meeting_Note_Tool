import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranscriptCleanup } from './useTranscriptCleanup';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('useTranscriptCleanup', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the system prompt on mount', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ default_prompt: 'Test prompt' })
    );

    const { result } = renderHook(() =>
      useTranscriptCleanup({ useLLM: true, meetingType: 'general' })
    );

    expect(result.current.isLoadingPrompt).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    expect(result.current.systemPrompt).toBe('Test prompt');
    expect(result.current.defaultSystemPrompt).toBe('Test prompt');
    expect(fetchMock).toHaveBeenCalledWith('/api/system-prompt', {
      credentials: 'include',
    });
  });

  it('does not call /api/clean when useLLM is false', async () => {
    // Mock the system prompt load (always happens on mount)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ default_prompt: 'Test prompt' })
    );

    const { result } = renderHook(() =>
      useTranscriptCleanup({ useLLM: false, meetingType: 'general' })
    );

    // Wait for prompt to load
    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    // Clear the mock so we only check for /api/clean calls
    fetchMock.mockClear();

    let cleaned = '';
    await act(async () => {
      cleaned = await result.current.cleanTranscription('Some text');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cleaned).toBe('');
  });

  it('sends the configured prompt and meeting type when cleaning is requested', async () => {
    // Mock the system prompt load
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ default_prompt: 'Test prompt' })
    );

    const { result } = renderHook(() =>
      useTranscriptCleanup({ useLLM: true, meetingType: 'design_review' })
    );

    // Wait for prompt to load
    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    act(() => {
      result.current.setSystemPrompt('Custom cleanup instructions');
    });

    // Mock the /api/clean call
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, text: 'Cleaned text' })
    );

    let cleaned = '';
    await act(async () => {
      cleaned = await result.current.cleanTranscription('Raw text');
    });

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/clean', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Raw text',
        system_prompt: 'Custom cleanup instructions',
        meeting_type: 'design_review',
      }),
    });

    expect(cleaned).toBe('Cleaned text');
    expect(result.current.isCleaningWithLLM).toBe(false);
  });

  it('handles cleaning errors gracefully', async () => {
    // Mock the system prompt load
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ default_prompt: 'Test prompt' })
    );

    const { result } = renderHook(() =>
      useTranscriptCleanup({ useLLM: true, meetingType: 'general' })
    );

    // Wait for prompt to load
    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    // Mock the /api/clean call to fail
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));

    let cleaned = '';
    await act(async () => {
      cleaned = await result.current.cleanTranscription('Raw text');
    });

    expect(cleaned).toBe('');
    // Error should be set after the failed call
    await waitFor(() => {
      expect(result.current.error).toBeTruthy();
    });
    expect(result.current.error).toMatch(/LLM cleaning failed/);
    expect(result.current.isCleaningWithLLM).toBe(false);
  });

  it('recovers from a system prompt load failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockRejectedValueOnce(new Error('Prompt service unavailable'));

    const { result } = renderHook(() =>
      useTranscriptCleanup({ useLLM: true, meetingType: 'general' })
    );

    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    expect(result.current.systemPrompt).toBe('');
    expect(result.current.defaultSystemPrompt).toBe('');
    expect(result.current.error).toBe(
      'Failed to load system prompt: Prompt service unavailable'
    );
    expect(result.current.isCleaningWithLLM).toBe(false);
  });

  it('clears processing state when the backend reports success false', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ default_prompt: 'Test prompt' })
    );

    const { result } = renderHook(() =>
      useTranscriptCleanup({ useLLM: true, meetingType: 'general' })
    );

    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'Cleanup model unavailable' })
    );

    let cleaned = 'unexpected';
    await act(async () => {
      cleaned = await result.current.cleanTranscription('Raw text');
    });

    expect(cleaned).toBe('');
    expect(result.current.isCleaningWithLLM).toBe(false);
    expect(result.current.error).toBe(
      'LLM cleaning failed. Your transcription is unaffected — check the backend terminal for details.'
    );
  });

  it('does not request cleanup for an empty transcript', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ default_prompt: 'Test prompt' })
    );

    const { result } = renderHook(() =>
      useTranscriptCleanup({ useLLM: true, meetingType: 'general' })
    );

    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    fetchMock.mockClear();

    let cleaned = 'unexpected';
    await act(async () => {
      cleaned = await result.current.cleanTranscription('   ');
    });

    expect(cleaned).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isCleaningWithLLM).toBe(false);
  });

  it('enters and leaves processing state around a successful cleanup', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ default_prompt: 'Test prompt' })
    );

    const { result } = renderHook(() =>
      useTranscriptCleanup({ useLLM: true, meetingType: 'general' })
    );

    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    let resolveCleanup!: (response: Response) => void;
    const cleanupResponse = new Promise<Response>((resolve) => {
      resolveCleanup = resolve;
    });
    fetchMock.mockImplementationOnce(() => cleanupResponse);

    let cleaningPromise!: Promise<string>;
    act(() => {
      cleaningPromise = result.current.cleanTranscription('Raw text');
    });

    expect(result.current.isCleaningWithLLM).toBe(true);

    await act(async () => {
      resolveCleanup(jsonResponse({ success: true, text: 'Cleaned text' }));
      await cleaningPromise;
    });

    expect(result.current.isCleaningWithLLM).toBe(false);
  });

  it('allows cleanup to be regenerated after a previous cleanup completes', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ default_prompt: 'Test prompt' })
    );

    const { result } = renderHook(() =>
      useTranscriptCleanup({ useLLM: true, meetingType: 'general' })
    );

    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, text: 'First cleanup' })
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, text: 'Second cleanup' })
    );

    await act(async () => {
      await result.current.regenerateCleanup('First raw text');
    });
    await act(async () => {
      await result.current.regenerateCleanup('Second raw text');
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/clean',
      expect.objectContaining({
        credentials: 'include',
        body: JSON.stringify({
          text: 'First raw text',
          system_prompt: 'Test prompt',
          meeting_type: 'general',
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/clean',
      expect.objectContaining({
        credentials: 'include',
        body: JSON.stringify({
          text: 'Second raw text',
          system_prompt: 'Test prompt',
          meeting_type: 'general',
        }),
      })
    );
    expect(result.current.isCleaningWithLLM).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('settles an in-flight cleanup safely after unmount', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ default_prompt: 'Test prompt' })
    );

    const { result, unmount } = renderHook(() =>
      useTranscriptCleanup({ useLLM: true, meetingType: 'general' })
    );

    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    let resolveCleanup!: (response: Response) => void;
    const cleanupResponse = new Promise<Response>((resolve) => {
      resolveCleanup = resolve;
    });
    fetchMock.mockImplementationOnce(() => cleanupResponse);

    let cleaningPromise!: Promise<string>;
    act(() => {
      cleaningPromise = result.current.cleanTranscription('Raw text');
    });

    unmount();

    await act(async () => {
      resolveCleanup(jsonResponse({ success: true, text: 'Cleaned text' }));
      await expect(cleaningPromise).resolves.toBe('Cleaned text');
    });

    expect(consoleError).not.toHaveBeenCalled();
  });
});
