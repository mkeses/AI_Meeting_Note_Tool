import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { RefObject } from 'react';
import { findTranscriptMatches } from '../lib/transcriptFind';
import styles from './TranscriptFind.module.css';

interface TranscriptFindProps {
  value: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function TranscriptFind({ value, textareaRef }: TranscriptFindProps) {
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState({
    value,
    query: '',
    index: -1,
  });
  const matches = useMemo(
    () => findTranscriptMatches(value, query),
    [query, value]
  );
  const activeMatchIndex =
    activeMatch.value === value && activeMatch.query === query
      ? activeMatch.index
      : -1;

  const navigate = (direction: -1 | 1) => {
    if (matches.length === 0) return;

    const nextIndex =
      activeMatchIndex === -1
        ? direction === 1
          ? 0
          : matches.length - 1
        : (activeMatchIndex + direction + matches.length) % matches.length;
    const start = matches[nextIndex];
    const textarea = textareaRef.current;

    if (start === undefined) return;

    setActiveMatch({ value, query, index: nextIndex });
    if (!textarea) return;

    textarea.focus();
    textarea.setSelectionRange(start, start + query.length);
  };

  const resultLabel = !query.trim()
    ? 'Enter text to find'
    : matches.length === 0
      ? 'No matches'
      : activeMatchIndex === -1
        ? `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`
        : `${activeMatchIndex + 1} of ${matches.length}`;

  return (
    <div className={styles.findControl}>
      <label className={styles.findInputWrap}>
        <Search size={14} aria-hidden="true" />
        <span className={styles.visuallyHidden}>Find in transcript</span>
        <input
          className={styles.findInput}
          type="search"
          value={query}
          onChange={(event) => {
            const nextQuery = event.target.value;
            setQuery(nextQuery);
            setActiveMatch({ value, query: nextQuery, index: -1 });
          }}
          placeholder="Find in transcript"
          aria-label="Find in transcript"
        />
      </label>
      <span className={styles.findStatus} aria-live="polite">
        {resultLabel}
      </span>
      <button
        className={styles.findButton}
        type="button"
        onClick={() => navigate(-1)}
        disabled={matches.length === 0}
        aria-label="Previous match"
        title="Previous match"
      >
        <ChevronLeft size={15} aria-hidden="true" />
        <span>Previous</span>
      </button>
      <button
        className={styles.findButton}
        type="button"
        onClick={() => navigate(1)}
        disabled={matches.length === 0}
        aria-label="Next match"
        title="Next match"
      >
        <span>Next</span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
