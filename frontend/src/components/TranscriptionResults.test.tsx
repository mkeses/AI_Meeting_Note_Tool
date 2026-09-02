import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptionResults } from './TranscriptionResults';

const phaseFourSummary = `## Meeting Overview
The team reviewed the policy addendum.

## Key Discussion Points
- The group considered a remote-work exception.

## Decisions
- No clear decisions recorded

## Action Items
- No action items recorded

## Open Questions
- What scope should an exception cover?

## Blockers / Risks
- The policy deadline is approaching.

## Important Details
- The addendum affects remote-work eligibility.`;

function getSection(title: string) {
  const heading = screen.getByRole('heading', { name: title });
  const section = heading.closest('section');

  if (!section) {
    throw new Error(`Expected ${title} to render in its own section card.`);
  }

  return section;
}

describe('TranscriptionResults', () => {
  it('renders every meeting-intelligence heading in its own section card', () => {
    render(
      <TranscriptionResults
        rawText="The team reviewed the policy addendum."
        editedRawText="The team reviewed the policy addendum."
        onRawTextChange={vi.fn()}
        onRegenerateCleanup={vi.fn()}
        cleanedText={phaseFourSummary}
        useLLM
        isCopied={false}
        isCleaningWithLLM={false}
        isProcessing={false}
        onCopy={vi.fn()}
      />
    );

    expect(
      within(getSection('Meeting Overview')).getByText(
        'The team reviewed the policy addendum.'
      )
    ).toBeInTheDocument();
    expect(
      within(getSection('Key Discussion Points')).getByText(
        'The group considered a remote-work exception.'
      )
    ).toBeInTheDocument();
    expect(
      within(getSection('Key Decisions')).getByText(
        'No clear decisions recorded'
      )
    ).toBeInTheDocument();
    expect(
      within(getSection('Action Items')).getByText('No action items recorded')
    ).toBeInTheDocument();
    expect(
      within(getSection('Open Questions')).getByText(
        'What scope should an exception cover?'
      )
    ).toBeInTheDocument();
    expect(
      within(getSection('Blockers / Risks')).getByText(
        'The policy deadline is approaching.'
      )
    ).toBeInTheDocument();
    expect(
      within(getSection('Important Details')).getByText(
        'The addendum affects remote-work eligibility.'
      )
    ).toBeInTheDocument();
  });
});
