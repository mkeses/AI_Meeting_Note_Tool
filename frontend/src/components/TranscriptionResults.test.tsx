import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
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
  it('finds unsaved transcript edits and navigates with wraparound', () => {
    render(
      <TranscriptionResults
        rawText="Original transcript"
        editedRawText="Edited alpha, alpha!"
        onRawTextChange={vi.fn()}
        onRegenerateCleanup={vi.fn()}
        cleanedText=""
        useLLM={false}
        isCopied={false}
        isCleaningWithLLM={false}
        isProcessing={false}
        onCopy={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Raw Transcript' }));
    const transcript = screen.getByRole('textbox', {
      name: 'Editable raw transcript',
    });
    fireEvent.change(
      screen.getByRole('searchbox', {
        name: 'Find in transcript',
      }),
      { target: { value: 'ALPHA' } }
    );

    expect(screen.getByText('2 matches')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(transcript).toHaveFocus();
    expect(transcript).toHaveValue('Edited alpha, alpha!');
    expect(transcript).toHaveProperty('selectionStart', 7);
    expect(transcript).toHaveProperty('selectionEnd', 12);

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(transcript).toHaveProperty('selectionStart', 14);
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(transcript).toHaveProperty('selectionStart', 7);
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(transcript).toHaveProperty('selectionStart', 14);
  });

  it('handles empty and missing find queries and resets after transcript edits', async () => {
    const props = {
      rawText: 'Saved transcript',
      editedRawText: 'Edited alpha followed by alpha',
      onRawTextChange: vi.fn(),
      onRegenerateCleanup: vi.fn(),
      cleanedText: '',
      useLLM: false,
      isCopied: false,
      isCleaningWithLLM: false,
      isProcessing: false,
      onCopy: vi.fn(),
    } as const;
    const { rerender } = render(<TranscriptionResults {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Raw Transcript' }));
    const findInput = screen.getByRole('searchbox', {
      name: 'Find in transcript',
    });
    expect(screen.getByText('Enter text to find')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled();

    fireEvent.change(findInput, { target: { value: ' ' } });
    expect(screen.getByText('Enter text to find')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled();

    fireEvent.change(findInput, { target: { value: 'missing' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Previous match' })
    ).toBeDisabled();

    fireEvent.change(findInput, { target: { value: 'alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    rerender(
      <TranscriptionResults
        {...props}
        editedRawText="Edited alpha again alpha"
      />
    );

    const transcript = screen.getByRole('textbox', {
      name: 'Editable raw transcript',
    });
    await waitFor(() =>
      expect(screen.getByText('2 matches')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(transcript).toHaveProperty('selectionStart', 19);
  });

  it('clears the find query when the open transcript changes', () => {
    const props = {
      rawText: 'Same transcript',
      editedRawText: 'Same transcript',
      onRawTextChange: vi.fn(),
      onRegenerateCleanup: vi.fn(),
      cleanedText: '',
      useLLM: false,
      isCopied: false,
      isCleaningWithLLM: false,
      isProcessing: false,
      onCopy: vi.fn(),
    } as const;
    const { rerender } = render(
      <TranscriptionResults {...props} transcriptIdentity="meeting-a" />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Raw Transcript' }));
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Find in transcript' }),
      { target: { value: 'same' } }
    );
    expect(screen.getByText('1 match')).toBeInTheDocument();

    rerender(
      <TranscriptionResults {...props} transcriptIdentity="meeting-b" />
    );

    expect(
      screen.getByRole('searchbox', { name: 'Find in transcript' })
    ).toHaveValue('');
    expect(screen.getByText('Enter text to find')).toBeInTheDocument();
  });

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
