import type { jsPDF } from 'jspdf';

export type MeetingReportData = {
  title: string;
  savedAt: string;
  meetingType: 'general' | 'design_review' | 'debug_sync' | 'standup';
  sourceType: 'recording' | 'audio-file' | 'text';
  summary: string;
};

export type MeetingReportSection = {
  title: string;
  content: string[];
};

export type GeneratedMeetingReport = {
  blob: Blob;
  filename: string;
  pageCount: number;
};

const REPORT_SECTIONS = [
  { title: 'Meeting Overview', aliases: ['meeting overview', 'summary'] },
  { title: 'Key Discussion Points', aliases: ['key discussion points'] },
  { title: 'Key Decisions', aliases: ['key decisions', 'decisions'] },
  { title: 'Action Items', aliases: ['action items', 'actions'] },
  { title: 'Open Questions', aliases: ['open questions', 'questions'] },
  { title: 'Blockers / Risks', aliases: ['blockers / risks', 'blockers'] },
  { title: 'Important Details', aliases: ['important details'] },
] as const;

type ReportSectionTitle = (typeof REPORT_SECTIONS)[number]['title'];

const MEETING_TYPE_LABELS = {
  general: 'General',
  design_review: 'Design review',
  debug_sync: 'Debug sync',
  standup: 'Standup',
} as const;

const SOURCE_TYPE_LABELS = {
  recording: 'Audio recording',
  'audio-file': 'Uploaded audio file',
  text: 'Pasted transcript',
} as const;

const PAGE_MARGIN = 48;
const PAGE_FOOTER_HEIGHT = 32;
const BODY_LINE_HEIGHT = 15;
const SECTION_GAP = 12;

function normalizeHeading(line: string) {
  return line
    .replace(/^#+\s*/, '')
    .replace(/:\s*$/, '')
    .trim()
    .toLowerCase();
}

function normalizeContentLine(line: string) {
  return line
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[).]\s+/, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .trim();
}

function findSectionTitle(heading: string): ReportSectionTitle | undefined {
  return REPORT_SECTIONS.find((section) => {
    const aliases: readonly string[] = section.aliases;
    return aliases.includes(heading);
  })?.title;
}

/**
 * Converts the structured Markdown returned by cleanup into report sections.
 * Unknown headings are intentionally ignored so they cannot leak raw content
 * into an unrelated report section.
 */
export function parseMeetingSummary(summary: string): MeetingReportSection[] {
  const sections = new Map<ReportSectionTitle, string[]>(
    REPORT_SECTIONS.map((section) => [section.title, [] as string[]])
  );
  let currentTitle: ReportSectionTitle | undefined;
  let sawKnownHeading = false;

  for (const rawLine of summary.split('\n')) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    if (line.startsWith('#')) {
      currentTitle = findSectionTitle(normalizeHeading(line));
      sawKnownHeading ||= Boolean(currentTitle);
      continue;
    }

    if (currentTitle) {
      const content = normalizeContentLine(line);

      if (content) {
        sections.get(currentTitle)?.push(content);
      }
    }
  }

  if (!sawKnownHeading && summary.trim()) {
    sections.get('Meeting Overview')?.push(
      ...summary
        .split('\n')
        .map((line) => normalizeContentLine(line.trim()))
        .filter(Boolean)
    );
  }

  return REPORT_SECTIONS.map((section) => ({
    title: section.title,
    content: sections.get(section.title) ?? [],
  }));
}

/**
 * Standard PDF fonts do not reliably include every Unicode glyph. Normalize
 * typography and accents to readable equivalents before writing them so a
 * report cannot contain invalid or missing glyph data.
 */
export function toPdfCompatibleText(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/[^\u0020-\u007E]/g, '?');
}

export function buildMeetingReportFilename(title: string): string {
  const safeTitle = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80);

  return `${safeTitle || 'meeting-report'}.pdf`;
}

function formatSavedDate(savedAt: string): string {
  const date = new Date(savedAt);

  if (Number.isNaN(date.getTime())) {
    return savedAt;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function getActionItemParts(item: string) {
  const parts = item.split('|').map((part) => part.trim());

  if (parts.length !== 3) {
    return null;
  }

  const [owner = '', task = '', deadline = ''] = parts;

  if (!owner || !task || !deadline) {
    return null;
  }

  return { owner, task, deadline };
}

function splitPdfText(document: jsPDF, value: string, width: number): string[] {
  const result: unknown = document.splitTextToSize(value, width);

  if (!Array.isArray(result)) {
    return typeof result === 'string' ? [result] : [];
  }

  return result.filter((line): line is string => typeof line === 'string');
}

class PdfLayout {
  private cursorY: number;

  private readonly pageWidth: number;

  private readonly pageHeight: number;

  private readonly contentWidth: number;

  constructor(private readonly document: jsPDF) {
    this.pageWidth = document.internal.pageSize.getWidth();
    this.pageHeight = document.internal.pageSize.getHeight();
    this.contentWidth = this.pageWidth - PAGE_MARGIN * 2;
    this.cursorY = PAGE_MARGIN;
  }

  addTitle(title: string) {
    this.document.setFont('helvetica', 'bold');
    this.document.setFontSize(22);
    this.document.setTextColor(25, 50, 76);
    this.writeWrapped(title, 22, PAGE_MARGIN);
    this.cursorY += 10;
  }

  addMetadata(label: string, value: string) {
    this.document.setFont('helvetica', 'bold');
    this.document.setFontSize(10);
    this.document.setTextColor(68, 87, 105);
    const labelWidth = this.document.getTextWidth(`${label}: `);

    this.ensureSpace(BODY_LINE_HEIGHT);
    this.document.text(`${label}:`, PAGE_MARGIN, this.cursorY);
    this.document.setFont('helvetica', 'normal');
    this.document.setTextColor(38, 53, 68);
    this.writeWrapped(value, BODY_LINE_HEIGHT, PAGE_MARGIN + labelWidth);
  }

  addSection(section: MeetingReportSection) {
    this.cursorY += SECTION_GAP;
    this.ensureSpace(32);
    this.document.setFillColor(237, 244, 250);
    this.document.roundedRect(
      PAGE_MARGIN,
      this.cursorY - 15,
      this.contentWidth,
      24,
      4,
      4,
      'F'
    );
    this.document.setFont('helvetica', 'bold');
    this.document.setFontSize(12);
    this.document.setTextColor(25, 73, 112);
    this.document.text(
      toPdfCompatibleText(section.title),
      PAGE_MARGIN + 10,
      this.cursorY
    );
    this.cursorY += 20;

    if (section.content.length === 0) {
      this.document.setFont('helvetica', 'italic');
      this.document.setFontSize(10);
      this.document.setTextColor(100, 112, 124);
      this.writeWrapped('No details recorded.', BODY_LINE_HEIGHT, PAGE_MARGIN);
      return;
    }

    this.document.setFont('helvetica', 'normal');
    this.document.setFontSize(10.5);
    this.document.setTextColor(38, 53, 68);

    for (const item of section.content) {
      if (section.title === 'Action Items') {
        this.addActionItem(item);
      } else {
        this.addBullet(item);
      }
    }
  }

  addFooter() {
    const pageCount = this.document.getNumberOfPages();

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      this.document.setPage(pageNumber);
      this.document.setDrawColor(214, 223, 232);
      this.document.line(
        PAGE_MARGIN,
        this.pageHeight - PAGE_FOOTER_HEIGHT,
        this.pageWidth - PAGE_MARGIN,
        this.pageHeight - PAGE_FOOTER_HEIGHT
      );
      this.document.setFont('helvetica', 'normal');
      this.document.setFontSize(8);
      this.document.setTextColor(100, 112, 124);
      this.document.text(
        'AI Meeting Note Tool · Local meeting report',
        PAGE_MARGIN,
        this.pageHeight - 16
      );
      this.document.text(
        `Page ${pageNumber} of ${pageCount}`,
        this.pageWidth - PAGE_MARGIN,
        this.pageHeight - 16,
        { align: 'right' }
      );
    }
  }

  private addBullet(item: string) {
    const lines = splitPdfText(
      this.document,
      toPdfCompatibleText(item),
      this.contentWidth - 16
    );

    for (const [index, line] of lines.entries()) {
      this.ensureSpace(BODY_LINE_HEIGHT);
      if (index === 0) {
        this.document.text('-', PAGE_MARGIN, this.cursorY);
      }
      this.document.text(line, PAGE_MARGIN + 16, this.cursorY);
      this.cursorY += BODY_LINE_HEIGHT;
    }

    this.cursorY += 3;
  }

  private addActionItem(item: string) {
    const actionItem = getActionItemParts(item);

    if (!actionItem) {
      this.addBullet(item);
      return;
    }

    this.addLabeledValue('Owner', actionItem.owner, true);
    this.addLabeledValue('Task', actionItem.task);
    this.addLabeledValue('Deadline', actionItem.deadline);
    this.cursorY += 5;
  }

  private addLabeledValue(label: string, value: string, isFirst = false) {
    this.document.setFont('helvetica', 'bold');
    this.document.setFontSize(10);
    const labelWidth = this.document.getTextWidth(`${label}: `);
    const indent = isFirst ? 16 : 28;

    this.ensureSpace(BODY_LINE_HEIGHT);
    if (isFirst) {
      this.document.text('-', PAGE_MARGIN, this.cursorY);
    }
    this.document.text(`${label}:`, PAGE_MARGIN + indent, this.cursorY);
    this.document.setFont('helvetica', 'normal');
    this.writeWrapped(
      value,
      BODY_LINE_HEIGHT,
      PAGE_MARGIN + indent + labelWidth
    );
  }

  private writeWrapped(value: string, lineHeight: number, x: number) {
    const availableWidth = this.pageWidth - PAGE_MARGIN - x;
    const lines = splitPdfText(
      this.document,
      toPdfCompatibleText(value),
      availableWidth
    );

    for (const line of lines) {
      this.ensureSpace(lineHeight);
      this.document.text(line, x, this.cursorY);
      this.cursorY += lineHeight;
    }
  }

  private ensureSpace(height: number) {
    if (this.cursorY + height <= this.pageHeight - PAGE_FOOTER_HEIGHT - 8) {
      return;
    }

    this.document.addPage();
    this.cursorY = PAGE_MARGIN;
  }
}

export async function generateMeetingReportPdf(
  meeting: MeetingReportData
): Promise<GeneratedMeetingReport> {
  const { jsPDF } = await import('jspdf');
  const document = new jsPDF({
    compress: false,
    format: 'a4',
    unit: 'pt',
  });
  const layout = new PdfLayout(document);
  const title = toPdfCompatibleText(meeting.title.trim() || 'Untitled meeting');

  document.setProperties({
    title,
    subject: 'Meeting report',
    author: 'AI Meeting Note Tool',
  });
  layout.addTitle(title);
  layout.addMetadata('Saved', formatSavedDate(meeting.savedAt));
  layout.addMetadata('Meeting type', MEETING_TYPE_LABELS[meeting.meetingType]);
  layout.addMetadata('Source', SOURCE_TYPE_LABELS[meeting.sourceType]);

  for (const section of parseMeetingSummary(meeting.summary)) {
    layout.addSection(section);
  }

  layout.addFooter();

  return {
    blob: document.output('blob'),
    filename: buildMeetingReportFilename(meeting.title),
    pageCount: document.getNumberOfPages(),
  };
}

export function downloadMeetingReportPdf(
  meeting: MeetingReportData
): Promise<void> {
  return generateMeetingReportPdf(meeting).then(({ blob, filename }) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  });
}
