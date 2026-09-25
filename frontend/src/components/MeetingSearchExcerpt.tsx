import type { SavedSession } from '../hooks/useMeetingSessions';
import { getMeetingSearchExcerpt } from '../lib/meetingSearchExcerpt';
import styles from './MeetingSearchExcerpt.module.css';

interface MeetingSearchExcerptProps {
  meeting: SavedSession;
  query: string;
}

export function MeetingSearchExcerpt({
  meeting,
  query,
}: MeetingSearchExcerptProps) {
  const excerpt = getMeetingSearchExcerpt(meeting, query);

  return (
    <div className={styles.excerpt}>
      {excerpt.field && (
        <span className={styles.field}>{excerpt.field} · </span>
      )}
      <span>{excerpt.text}</span>
    </div>
  );
}
