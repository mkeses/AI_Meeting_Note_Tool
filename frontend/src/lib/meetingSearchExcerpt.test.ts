import { describe, expect, it } from 'vitest';
import type { SavedSession } from '../hooks/useMeetingSessions';
import { getMeetingSearchExcerpt } from './meetingSearchExcerpt';

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

describe('getMeetingSearchExcerpt', () => {
  it('centers a short excerpt on a match in the supplied transcript', () => {
    const rawText =
      'Hello, my name is Matthew Kessis. I love to spend time on the internet\n' +
      'and I Really think that we have an important deadline for January 4th\n' +
      '2005 that we should worry about penis penis';
    const excerpt = getMeetingSearchExcerpt(meeting({ rawText }), 'Really');

    expect(excerpt.field).toBe('Raw transcript');
    expect(excerpt.text).toContain('on the internet and I Really think');
    expect(excerpt.text.length).toBeLessThanOrEqual(82);
  });

  it('keeps a late match aligned in a long transcript', () => {
    const rawText = `${'Earlier İ\n  '.repeat(100)}The MiXeD Needle appears after the whitespace.`;
    const excerpt = getMeetingSearchExcerpt(
      meeting({ rawText }),
      'mixed needle'
    );

    expect(excerpt.field).toBe('Raw transcript');
    expect(excerpt.text).toContain('The MiXeD Needle appears');
  });

  it('keeps surrounding words when line breaks and repeated spaces precede a match', () => {
    const rawText = `${'Earlier line\n   '.repeat(40)}Context before the selected phrase continues afterward.`;
    const excerpt = getMeetingSearchExcerpt(
      meeting({ rawText }),
      'selected phrase'
    );

    expect(excerpt.text).toContain('Context before the selected phrase');
    expect(excerpt.text).toContain('continues afterward.');
  });

  it('locates mixed-case text while keeping the original context', () => {
    const rawText = `${'Previous discussion. '.repeat(30)}Decision: MiXeD Search Term was approved.`;
    const excerpt = getMeetingSearchExcerpt(
      meeting({ rawText }),
      'mixed search term'
    );

    expect(excerpt.text).toContain('Decision: MiXeD Search Term was approved.');
  });

  it('uses a bounded excerpt from the first matching text field', () => {
    const longRawText = `${'context '.repeat(50)}Important decision${' more '.repeat(50)}`;
    const excerpt = getMeetingSearchExcerpt(
      meeting({
        rawText: longRawText,
        cleanedText: 'Important decision in recap',
        notes: 'Important decision in notes',
      }),
      'important decision'
    );

    expect(excerpt.field).toBe('Raw transcript');
    expect(excerpt.text).toContain('Important decision');
    expect(excerpt.text.length).toBeLessThanOrEqual(182);
  });

  it('labels a title-only match without inventing a passage', () => {
    expect(
      getMeetingSearchExcerpt(
        meeting({ filename: 'Architecture planning' }),
        'architecture'
      )
    ).toEqual({ field: 'Title', text: 'Title matched' });
  });

  it('uses a truthful fallback when backend matching cannot be located', () => {
    expect(
      getMeetingSearchExcerpt(
        meeting({
          filename: 'A punctuation-heavy title',
          rawText: 'alpha—beta gamma',
          cleanedText: 'A recap without the exact phrase',
          notes: 'More context',
        }),
        'alpha beta'
      )
    ).toEqual({ field: null, text: 'Matching meeting' });
  });
});
