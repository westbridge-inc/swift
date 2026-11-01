import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CustomerIdRetired, customerIdRetiredNote } from './CustomerIdRetired';
import { reviewTimeline, timelineLabel, docLabel, isSystemActor } from '@/lib/review-center';

// [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (b) — a DELIBERATE change] Swift no longer keeps customer IDs: the on-file
// panel and its withdraw button are gone (the server refuses an approval and the daily sweep withdraws and deletes each
// ID). A customer ID still shown says there is nothing to decide. The history of IDs filed before still reads in words.

describe('[CHECKLIST-LEGAL (b)] a customer ID in the Review Center', () => {
  it('says there is nothing to decide, and offers no withdraw button', () => {
    expect(customerIdRetiredNote({ docType: 'identity_l2' })).toMatch(/^Swift no longer keeps customer IDs, so there is nothing to decide here\./);
    expect(customerIdRetiredNote({ docType: 'identity_l2' })).toMatch(/a legal or safety hold keeps it until the hold ends/);
    render(<CustomerIdRetired doc={{ docType: 'identity_l2' }} />);
    expect(screen.getByRole('note').textContent).toMatch(/nothing to decide/);
    expect(screen.queryByRole('button', { name: /Withdraw/ })).toBeNull();
  });

  it('partner, driver and rider documents never show it', () => {
    expect(customerIdRetiredNote({ docType: 'national_id' })).toBeNull();
    const { container } = render(<CustomerIdRetired doc={{ docType: 'national_id' }} />);
    expect(container.textContent).toBe('');
  });

  it('the page shows the note under the evidence, and no withdraw flow is left', () => {
    const page = readFileSync(join(__dirname, '../../app/verification/page.tsx'), 'utf8');
    expect(page).toMatch(/<CustomerIdRetired key=\{`cid-\$\{selected\.id\}`\} doc=\{selected\} \/>/);
    expect(page).not.toMatch(/CustomerIdOnFile|withdrawNotice/);
    expect(page).not.toMatch(/Customer IDs are shown deliberately/);
  });

  it('the label in lists is "Customer ID"', () => {
    expect(docLabel('identity_l2')).toBe('Customer ID');
  });
});

describe('the history of IDs filed before the ruling still reads in words', () => {
  it('automatic markers are the system; the intake outcomes claim no review; a hold says why', () => {
    for (const actor of [null, 'validator', 'engine:x', 'auto:id-on-file', 'kyc:auto']) expect(isSystemActor(actor)).toBe(true);
    expect(isSystemActor('reviewer-user-id')).toBe(false);
    expect(timelineLabel('AUDIT CUSTOMER_ID_ON_FILE')).toMatch(/no person reviewed it/);
    const [held] = reviewTimeline([{ at: '2026-10-11T00:00:00Z', actor: 'u1', what: 'AUDIT CUSTOMER_ID_HELD', detail: { reason: 'Held for a person by the automatic checks: TOO_SMALL, STRIKES' } }]);
    expect(held!.label).toBe('Held for a person by the automatic checks: the picture is too small to read; the account is restricted after failed cash payments');
  });
});
