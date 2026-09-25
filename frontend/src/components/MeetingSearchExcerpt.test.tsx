import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SavedSession } from '../hooks/useMeetingSessions';
import { MeetingSearchExcerpt } from './MeetingSearchExcerpt';

function meeting(overrides: Partial<SavedSession> = {}): SavedSession {
  return {
    id: 'meeting-1',
    sourceKey: 'text:meeting-1',
    filename: 'Weekly meeting',
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    meetingType: 'general',
    rawText: '',
    cleanedText: '',
    sourceType: 'text',
    notes: '',
    ...overrides,
  };
}

describe('MeetingSearchExcerpt', () => {
  it('renders the match and nearby words from the supplied transcript', () => {
    const rawText =
      'Hello, my name is Matthew Kessis. I love to spend time on the internet\n' +
      'and I Really think that we have an important deadline for January 4th\n' +
      '2005 that we should worry about penis penis';
    const { container } = render(
      <MeetingSearchExcerpt meeting={meeting({ rawText })} query="Really" />
    );
    const excerpt = container.querySelector('div');

    expect(excerpt?.textContent).toContain('Raw transcript ·');
    expect(excerpt?.textContent).toContain(
      'on the internet and I Really think'
    );
    expect(excerpt?.textContent?.length).toBeLessThanOrEqual(100);
  });

  it('shows the matched field and its transcript excerpt', () => {
    render(
      <MeetingSearchExcerpt
        meeting={meeting({ rawText: 'We reviewed the rollout plan.' })}
        query="rollout"
      />
    );

    expect(screen.getByText('Raw transcript ·')).toBeInTheDocument();
    expect(
      screen.getByText('We reviewed the rollout plan.')
    ).toBeInTheDocument();
  });

  it('describes a title-only match without fabricating excerpt text', () => {
    render(
      <MeetingSearchExcerpt
        meeting={meeting({ filename: 'Architecture review' })}
        query="architecture"
      />
    );

    expect(screen.getByText('Title ·')).toBeInTheDocument();
    expect(screen.getByText('Title matched')).toBeInTheDocument();
  });

  it('uses a neutral fallback when a backend match is not locatable', () => {
    render(
      <MeetingSearchExcerpt
        meeting={meeting({ rawText: 'Punctuation: alpha—beta' })}
        query="alpha beta"
      />
    );

    expect(screen.getByText('Matching meeting')).toBeInTheDocument();
    expect(screen.queryByText('Raw transcript ·')).not.toBeInTheDocument();
  });
});
