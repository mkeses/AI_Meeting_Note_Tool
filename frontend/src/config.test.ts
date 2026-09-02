import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBackendApiUrl, getTranscribeWebSocketUrl } from './config';

describe('getTranscribeWebSocketUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
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

  it('keeps browser REST API paths relative for the Vite proxy', () => {
    expect(getBackendApiUrl('/api/meetings')).toBe('/api/meetings');
  });

  it('uses a configured remote backend origin for browser REST calls', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com/');

    expect(getBackendApiUrl('/api/meetings')).toBe(
      'https://api.example.com/api/meetings'
    );
  });

  it('derives a secure WebSocket endpoint from a configured remote backend', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');

    expect(getTranscribeWebSocketUrl()).toBe(
      'wss://api.example.com/ws/transcribe'
    );
  });

  it('uses Electron runtime backend origin for REST and live transcription', () => {
    vi.stubGlobal('meetingDesktop', {
      backendOrigin: 'http://127.0.0.1:8123',
    });
    vi.stubEnv('VITE_WS_URL', 'wss://ignored.example.com');

    expect(getBackendApiUrl('/api/meetings')).toBe(
      'http://127.0.0.1:8123/api/meetings'
    );
    expect(getTranscribeWebSocketUrl()).toBe(
      'ws://127.0.0.1:8123/ws/transcribe'
    );
  });

  it('converts a secure Electron runtime origin to a secure WebSocket URL', () => {
    vi.stubGlobal('meetingDesktop', {
      backendOrigin: 'https://127.0.0.1:8443',
    });

    expect(getTranscribeWebSocketUrl()).toBe(
      'wss://127.0.0.1:8443/ws/transcribe'
    );
  });
});
