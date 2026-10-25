import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CustomerIdOnFile, customerIdFact, withdrawNotice } from './CustomerIdOnFile';
import { reviewTimeline, timelineLabel, docLabel, isSystemActor } from '@/lib/review-center';
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
    // [Owner ruling 24 Oct 2026 — NO CUSTOMER ID GATE] Taxi rides and big orders need no ID, so approving says
    // what L2 still does and claims no taxi or big-order unlock. [16 Oct] The console never tells staff a
    // customer needs a photo.
    expect(customerIdFact({ ...onFile, status: 'PENDING', reviewedBy: null })).toMatch(/Approving it puts the ID on file \(L2\), which lifts a strike restriction and the high-value promo limit\./);
    expect(customerIdFact({ ...onFile, status: 'PENDING', reviewedBy: null })).not.toMatch(/taxi|big orders/i);
    expect(customerIdFact({ ...onFile, status: 'PENDING', reviewedBy: null })).not.toMatch(/photo|selfie/i);
    // An older approved row that names nobody claims nobody.
    expect(customerIdFact({ ...onFile, reviewedBy: null })).toBe('On file.');
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
  it('asks why, sends the reason on the revoke route, then reports back the level the server gave', async () => {
    const fetch = mockApi((r) => {
      if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/verification/cid-1/revoke') return { body: { success: true, data: { ...onFile, status: 'REJECTED', accountTrustLevel: 'L1' } } };
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    const withdrawn = vi.fn();
    const { user } = renderWithQuery(<CustomerIdOnFile doc={onFile} onWithdrawn={withdrawn} />);
    await user.click(screen.getByRole('button', { name: 'Withdraw this ID' }));
    const confirm = screen.getByRole('button', { name: 'Confirm withdrawal' });
    expect(confirm).toHaveProperty('disabled', true);
    await user.type(screen.getByLabelText('Why it is withdrawn'), REASON);
    await user.click(confirm);
    await waitFor(() => expect(withdrawn).toHaveBeenCalledWith(onFile, 'L1'));
    const [[, init]] = requestsByMethod(fetch, 'PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: REASON });
    expect(new Headers(init?.headers).get('x-swift-reason')).toBeTruthy();
  });

  it('a held (pending) ID has no withdraw button — the reviewer approves or rejects it instead', () => {
    renderWithQuery(<CustomerIdOnFile doc={{ ...onFile, status: 'PENDING', reviewedBy: null }} onWithdrawn={() => {}} />);
    expect(screen.queryByRole('button', { name: /Withdraw/ })).toBeNull();
  });
});

describe('"back to L1" is said only when the server reports it', () => {
  it('L1 from the server; another level; no answer (an older server)', () => {
    expect(withdrawNotice('Ann', 'L1')).toBe('Withdrew the customer ID for Ann. The account is back to L1.');
    expect(withdrawNotice('Ann', 'L2')).toMatch(/still at L2/);
    expect(withdrawNotice('Ann', undefined)).not.toMatch(/back to L1/);
    expect(withdrawNotice('Ann', undefined)).toMatch(/did not report the account level/);
  });
  it('the panel itself never promises L1 before the server answers', () => {
    renderWithQuery(<CustomerIdOnFile doc={onFile} onWithdrawn={() => {}} />);
    expect(screen.getByRole('button', { name: 'Withdraw this ID' })).toBeTruthy();
    expect(screen.queryByText(/back to L1/)).toBeNull();
  });
});

describe('the history never names an automatic marker as a person', () => {
  it('auto:id-on-file and kyc:auto are the system, like the validator and the engines; a real id is a person', () => {
    for (const actor of [null, 'validator', 'engine:x', 'auto:id-on-file', 'kyc:auto']) expect(isSystemActor(actor)).toBe(true);
    expect(isSystemActor('reviewer-user-id')).toBe(false);
    const page = readFileSync(join(__dirname, '../../app/verification/page.tsx'), 'utf8');
    expect(page).toMatch(/const system = isSystemActor\(actor\)/);
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
    expect(page).toMatch(/setNotice\(withdrawNotice\(applicant\.name, accountTrustLevel\)\)/);
    expect(page).not.toMatch(/The account is back to L1/);
  });
});
