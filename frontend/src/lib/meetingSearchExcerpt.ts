import type { SavedSession } from '../hooks/useMeetingSessions';

const EXCERPT_MAX_LENGTH = 80;

type MatchRange = { start: number; end: number };

export type MeetingSearchExcerpt = {
  field: 'Raw transcript' | 'Cleaned transcript' | 'Notes' | 'Title' | null;
  text: string;
};

function findExcerpt(
  text: string,
  query: string,
  field: Exclude<MeetingSearchExcerpt['field'], 'Title' | null>
): MeetingSearchExcerpt | null {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const normalizedMatchStart = normalizedText.indexOf(normalizedQuery);
  if (normalizedMatchStart === -1) return null;

  const matchRange = mapLowercaseRangeToOriginalText(
    text,
    normalizedMatchStart,
    normalizedMatchStart + normalizedQuery.length
  );
  if (!matchRange) return null;

  const contextLength = Math.max(
    0,
    Math.floor((EXCERPT_MAX_LENGTH - (matchRange.end - matchRange.start)) / 2)
  );
  const start = Math.max(0, matchRange.start - contextLength);
  const end = Math.min(text.length, start + EXCERPT_MAX_LENGTH);
  const excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim();

  return {
    field,
    text: `${start > 0 ? '…' : ''}${excerpt}${end < text.length ? '…' : ''}`,
  };
}

function mapLowercaseRangeToOriginalText(
  text: string,
  lowercaseStart: number,
  lowercaseEnd: number
): MatchRange | null {
  let originalIndex = 0;
  let lowercaseIndex = 0;
  let matchStart: number | null = null;

  while (originalIndex < text.length) {
    const codePoint = text.codePointAt(originalIndex);
    if (codePoint === undefined) break;

    const character = String.fromCodePoint(codePoint);
    const nextLowercaseIndex = lowercaseIndex + character.toLowerCase().length;
    const nextOriginalIndex = originalIndex + character.length;

    if (
      matchStart === null &&
      lowercaseStart >= lowercaseIndex &&
      lowercaseStart < nextLowercaseIndex
    ) {
      matchStart = originalIndex;
    }

    if (lowercaseEnd <= nextLowercaseIndex) {
      return matchStart === null
        ? null
        : { start: matchStart, end: nextOriginalIndex };
    }

    lowercaseIndex = nextLowercaseIndex;
    originalIndex = nextOriginalIndex;
  }

  return null;
}

export function getMeetingSearchExcerpt(
  meeting: SavedSession,
  searchQuery: string
): MeetingSearchExcerpt {
  const query = searchQuery.trim();
  if (!query) return { field: null, text: 'Matching meeting' };

  const candidates = [
    [meeting.rawText, 'Raw transcript'],
    [meeting.cleanedText, 'Cleaned transcript'],
    [meeting.notes, 'Notes'],
  ] as const;

  for (const [text, field] of candidates) {
    const excerpt = findExcerpt(text, query, field);
    if (excerpt) return excerpt;
  }

  if (meeting.filename.toLowerCase().includes(query.toLowerCase())) {
    return { field: 'Title', text: 'Title matched' };
  }

  return { field: null, text: 'Matching meeting' };
}
