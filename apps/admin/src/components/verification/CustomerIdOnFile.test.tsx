import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CustomerIdOnFile, customerIdFact } from './CustomerIdOnFile';
import { reviewTimeline, timelineLabel, docLabel } from '@/lib/review-center';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// [Owner ruling 8 Oct 2026 ~23:25 GYT — CUSTOMER ID] A reviewer sees which customer IDs went on file
// with no person (never presented as reviewed), why a held one was held, and can withdraw an ID
// at any time — back to L1.

const onFile = { id: 'cid-1', userId: 'u1', docType: 'identity_l2', role: 'CUSTOMER', status: 'APPROVED' as const, reviewedBy: 'auto:id-on-file' };
const REASON = 'The picture is a screenshot of someone else’s card';

describe('the customer ID panel tells a reviewer what kind of ID this is', () => {
  it('an ID on file is never presented as reviewed; a reviewer-approved one says so', () => {
    expect(customerIdFact(onFile)).toMatch(/No person has reviewed this ID/);
    expect(customerIdFact({ ...onFile, reviewedBy: 'kyc:auto' })).toMatch(/No person has reviewed this ID/);
    expect(customerIdFact({ ...onFile, reviewedBy: 'reviewer-user-id' })).toBe('On file — approved by a reviewer.');
    expect(customerIdFact({ ...onFile, status: 'PENDING', reviewedBy: null })).toMatch(/Held for a person/);
  });

  it('partner, driver and rider documents never show it', () => {
    expect(customerIdFact({ ...onFile, docType: 'national_id' })).toBeNull();
    renderWithQuery(<CustomerIdOnFile doc={{ ...onFile, docType: 'national_id', role: 'MOVER' }} onWithdrawn={() => {}} />);
    expect(screen.queryByRole('button', { name: /Withdraw/ })).toBeNull();
  });

  it('the label in lists is "Customer ID"', () => {
    expect(docLabel('identity_l2')).toBe('Customer ID');
  });
});

describe('withdrawing an ID (back to L1)', () => {
  it('asks why, sends the reason on the revoke route, then reports back', async () => {
    const fetch = mockApi((r) => {
      if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/verification/cid-1/revoke') return { body: { success: true, data: { ...onFile, status: 'REJECTED' } } };
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    const withdrawn = vi.fn();
    const { user } = renderWithQuery(<CustomerIdOnFile doc={onFile} onWithdrawn={withdrawn} />);
    await user.click(screen.getByRole('button', { name: 'Withdraw this ID (back to L1)' }));
    const confirm = screen.getByRole('button', { name: 'Confirm withdrawal' });
    expect(confirm).toHaveProperty('disabled', true);
    await user.type(screen.getByLabelText('Why it is withdrawn'), REASON);
    await user.click(confirm);
    await waitFor(() => expect(withdrawn).toHaveBeenCalledWith(onFile));
    const [[, init]] = requestsByMethod(fetch, 'PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: REASON });
    expect(new Headers(init?.headers).get('x-swift-reason')).toBeTruthy();
  });

  it('a held (pending) ID has no withdraw button — the reviewer approves or rejects it instead', () => {
    renderWithQuery(<CustomerIdOnFile doc={{ ...onFile, status: 'PENDING', reviewedBy: null }} onWithdrawn={() => {}} />);
    expect(screen.queryByRole('button', { name: /Withdraw/ })).toBeNull();
  });
});

describe('the history names the intake outcome in words', () => {
  it('on file claims no review; a hold says why', () => {
    expect(timelineLabel('AUDIT CUSTOMER_ID_ON_FILE')).toMatch(/no person reviewed it/);
    const [held] = reviewTimeline([{ at: '2026-10-11T00:00:00Z', actor: 'u1', what: 'AUDIT CUSTOMER_ID_HELD', detail: { reason: 'Held for a person by the automatic checks: TOO_SMALL, STRIKES' } }]);
    expect(held!.label).toBe('Held for a person by the automatic checks: the picture is too small to read; the account is restricted after failed cash payments');
  });
});

describe('the Review Center shows the panel for the selected document', () => {
  it('page.tsx renders CustomerIdOnFile under the evidence', () => {
    const page = readFileSync(join(__dirname, '../../app/verification/page.tsx'), 'utf8');
    expect(page).toMatch(/<CustomerIdOnFile key=\{`cid-\$\{selected\.id\}`\} doc=\{selected\}/);
  });
});
