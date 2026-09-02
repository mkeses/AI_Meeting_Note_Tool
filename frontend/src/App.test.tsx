import type { MutableRefObject } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedSession } from './hooks/useMeetingSessions';

type SocketMessageHandler = (event: MessageEvent) => void;

const audioCaptureState = vi.hoisted(() => ({
  onSocketMessage: undefined as SocketMessageHandler | undefined,
}));

const cleanupState = vi.hoisted(() => ({
  cleanTranscription: vi.fn(() => Promise.resolve('')),
  regenerateCleanup: vi.fn(() => Promise.resolve()),
}));

const meetingReportState = vi.hoisted(() => ({
  downloadMeetingReportPdf: vi.fn(() => Promise.resolve()),
}));

const authState = vi.hoisted(() => ({
  value: {
    status: 'local' as 'local' | 'authenticated',
    user: null as { login: string } | null,
    error: null,
    message: null,
    isSubmitting: false,
    login: vi.fn(() => Promise.resolve(true)),
    register: vi.fn(() => Promise.resolve(true)),
    logout: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
    handleUnauthenticated: vi.fn(),
  },
}));

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());

vi.mock('./hooks/useAudioCapture', async () => {
  const React = await import('react');

  return {
    useAudioCapture: () => {
      const [isRecording, setIsRecording] = React.useState(false);

      const startRecording = (
        _liveSocketRef: MutableRefObject<WebSocket | null>,
        _resetLiveState: () => void,
        setSessionFilename: (filename: string) => void,
        setSessionInputType: (type: string) => void,
        recordingSourceKeyRef: MutableRefObject<string | null>,
        onSocketMessage?: SocketMessageHandler
      ) => {
        audioCaptureState.onSocketMessage = onSocketMessage;
        setSessionFilename('recording.webm');
        setSessionInputType('recording');
        recordingSourceKeyRef.current = 'recording:test-source';
        setIsRecording(true);
        return Promise.resolve();
      };

      return {
        isRecording,
        startRecording,
        stopRecording: () => setIsRecording(false),
        getAudioBlob: () => null,
        cleanupAudioCapture: () => Promise.resolve(),
      };
    },
  };
});

vi.mock('./hooks/useTranscriptCleanup', () => ({
  useTranscriptCleanup: () => ({
    systemPrompt: '',
    defaultSystemPrompt: '',
    isLoadingPrompt: false,
    isCleaningWithLLM: false,
    error: null,
    setSystemPrompt: vi.fn(),
    setDefaultSystemPrompt: vi.fn(),
    setIsLoadingPrompt: vi.fn(),
    setIsCleaningWithLLM: vi.fn(),
    setError: vi.fn(),
    cleanTranscription: cleanupState.cleanTranscription,
    regenerateCleanup: cleanupState.regenerateCleanup,
  }),
}));

vi.mock('./lib/meetingReportPdf', () => ({
  downloadMeetingReportPdf: meetingReportState.downloadMeetingReportPdf,
}));

vi.mock('./hooks/useAuth', () => ({
  useAuth: () => authState.value,
}));

import App from './App';

function transcriptMessage(
  committedText: string,
  partialText: string
): MessageEvent<string> {
  return new MessageEvent('message', {
    data: JSON.stringify({
      type: 'transcript',
      committed_text: committedText,
      partial_text: partialText,
    }),
  });
}

function finalTranscriptMessage(text: string): MessageEvent<string> {
  return new MessageEvent('message', {
    data: JSON.stringify({ type: 'final', text }),
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected a JSON request body.');
  }

  const body: unknown = JSON.parse(init.body);

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Expected a JSON object request body.');
  }

  return body as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];

  if (typeof value !== 'string') {
    throw new Error(`Expected ${field} to be a string.`);
  }

  return value;
}

function createSession(overrides: Partial<SavedSession> = {}): SavedSession {
  return {
    id: 'session-1',
    sourceKey: 'source-1',
    filename: 'Architecture review',
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    meetingType: 'design_review',
    rawText: 'Raw transcript',
    cleanedText: 'Cleaned transcript',
    sourceType: 'recording',
    notes: 'Confirm the deployment plan.',
    ...overrides,
  };
}

describe('App live transcript editor', () => {
  beforeEach(() => {
    audioCaptureState.onSocketMessage = undefined;
    cleanupState.cleanTranscription.mockClear();
    cleanupState.regenerateCleanup.mockClear();
    meetingReportState.downloadMeetingReportPdf.mockClear();
    authState.value.status = 'local';
    authState.value.user = null;
    authState.value.logout.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves the focused committed-text selection when live text is appended', async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Start recording' }));

    const textareaCandidate = await screen.findByRole('textbox', {
      name: 'Committed live transcript',
    });

    if (!(textareaCandidate instanceof HTMLTextAreaElement)) {
      throw new Error(
        'Expected the committed transcript editor to be a textarea.'
      );
    }

    const textarea = textareaCandidate;
    const handleSocketMessage = audioCaptureState.onSocketMessage;

    if (!handleSocketMessage) {
      throw new Error(
        'Expected recording to register a socket message handler.'
      );
    }

    act(() => {
      handleSocketMessage(transcriptMessage('alpha beta', ''));
    });

    textarea.focus();
    textarea.setSelectionRange(6, 10);
    await user.keyboard('revised');

    expect(textarea).toHaveValue('alpha revised');

    textarea.setSelectionRange(2, 7);
    fireEvent.select(textarea);

    act(() => {
      handleSocketMessage(transcriptMessage('alpha beta gamma', ''));
    });

    expect(textarea).toHaveValue('alpha revised gamma');
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(7);
  });

  it('restores persisted titles and notes when selecting saved meetings', async () => {
    const user = userEvent.setup();
    const firstSession = createSession();
    const secondSession = createSession({
      id: 'session-2',
      sourceKey: 'source-2',
      filename: 'Standup notes',
      meetingType: 'standup',
      notes: 'Investigate the flaky integration test.',
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse([firstSession, secondSession])
    );

    render(<App />);

    await user.click(
      await screen.findByRole('button', { name: /^architecture review/i })
    );

    expect(screen.getByRole('textbox', { name: 'Meeting title' })).toHaveValue(
      firstSession.filename
    );
    expect(screen.getByRole('textbox', { name: 'Meeting notes' })).toHaveValue(
      firstSession.notes
    );
    expect(screen.getByText('Meeting type: Design review')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^standup notes/i }));

    expect(screen.getByRole('textbox', { name: 'Meeting title' })).toHaveValue(
      secondSession.filename
    );
    expect(screen.getByRole('textbox', { name: 'Meeting notes' })).toHaveValue(
      secondSession.notes
    );
    expect(screen.getByText('Meeting type: Standup')).toBeInTheDocument();
  });

  it('does not render the obsolete saved-notes navigation item', async () => {
    const session = createSession();
    fetchMock.mockResolvedValueOnce(jsonResponse([session]));

    render(<App />);

    await screen.findByRole('button', { name: /^architecture review/i });

    expect(
      screen.queryByRole('button', { name: 'Saved notes' })
    ).not.toBeInTheDocument();
  });

  it('keeps the authenticated workspace shell while hiding capture controls', async () => {
    authState.value.status = 'authenticated';
    authState.value.user = { login: 'matth' };
    const session = createSession();
    fetchMock.mockResolvedValueOnce(jsonResponse([session]));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /^architecture review/i });

    expect(
      screen.getByRole('button', { name: 'New session' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('navigation', { name: 'Workspace' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Current transcript' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Search saved meetings' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Review your meeting' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Meeting workspace' })
    ).toBeInTheDocument();
    expect(screen.getByText('Processing setup')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /^architecture review/i })
    );
    expect(screen.getByRole('textbox', { name: 'Meeting title' })).toHaveValue(
      session.filename
    );
    expect(screen.getByRole('textbox', { name: 'Meeting notes' })).toHaveValue(
      session.notes
    );

    const searchResult = createSession({
      id: 'remote-search-result',
      sourceKey: 'text:remote-search-result',
      filename: 'Remote search result',
      sourceType: 'text',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse([searchResult]));
    const searchInput = screen.getByRole('textbox', {
      name: 'Search saved meetings',
    });
    await user.type(searchInput, 'remote');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('button', { name: /^remote search result/i });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/meetings/search?q=remote',
      { credentials: 'include' }
    );

    expect(
      screen.queryByRole('button', { name: 'Start recording' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Upload audio file' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Use an existing text transcript')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'Include microphone' })
    ).not.toBeInTheDocument();
    expect(screen.getByText('Private workspace')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(authState.value.logout).toHaveBeenCalledOnce();
  });

  it('exports a PDF using the active saved meeting data', async () => {
    const user = userEvent.setup();
    const session = createSession({
      cleanedText: '## Meeting Overview\nThe team agreed on the plan.',
      sourceType: 'text',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse([session]));

    render(<App />);

    await user.click(
      await screen.findByRole('button', { name: /^architecture review/i })
    );
    await user.click(screen.getByRole('button', { name: 'Export PDF' }));

    await waitFor(() => {
      expect(meetingReportState.downloadMeetingReportPdf).toHaveBeenCalledWith({
        title: session.filename,
        savedAt: session.createdAt,
        meetingType: session.meetingType,
        sourceType: session.sourceType,
        summary: session.cleanedText,
      });
    });
  });

  it('persists a changed meeting title through the filename field', async () => {
    const user = userEvent.setup();
    const session = createSession();
    const updatedSession = createSession({
      filename: 'Architecture decisions',
      updatedAt: '2026-09-01T12:05:00.000Z',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse([session]));
    fetchMock.mockResolvedValueOnce(jsonResponse(updatedSession));

    render(<App />);

    await user.click(
      await screen.findByRole('button', { name: /^architecture review/i })
    );
    const title = screen.getByRole('textbox', { name: 'Meeting title' });
    await user.clear(title);
    await user.type(title, updatedSession.filename);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith('/api/meetings/session-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: updatedSession.filename }),
        credentials: 'include',
      });
    });
    expect(title).toHaveValue(updatedSession.filename);
  });

  it('cleans and persists a pasted transcript as a text meeting', async () => {
    const user = userEvent.setup();
    const transcript = 'We decided to launch the pilot next Tuesday.';
    const cleanedText = '## Meeting Overview\nThe pilot launches next Tuesday.';
    let createdSession: SavedSession | null = null;
    cleanupState.cleanTranscription.mockResolvedValueOnce(cleanedText);
    fetchMock.mockImplementation((url, init) => {
      if (
        url === '/api/meetings' &&
        init?.credentials === 'include' &&
        !init.method
      ) {
        return Promise.resolve(jsonResponse([]));
      }

      if (url === '/api/meetings' && init?.method === 'POST') {
        const payload = requestBody(init);
        createdSession = createSession({
          id: requiredString(payload, 'id'),
          sourceKey: requiredString(payload, 'sourceKey'),
          filename: requiredString(payload, 'filename'),
          createdAt: requiredString(payload, 'createdAt'),
          meetingType: 'general',
          rawText: requiredString(payload, 'rawText'),
          cleanedText: requiredString(payload, 'cleanedText'),
          sourceType: 'text',
          notes: '',
        });
        return Promise.resolve(jsonResponse(createdSession, 201));
      }

      throw new Error(`Unexpected request: ${requestUrl(url)}`);
    });

    render(<App />);

    await user.click(screen.getByText('Use an existing text transcript'));
    await user.type(
      screen.getByRole('textbox', { name: 'Text transcript input' }),
      transcript
    );
    await user.click(
      screen.getByRole('button', { name: 'Process transcript' })
    );

    await waitFor(() => {
      expect(cleanupState.cleanTranscription).toHaveBeenCalledWith(transcript);
      expect(createdSession).not.toBeNull();
    });

    expect(
      screen.getByText('The pilot launches next Tuesday.')
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Meeting title' })).toHaveValue(
      'Pasted transcript'
    );

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/meetings' && init?.method === 'POST'
    );
    if (!createCall) {
      throw new Error('Expected the pasted transcript to create a meeting.');
    }

    const payload = requestBody(createCall[1]);
    expect(requiredString(payload, 'sourceKey')).toMatch(/^text:/);
    expect(payload).toMatchObject({
      filename: 'Pasted transcript',
      meetingType: 'general',
      rawText: transcript,
      cleanedText,
      sourceType: 'text',
      notes: '',
    });
  });

  it('keeps a pasted transcript available and reports an unexpected LLM failure', async () => {
    const user = userEvent.setup();
    const transcript = 'The team discussed the pilot timeline.';
    cleanupState.cleanTranscription.mockRejectedValueOnce(
      new Error('LLM unavailable')
    );

    render(<App />);

    await user.click(screen.getByText('Use an existing text transcript'));
    await user.type(
      screen.getByRole('textbox', { name: 'Text transcript input' }),
      transcript
    );
    await user.click(
      screen.getByRole('button', { name: 'Process transcript' })
    );

    expect(
      await screen.findByText('Processing failed: LLM unavailable')
    ).toBeInTheDocument();
    expect(screen.getByText('Transcript ready')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url === '/api/meetings' && init?.method === 'POST'
      )
    ).toBe(false);
  });

  it('debounces rapid note edits into one notes-only PATCH', async () => {
    const session = createSession();
    const updatedSession = createSession({
      notes: 'Local notes edit',
      updatedAt: '2026-09-01T12:05:00.000Z',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse([session]));
    fetchMock.mockResolvedValueOnce(jsonResponse(updatedSession));

    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: /^architecture review/i })
    );
    const notes = screen.getByRole('textbox', { name: 'Meeting notes' });

    vi.useFakeTimers();
    fireEvent.change(notes, { target: { value: 'First local edit' } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(notes, { target: { value: 'Local notes edit' } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(fetchMock).toHaveBeenLastCalledWith('/api/meetings/session-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'Local notes edit' }),
      credentials: 'include',
    });
    expect(notes).toHaveValue('Local notes edit');
  });

  it('preserves edited notes and reports an autosave failure', async () => {
    const session = createSession();
    fetchMock.mockResolvedValueOnce(jsonResponse([session]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'Unavailable' }, 503)
    );

    render(<App />);

    fireEvent.click(
      await screen.findByRole('button', { name: /^architecture review/i })
    );
    const notes = screen.getByRole('textbox', { name: 'Meeting notes' });
    vi.useFakeTimers();
    fireEvent.change(notes, { target: { value: 'Local notes edit' } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(
      screen.getByText('Failed to save notes: Request failed with status 503')
    ).toBeInTheDocument();
    expect(notes).toHaveValue('Local notes edit');
  });

  it('persists a recording meeting before autosaving notes and finalizes it without a second POST', async () => {
    let createdSession: SavedSession | null = null;
    let createdSessionId = '';
    fetchMock.mockImplementation((url, init) => {
      if (
        url === '/api/meetings' &&
        init?.credentials === 'include' &&
        !init.method
      ) {
        return Promise.resolve(jsonResponse([]));
      }

      if (url === '/api/meetings' && init?.method === 'POST') {
        const payload = requestBody(init);
        const id = requiredString(payload, 'id');
        const sourceKey = requiredString(payload, 'sourceKey');
        const createdAt = requiredString(payload, 'createdAt');
        createdSessionId = id;
        createdSession = createSession({
          id,
          sourceKey,
          filename: 'recording.webm',
          createdAt,
          rawText: '',
          cleanedText: '',
          sourceType: 'recording',
          notes: '',
        });
        return Promise.resolve(jsonResponse(createdSession, 201));
      }

      if (init?.method === 'PATCH' && createdSession) {
        const changes = requestBody(init);
        createdSession = {
          ...createdSession,
          rawText:
            typeof changes.rawText === 'string'
              ? changes.rawText
              : createdSession.rawText,
          cleanedText:
            typeof changes.cleanedText === 'string'
              ? changes.cleanedText
              : createdSession.cleanedText,
          notes:
            typeof changes.notes === 'string'
              ? changes.notes
              : createdSession.notes,
          updatedAt: '2026-09-01T12:05:00.000Z',
        };
        return Promise.resolve(jsonResponse(createdSession));
      }

      throw new Error(`Unexpected request: ${requestUrl(url)}`);
    });

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/meetings' && init?.method === 'POST'
      );

      expect(createCall).toBeDefined();
    });
    expect(createdSession).not.toBeNull();

    const notes = screen.getByRole('textbox', { name: 'Meeting notes' });
    vi.useFakeTimers();
    fireEvent.change(notes, {
      target: { value: 'Follow up with the platform team.' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/meetings/${createdSessionId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'Follow up with the platform team.' }),
        credentials: 'include',
      }
    );

    vi.useRealTimers();

    const handleSocketMessage = audioCaptureState.onSocketMessage;
    if (!handleSocketMessage) {
      throw new Error(
        'Expected recording to register a socket message handler.'
      );
    }

    act(() => {
      handleSocketMessage(finalTranscriptMessage('Final recording transcript'));
    });

    await waitFor(() => {
      const finalizationCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === `/api/meetings/${createdSessionId}` &&
          init?.method === 'PATCH' &&
          requestBody(init).rawText === 'Final recording transcript'
      );

      expect(finalizationCall).toBeDefined();
    });
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === '/api/meetings' && init?.method === 'POST'
      )
    ).toHaveLength(1);
  });

  it('deletes an empty recording placeholder when recording stops before transcription', async () => {
    let createdSession: SavedSession | null = null;
    let createdSessionId = '';
    fetchMock.mockImplementation((url, init) => {
      if (
        url === '/api/meetings' &&
        init?.credentials === 'include' &&
        !init.method
      ) {
        return Promise.resolve(jsonResponse([]));
      }

      if (url === '/api/meetings' && init?.method === 'POST') {
        const payload = requestBody(init);
        const id = requiredString(payload, 'id');
        const sourceKey = requiredString(payload, 'sourceKey');
        const createdAt = requiredString(payload, 'createdAt');
        createdSessionId = id;
        createdSession = createSession({
          id,
          sourceKey,
          filename: 'recording.webm',
          createdAt,
          rawText: '',
          cleanedText: '',
          sourceType: 'recording',
          notes: '',
        });
        return Promise.resolve(jsonResponse(createdSession, 201));
      }

      if (init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      throw new Error(`Unexpected request: ${requestUrl(url)}`);
    });

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(createdSession).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/meetings/${createdSessionId}`,
        { method: 'DELETE', credentials: 'include' }
      );
    });
  });

  it('renders backend search results, opens them, and restores history when cleared', async () => {
    const user = userEvent.setup();
    const recentSession = createSession({
      id: 'recent-session',
      sourceKey: 'recording:recent',
      filename: 'Recent meeting',
    });
    const searchResult = createSession({
      id: 'search-session',
      sourceKey: 'text:search',
      filename: 'Architecture review',
      sourceType: 'text',
      notes: 'Review the service boundary.',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse([recentSession]));
    fetchMock.mockResolvedValueOnce(jsonResponse([searchResult]));

    render(<App />);

    expect(
      await screen.findByRole('button', { name: /^recent meeting/i })
    ).toBeInTheDocument();

    const searchInput = screen.getByRole('textbox', {
      name: 'Search saved meetings',
    });
    await user.type(searchInput, 'architecture');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/meetings/search?q=architecture',
        { credentials: 'include' }
      );
    });

    await user.click(
      await screen.findByRole('button', { name: /^architecture review/i })
    );
    expect(screen.getByRole('textbox', { name: 'Meeting title' })).toHaveValue(
      searchResult.filename
    );
    expect(screen.getByRole('textbox', { name: 'Meeting notes' })).toHaveValue(
      searchResult.notes
    );

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(
      screen.getByRole('button', { name: /^recent meeting/i })
    ).toBeInTheDocument();
  });

  it('shows empty and error states for backend meeting searches', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'Unavailable' }, 503)
    );

    render(<App />);

    const searchInput = await screen.findByRole('textbox', {
      name: 'Search saved meetings',
    });
    await user.type(searchInput, 'no matches');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(
      await screen.findByText('No saved meetings match “no matches”.')
    ).toBeInTheDocument();

    await user.clear(searchInput);
    await user.type(searchInput, 'unavailable');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(
      await screen.findByText(
        'Failed to search meetings: Request failed with status 503'
      )
    ).toBeInTheDocument();
  });
});
