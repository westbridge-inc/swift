import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WeeklyFee } from './weekly-fee';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// [FEE-STATUS · owner 25 Oct 2026] The store's Weekly fee page read "Nothing due right now: your next
// bill is 13 Oct 2026" + "Active" on 25 October, and Refresh status showed nothing while or after it
// re-read the fee. The page leads with the API's feeStatus; Refresh status says what it did.

// The owner's store at 16:52Z (STAGING-RUN read-only): ACTIVE, due 14 Oct 00:26Z, two weeks' money received.
const owner = { status: 'ACTIVE', amountDueGyd: 0, nextBillingDate: '2026-10-14T00:26:00Z', payActions: [{ id: 'MMG_CHECKOUT', state: 'off' }, { id: 'CARD', state: 'off' }] };

describe('weekly fee page header and Refresh status [FEE-STATUS]', () => {
  it("leads with the API's words and never says next bill or Active on a passed date", async () => {
    mockApi(() => ({ body: { success: true, data: { ...owner, feeStatus: { state: 'COVERED', headline: 'Week from 13 Oct 2026 already paid', detail: 'Swift applies the payment you already made. Nothing more is due for this week.', date: '2026-10-14T00:26:00.000Z' } } } }));
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    expect((await screen.findByTestId('weekly-fee-status')).textContent).toBe('Week from 13 Oct 2026 already paid');
    expect(document.body.textContent).not.toMatch(/next bill|Nothing due right now|\bActive\b/);
    view.unmount();
  });

  it('an API without feeStatus still never prints a passed date as a next bill', async () => {
    mockApi(() => ({ body: { success: true, data: owner } }));
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    expect((await screen.findByTestId('weekly-fee-status')).textContent).toBe('Nothing to pay for the week from 13 Oct 2026');
    expect(document.body.textContent).not.toMatch(/next bill/i);
    view.unmount();
  });

  it('Refresh status re-reads the fee and says when it last checked', async () => {
    let reads = 0;
    mockApi(() => { reads += 1; return { body: { success: true, data: owner } }; });
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    await screen.findByTestId('weekly-fee-status');
    const before = reads;
    await view.user.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    expect((await screen.findByText(/^Checked at \d{2}:\d{2}$/)).getAttribute('role')).toBe('status');
    view.unmount();
  });

  it('a failed re-read says so and never claims it checked', async () => {
    let fail = false;
    mockApi(() => (fail ? { status: 503, body: { success: false, error: { code: 'UNAVAILABLE', message: 'down' } } } : { body: { success: true, data: owner } }));
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    await screen.findByTestId('weekly-fee-status');
    fail = true;
    await view.user.click(screen.getByRole('button', { name: 'Refresh status' }));
    expect(await screen.findByText('Could not load your weekly fee.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Checked at');
    view.unmount();
  });
});
