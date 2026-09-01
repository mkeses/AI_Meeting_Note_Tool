import { describe, expect, it } from 'vitest';
import {
  buildMeetingReportFilename,
  generateMeetingReportPdf,
  parseMeetingSummary,
  toPdfCompatibleText,
  type MeetingReportData,
} from './meetingReportPdf';

const summary = `## Meeting Overview
The team reviewed the rollout plan.

## Key Discussion Points
- The group compared a phased launch and a single release.

## Decisions
- Use a phased rollout.

## Action Items
- Maya | Update the rollout checklist | Friday
- Leo | Share the launch plan | No deadline mentioned

## Open Questions
- Can the support team cover the pilot?

## Blockers / Risks
- The legal review is still pending.

## Important Details
- The pilot starts on October 15.`;

const meeting: MeetingReportData = {
  title: 'Architecture review',
  savedAt: '2026-09-01T12:00:00.000Z',
  meetingType: 'design_review',
  sourceType: 'recording',
  summary,
};

async function readPdfText(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  return new TextDecoder('latin1').decode(bytes);
}

describe('meeting report PDF', () => {
  it('generates a professional PDF containing meeting metadata and sections', async () => {
    const report = await generateMeetingReportPdf(meeting);
    const content = await readPdfText(report.blob);

    expect(report.filename).toBe('architecture-review.pdf');
    expect(report.blob.type).toBe('application/pdf');
    expect(report.pageCount).toBeGreaterThanOrEqual(1);
    expect(content).toContain('Architecture review');
    expect(content).toContain('Meeting type:');
    expect(content).toContain('Design review');
    expect(content).toContain('Audio recording');
    expect(content).toContain('Meeting Overview');
    expect(content).toContain('Key Discussion Points');
    expect(content).toContain('Key Decisions');
    expect(content).toContain('Action Items');
    expect(content).toContain('Open Questions');
    expect(content).toContain('Blockers / Risks');
    expect(content).toContain('Important Details');
  });

  it('renders multiple action items as structured PDF fields', async () => {
    const actionItems = parseMeetingSummary(summary).find(
      (section) => section.title === 'Action Items'
    );
    const report = await generateMeetingReportPdf(meeting);
    const content = await readPdfText(report.blob);

    expect(actionItems?.content).toEqual([
      'Maya | Update the rollout checklist | Friday',
      'Leo | Share the launch plan | No deadline mentioned',
    ]);
    expect(content).toContain('Owner:');
    expect(content).toContain('Maya');
    expect(content).toContain('Update the rollout checklist');
    expect(content).toContain('Leo');
    expect(content).toContain('Share the launch plan');
  });

  it('creates additional pages for long report content', async () => {
    const longOverview = Array.from(
      { length: 240 },
      () => 'The team reviewed a detailed implementation consideration.'
    ).join(' ');
    const report = await generateMeetingReportPdf({
      ...meeting,
      summary: `## Meeting Overview\n${longOverview}`,
    });

    expect(report.pageCount).toBeGreaterThan(1);
    expect(report.blob.size).toBeGreaterThan(0);
  });

  it('renders empty optional sections without failing', async () => {
    const report = await generateMeetingReportPdf({
      ...meeting,
      summary: '## Meeting Overview\nA short update.',
    });
    const content = await readPdfText(report.blob);

    expect(content).toContain('No details recorded.');
  });

  it('normalizes special characters to safe PDF text', async () => {
    const specialText = 'Jos\u00e9 — “ready” \u2713';
    const report = await generateMeetingReportPdf({
      ...meeting,
      title: specialText,
      summary: `## Meeting Overview\n${specialText}`,
    });
    const content = await readPdfText(report.blob);

    expect(toPdfCompatibleText(specialText)).toBe('Jose - "ready" ?');
    expect(content).toContain('Jose - "ready" ?');
    expect(report.blob.size).toBeGreaterThan(0);
  });

  it('creates safe filename slugs from meeting titles', () => {
    expect(buildMeetingReportFilename('Q4 / Architecture: “Review”?')).toBe(
      'q4-architecture-review.pdf'
    );
    expect(buildMeetingReportFilename('   ')).toBe('meeting-report.pdf');
  });
});
