import { useState } from 'react';
import { FileText } from 'lucide-react';

import styles from './TextInputZone.module.css';
import type { TextInputZoneProps } from '../types';
import { Box } from './Box';
import { TextBox } from './TextBox';

export function TextInputZone({
  isProcessing,
  onTextSubmit,
}: TextInputZoneProps) {
  const [inputText, setInputText] = useState('');
  const isDisabled = isProcessing || !inputText.trim();

  const handleSubmit = async () => {
    if (isDisabled) return;

    await onTextSubmit(inputText.trim());
    setInputText('');
  };

  return (
    <div className={styles.container}>
      <Box header="Paste text transcript" icon={FileText}>
        <div className={styles.intro}>
          Paste a transcript from another source and run the same engineering
          cleanup workflow.
        </div>

        <TextBox
          mode="input"
          variant="default"
          value={inputText}
          onChange={setInputText}
          placeholder="Paste your transcript here…"
          isDisabled={isProcessing}
          rows={7}
          ariaLabel="Text transcript input"
        />

        <div className={styles.footer}>
          <span className={styles.helperText}>
            {inputText.length > 0
              ? `${inputText.length} characters`
              : 'Text stays in this session'}
          </span>

          <button
            className={styles.button}
            onClick={() => void handleSubmit()}
            disabled={isDisabled}
            type="button"
          >
            {isProcessing ? 'Processing…' : 'Process transcript'}
          </button>
        </div>
      </Box>
    </div>
  );
}
