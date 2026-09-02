import { Loader2, Mic, Square } from 'lucide-react';

import styles from './RecordButton.module.css';
import type { RecordButtonProps } from '../types';

export function RecordButton({
  isRecording,
  isProcessing,
  onStartRecording,
  onStopRecording,
}: RecordButtonProps) {
  const handleClick = () => {
    if (isProcessing) return;

    if (isRecording) {
      onStopRecording();
    } else {
      void onStartRecording();
    }
  };

  const stateLabel = isProcessing
    ? 'Preparing your transcript'
    : isRecording
      ? 'Recording in progress'
      : 'Ready to capture';

  const buttonLabel = isProcessing
    ? 'Processing audio'
    : isRecording
      ? 'Stop recording'
      : 'Start recording';

  return (
    <div className={styles.container}>
      <div className={styles.visual} aria-hidden="true">
        <span className={styles.visualRing} />
        <span className={styles.visualCore}>
          {isProcessing ? (
            <Loader2 className={`${styles.icon} ${styles.spin}`} />
          ) : isRecording ? (
            <Square className={styles.icon} />
          ) : (
            <Mic className={styles.icon} />
          )}
        </span>
      </div>

      <div className={styles.copy}>
        <span className={styles.stateLabel}>{stateLabel}</span>
        <span className={styles.description}>
          {isRecording
            ? 'Desktop audio and microphone are being captured.'
            : isProcessing
              ? 'Transcription and cleanup may take a moment.'
              : 'Capture a meeting from your computer.'}
        </span>
      </div>

      <button
        type="button"
        onClick={handleClick}
        disabled={isProcessing}
        className={`${styles.button} ${
          isRecording ? styles.recording : ''
        } ${isProcessing ? styles.processing : ''}`}
        aria-pressed={isRecording}
        aria-label={buttonLabel}
      >
        {isProcessing
          ? 'Processing…'
          : isRecording
            ? 'Stop recording'
            : 'Start recording'}
      </button>

      <p className={styles.hint}>
        Press <kbd>V</kbd> to start and stop quickly
      </p>
    </div>
  );
}
