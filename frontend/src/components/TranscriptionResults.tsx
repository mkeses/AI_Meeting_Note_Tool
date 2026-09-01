import { useState } from 'react';
import {
  FileText,
  Sparkles,
  Clipboard,
  Check,
  WandSparkles,
  ListCheck,
  CircleHelp,
  CircleCheck,
  Download,
} from 'lucide-react';
import styles from './TranscriptionResults.module.css';
import type { TranscriptionResultsProps } from '../types';
import { TextBox } from './TextBox';
import { Box } from './Box';

type ViewMode = 'summary' | 'transcript';

type ParsedSection = {
  title: string;
  content: string[];
};

const SECTION_ALIASES: Record<string, string> = {
  summary: 'Summary',
  'meeting overview': 'Meeting Overview',
  'key discussion points': 'Key Discussion Points',
  'key decisions': 'Key Decisions',
  decisions: 'Key Decisions',
  'decisions made': 'Key Decisions',
  'action items': 'Action Items',
  actions: 'Action Items',
  blockers: 'Blockers',
  'open questions': 'Open Questions',
  questions: 'Open Questions',
  'blockers / risks': 'Blockers / Risks',
  'important details': 'Important Details',
  'next steps': 'Next Steps',
  'current priorities': 'Current Priorities',
  'progress updates': 'Progress Updates',
  risks: 'Risks',
  'tradeoffs and constraints': 'Tradeoffs and Constraints',
  'design under review': 'Design Under Review',
  'problem being investigated': 'Problem Being Investigated',
  'suspected causes': 'Suspected Causes',
  'evidence and tests run': 'Evidence and Tests Run',
};

function normalizeHeading(line: string) {
  return line
    .replace(/^#+\s*/, '')
    .replace(/^\d+[).\s-]+/, '')
    .replace(/:$/, '')
    .trim()
    .toLowerCase();
}

function parseSummarySections(text: string): ParsedSection[] {
  if (!text.trim()) return [];

  const lines = text.split('\n');
  const sections: ParsedSection[] = [];
  let currentSection: ParsedSection | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const normalized = normalizeHeading(line);
    const matchedTitle = SECTION_ALIASES[normalized];

    if (matchedTitle) {
      currentSection = { title: matchedTitle, content: [] };
      sections.push(currentSection);
      continue;
    }

    if (!currentSection) {
      currentSection = { title: 'Summary', content: [] };
      sections.push(currentSection);
    }

    currentSection.content.push(line);
  }

  return sections.filter((section) => section.content.length > 0);
}

function getSectionIcon(title: string) {
  switch (title) {
    case 'Key Decisions':
      return CircleCheck;
    case 'Action Items':
      return ListCheck;
    case 'Open Questions':
      return CircleHelp;
    default:
      return Sparkles;
  }
}

function renderSectionContent(lines: string[]) {
  const bulletLines = lines.filter(
    (line) =>
      line.startsWith('- ') || line.startsWith('* ') || /^\d+[).\s]/.test(line)
  );

  if (bulletLines.length === lines.length) {
    return (
      <ul className={styles.sectionList}>
        {lines.map((line, index) => (
          <li key={`${line}-${index}`}>
            {line.replace(/^[-*]\s*/, '').replace(/^\d+[).\s]+/, '')}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className={styles.sectionParagraphs}>
      {lines.map((line, index) => (
        <p key={`${line}-${index}`}>{line.replace(/^[-*]\s*/, '')}</p>
      ))}
    </div>
  );
}

function formatSectionsAsMarkdown(sections: ParsedSection[]) {
  if (!sections.length) return '';

  return sections
    .map((section) => {
      const lines = section.content.map((line) => {
        if (line.startsWith('- ') || line.startsWith('* ')) return line;
        if (/^\d+[).\s]/.test(line)) {
          return `- ${line.replace(/^\d+[).\s]+/, '')}`;
        }
        return line;
      });

      return `## ${section.title}\n\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

function downloadMarkdownFile(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function TranscriptionResults({
  rawText,
  editedRawText,
  onRawTextChange,
  onRegenerateCleanup,
  cleanedText,
  useLLM,
  isCopied,
  isCleaningWithLLM,
  isProcessing,
  onCopy,
}: TranscriptionResultsProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('summary');

  if (!isProcessing && !rawText) {
    return null;
  }

  let statusLabel = 'Processing...';

  if (isProcessing && !rawText) {
    statusLabel = 'Transcribing audio...';
  } else if (isCleaningWithLLM) {
    statusLabel = 'Cleaning and structuring notes...';
  } else if (useLLM && cleanedText) {
    statusLabel = 'Meeting summary ready';
  } else if (rawText) {
    statusLabel = 'Transcript ready';
  }

  const summaryText = useLLM ? cleanedText : rawText;
  const parsedSections = summaryText ? parseSummarySections(summaryText) : [];

  const markdownSummary =
    parsedSections.length > 0
      ? formatSectionsAsMarkdown(parsedSections)
      : summaryText || '';

  const handleDownloadMarkdown = () => {
    if (!markdownSummary) return;
    downloadMarkdownFile(markdownSummary, 'meeting-summary.md');
  };

  return (
    <div className={styles.container}>
      <div className={styles.topBar}>
        <div className={styles.statusBlock}>
          <span className={styles.statusDot} />
          <span className={styles.statusText}>{statusLabel}</span>
        </div>

        <div className={styles.segmentedControl}>
          <button
            type="button"
            className={`${styles.segmentButton} ${
              viewMode === 'summary' ? styles.segmentButtonActive : ''
            }`}
            onClick={() => setViewMode('summary')}
          >
            <WandSparkles size={16} />
            <span>Summary</span>
          </button>

          <button
            type="button"
            className={`${styles.segmentButton} ${
              viewMode === 'transcript' ? styles.segmentButtonActive : ''
            }`}
            onClick={() => setViewMode('transcript')}
          >
            <FileText size={16} />
            <span>Raw Transcript</span>
          </button>
        </div>
      </div>

      {viewMode === 'summary' && (
        <Box header={useLLM ? 'Meeting Summary' : 'Transcript'} icon={Sparkles}>
          <div className={styles.summaryHeader}>
            <div>
              <p className={styles.summaryEyebrow}>
                {useLLM
                  ? 'Structured recap optimized for fast review.'
                  : 'Raw transcript available because LLM cleanup is off.'}
              </p>
            </div>

            <div className={styles.actionButtons}>
              {summaryText && (
                <button
                  type="button"
                  className={styles.copyButton}
                  onClick={() => onCopy(summaryText)}
                >
                  {isCopied ? <Check size={16} /> : <Clipboard size={16} />}
                  <span>{isCopied ? 'Copied' : 'Copy'}</span>
                </button>
              )}

              {markdownSummary && (
                <>
                  <button
                    type="button"
                    className={styles.copyButton}
                    onClick={() => onCopy(markdownSummary)}
                  >
                    <Clipboard size={16} />
                    <span>Copy Markdown</span>
                  </button>

                  <button
                    type="button"
                    className={styles.copyButton}
                    onClick={handleDownloadMarkdown}
                  >
                    <Download size={16} />
                    <span>Download .md</span>
                  </button>
                </>
              )}
            </div>
          </div>

          <div className={styles.summaryBody}>
            {summaryText && parsedSections.length > 0 ? (
              <div className={styles.sectionsGrid}>
                {parsedSections.map((section) => {
                  const SectionIcon = getSectionIcon(section.title);

                  return (
                    <section key={section.title} className={styles.sectionCard}>
                      <div className={styles.sectionCardHeader}>
                        <SectionIcon size={18} />
                        <h3>{section.title}</h3>
                      </div>
                      {renderSectionContent(section.content)}
                    </section>
                  );
                })}
              </div>
            ) : (
              <TextBox
                mode="display"
                variant="default"
                value={summaryText || ''}
                isLoading={useLLM ? isCleaningWithLLM : isProcessing}
                maxHeight="420px"
              />
            )}
          </div>
        </Box>
      )}

      {viewMode === 'transcript' && (
        <Box header="Original Transcription" icon={FileText}>
          <div className={styles.summaryHeader}>
            <p className={styles.summaryEyebrow}>
              Verbatim transcript captured before cleanup.
            </p>

            {rawText && (
              <button
                type="button"
                className={styles.copyButton}
                onClick={() => onCopy(rawText)}
              >
                {isCopied ? <Check size={16} /> : <Clipboard size={16} />}
                <span>{isCopied ? 'Copied' : 'Copy'}</span>
              </button>
            )}
          </div>

          <textarea
            className={styles.rawTranscriptEditor}
            value={editedRawText}
            onChange={(event) => onRawTextChange(event.target.value)}
            disabled={isProcessing && !rawText}
            rows={12}
            aria-label="Editable raw transcript"
          />

          <button
            type="button"
            className={styles.copyButton}
            onClick={() => void onRegenerateCleanup()}
            disabled={
              !editedRawText.trim() || isCleaningWithLLM || isProcessing
            }
          >
            <Sparkles size={16} />
            <span>
              {isCleaningWithLLM ? 'Regenerating...' : 'Regenerate cleanup'}
            </span>
          </button>
        </Box>
      )}
    </div>
  );
}
