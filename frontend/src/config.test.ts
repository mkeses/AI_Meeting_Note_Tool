import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTranscribeWebSocketUrl } from './config';

describe('getTranscribeWebSocketUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses a configured secure WebSocket transcription endpoint', () => {
    vi.stubEnv('VITE_WS_URL', 'wss://api.example.com/ws/transcribe');

    expect(getTranscribeWebSocketUrl()).toBe(
      'wss://api.example.com/ws/transcribe'
    );
  });

  it('appends the transcription path to a configured WebSocket base URL', () => {
    vi.stubEnv('VITE_WS_URL', 'ws://transcription.example.com/api');

    expect(getTranscribeWebSocketUrl()).toBe(
      'ws://transcription.example.com/api/ws/transcribe'
    );
  });

  it('uses the local fallback when no WebSocket URL is configured', () => {
    vi.stubEnv('VITE_WS_URL', '');
    vi.stubEnv('VITE_BACKEND_PORT', '8123');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';

    expect(getTranscribeWebSocketUrl()).toBe(
      `${protocol}://${window.location.hostname}:8123/ws/transcribe`
    );
  });
});
