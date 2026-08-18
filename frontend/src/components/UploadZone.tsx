import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import { Upload } from 'lucide-react';

import styles from './UploadZone.module.css';
import type { UploadZoneProps } from '../types';

export function UploadZone({
  isProcessing,
  isDragging,
  onFileSelect,
  onDragEnter,
  onDragLeave,
  onDrop,
  fileInputRef,
}: UploadZoneProps) {
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!isProcessing) onDragEnter();
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    onDragLeave();
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    onDragLeave();

    if (isProcessing) return;

    const file = event.dataTransfer.files[0];
    if (file) onDrop(file);
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onFileSelect(file);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isProcessing) return;

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInputRef.current?.click();
    }
  };

  const zoneClassName = [
    styles.zone,
    isDragging ? styles.dragging : '',
    isProcessing ? styles.processing : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={styles.container}>
      <div className={styles.heading}>
        <span className={styles.eyebrow}>Alternative input</span>
        <span className={styles.caption}>Use an existing recording</span>
      </div>

      <div
        className={zoneClassName}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => {
          if (!isProcessing) fileInputRef.current?.click();
        }}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={isProcessing ? -1 : 0}
        aria-disabled={isProcessing}
        aria-label="Upload audio file"
      >
        <span className={styles.iconWrap} aria-hidden="true">
          <Upload className={styles.icon} />
        </span>
        <span className={styles.title}>
          {isProcessing
            ? 'Processing audio'
            : isDragging
              ? 'Drop file to upload'
              : 'Drop an audio file here'}
        </span>
        <span className={styles.subtitle}>
          {isProcessing
            ? 'Please wait until processing is complete.'
            : 'or click to browse your computer'}
        </span>
        <span className={styles.formats}>MP3 · WAV · M4A · WebM · OGG</span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        onChange={handleFileInputChange}
        className={styles.hiddenInput}
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  );
}
