import { renderHook, waitFor } from '@testing-library/react';
import { useTranscriptCleanup } from './useTranscriptCleanup';

// Mock fetch globally
global.fetch = vi.fn();

describe('useTranscriptCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads the system prompt on mount', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ default_prompt: 'Test prompt' }),
    });

    const { result } = renderHook(() =>
      useTranscriptCleanup({ useLLM: true, meetingType: 'general' })
    );

    expect(result.current.isLoadingPrompt).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    expect(result.current.systemPrompt).toBe('Test prompt');
    expect(result.current.defaultSystemPrompt).toBe('Test prompt');
  });

  it('does not call /api/clean when useLLM is false', async () => {
    // Mock the system prompt load (always happens on mount)
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ default_prompt: 'Test prompt' }),
    });

    const { result } = renderHook(() =>
      useTranscriptCleanup({ useLLM: false, meetingType: 'general' })
    );

    // Wait for prompt to load
    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    // Clear the mock so we only check for /api/clean calls
    vi.clearAllMocks();

    const cleaned = await result.current.cleanTranscription('Some text');

    expect(global.fetch).not.toHaveBeenCalled();
    expect(cleaned).toBe('');
  });

  it('calls /api/clean when cleaning is requested', async () => {
    // Mock the system prompt load
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ default_prompt: 'Test prompt' }),
    });

    const { result } = renderHook(() =>
      useTranscriptCleanup({ useLLM: true, meetingType: 'general' })
    );

    // Wait for prompt to load
    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    // Mock the /api/clean call
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, text: 'Cleaned text' }),
    });

    const cleaned = await result.current.cleanTranscription('Raw text');

    expect(global.fetch).toHaveBeenCalledWith('/api/clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.stringContaining('Raw text'),
    });

    expect(cleaned).toBe('Cleaned text');
  });

  it('handles cleaning errors gracefully', async () => {
    // Mock the system prompt load
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ default_prompt: 'Test prompt' }),
    });

    const { result } = renderHook(() =>
      useTranscriptCleanup({ useLLM: true, meetingType: 'general' })
    );

    // Wait for prompt to load
    await waitFor(() => {
      expect(result.current.isLoadingPrompt).toBe(false);
    });

    // Mock the /api/clean call to fail
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const cleaned = await result.current.cleanTranscription('Raw text');

    expect(cleaned).toBe('');
    // Error should be set after the failed call
    await waitFor(() => {
      expect(result.current.error).toBeTruthy();
    });
    expect(result.current.error).toMatch(/LLM cleaning failed/);
  });
});
