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

  it('calls /api/clean when cleaning is requested', async () => {
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

    // Mock the /api/clean call
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, text: 'Cleaned text' })
    );

    let cleaned = '';
    await act(async () => {
      cleaned = await result.current.cleanTranscription('Raw text');
    });

    const cleanRequest = fetchMock.mock.calls.find(
      ([url]) => url === '/api/clean'
    )?.[1];

    expect(cleanRequest).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(cleanRequest?.body).toEqual(expect.stringContaining('Raw text'));

    expect(cleaned).toBe('Cleaned text');
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
  });
});
