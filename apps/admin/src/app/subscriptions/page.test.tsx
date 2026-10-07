import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SubscriptionsPage from './page';
import { API_ORIGIN, mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

const subscription = {
  id: 'sub-1', status: 'ACTIVE', type: 'RESTAURANT', weeklyRate: 2100, feeWaived: false,
  nextBillingDate: '2026-09-09T00:00:00.000Z', vendor: { id: 'v1', name: 'Shanta Kitchen' },
};

function handler(onWaive: (_r: ApiRequest) => { body: unknown; status?: number } = () => ({ body: { success: true, data: {} } })) {
  return (request: ApiRequest) => {
    if (request.url.pathname === '/api/v1/admin/subscriptions') return { body: { success: true, data: [subscription] } };
    if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/subscriptions/sub-1/waive-fee') return onWaive(request);
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// [MC-MONEY · coordinator ruling under GUARDRAILS] No manual top-up.
//
// A partner pays the weekly fee only through the MMG checkout page, and a
// payment is credited only after the provider's own lookup confirms it. The
// console's "Top up" credited a subscription from an amount and a reference an
// operator typed, so it is gone — not disabled, not hidden behind a flag.
// ---------------------------------------------------------------------------
describe('[MC-MONEY] the console cannot credit a weekly fee', () => {
  it('offers no top-up, says how partners pay, and nothing on the page can send a top-up', async () => {
    const fetchMock = mockApi(handler());
    const { user } = renderWithQuery(<SubscriptionsPage />);
    expect(await screen.findByText('Shanta Kitchen')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /top.?up/i })).toBeNull();
    expect(screen.getByText(/through the\s+MMG checkout page/)).toBeTruthy();
    // every control on the row, pressed: still no top-up request
    for (const button of screen.getAllByRole('button')) await user.click(button);
    const dialog = screen.queryByRole('dialog');
    if (dialog) await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requestsByMethod(fetchMock, 'POST').filter(([u]) => String(u).includes('/topup'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// [A-12] The server requires evidence. A console that satisfies that with a
// constant defeats it entirely — which is exactly what the waiver did, sending
// the literal 'Waived by admin' as the "reason" on every call.
// [MC-MONEY] The reason is asked in the page's own panel.
// ---------------------------------------------------------------------------
describe('[A-12] a waived fee carries the operator’s own words', () => {
  it('sends what the operator typed — never the constant the console used to hard-code — and says it went to a second admin', async () => {
    vi.stubGlobal('prompt', vi.fn(() => { throw new Error('window.prompt was called'); }));
    const reason = 'Outage on 2 Sep — vendor could not trade for three days';
    const fetchMock = mockApi(handler(() => ({ status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this.', details: { approvalId: 'apr_1' } } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    await user.click(await screen.findByRole('button', { name: 'Waive fee for Shanta Kitchen…' }));
    const dialog = screen.getByRole('dialog', { name: "Waive this period's fee for Shanta Kitchen?" });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), reason);
    await user.click(within(dialog).getByRole('button', { name: 'Waive fee' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/subscriptions/sub-1/waive-fee`);
    // the panel sends the reason as the header can carry it: smart punctuation made plain
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Outage on 2 Sep - vendor could not trade for three days' });
    expect(JSON.parse(String(init?.body)).reason).not.toBe('Waived by admin');
    expect((await screen.findByRole('status')).textContent).toContain("Sent for a second admin's approval");
  });

  it('a cancelled, empty or one-word reason waives nothing', async () => {
    for (const answer of [null, '   ', 'ok']) {
      const fetchMock = mockApi(handler());
      const { user, unmount } = renderWithQuery(<SubscriptionsPage />);
      await user.click(await screen.findByRole('button', { name: 'Waive fee for Shanta Kitchen…' }));
      const dialog = screen.getByRole('dialog');
      if (answer === null) {
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      } else {
        await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), answer);
        await user.click(within(dialog).getByRole('button', { name: 'Waive fee' }));
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      }
      expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
      unmount();
    }
  });

  it('a refusal stays in the panel — the old page swallowed it', async () => {
    mockApi(handler(() => ({ status: 409, body: { success: false, error: { code: 'ALREADY_WAIVED', message: 'This period is already waived.' } } })));
    const { user } = renderWithQuery(<SubscriptionsPage />);
    await user.click(await screen.findByRole('button', { name: 'Waive fee for Shanta Kitchen…' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Outage on 2 Sep — vendor could not trade');
    await user.click(within(dialog).getByRole('button', { name: 'Waive fee' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('This period is already waived.');
  });
});
