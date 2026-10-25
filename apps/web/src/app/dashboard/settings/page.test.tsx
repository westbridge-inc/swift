import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';
import { setSelectedStore } from '@/lib/auth';
import * as vatReport from '@/lib/vat-report';
import * as vendorApi from '@/lib/vendor-api';
import SettingsPage from './page';
import { storeCheckLabel } from './store-check';

// ---------------------------------------------------------------------------
// [GUARDRAILS §7(4)] The settings card names the SELECTED store and says what
// Swift's team actually did. GET /vendor/profile answers
// { id, userId, vendors: [...], myRole }: the store's name, type, city and
// check live on data.vendors[i]. The card used to read them off the top level,
// so it showed no name and always said "Verification pending". Synthetic
// stores only.
// ---------------------------------------------------------------------------

const profile = {
  id: 'owner-1', userId: 'user-1', myRole: 'OWNER',
  vendors: [
    { id: 'store-1', name: 'First Sample Shop', vendorType: 'STORE', city: 'Town A', description: null, isVerified: false, activationValidUntil: null },
    { id: 'store-2', name: 'Second Sample Kitchen', vendorType: 'RESTAURANT', city: 'Town B', description: 'Synthetic test kitchen.', isVerified: true, activationValidUntil: '2999-01-01T00:00:00.000Z' },
  ],
};

function stubReads() {
  vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile as never);
  vi.spyOn(vendorApi, 'getSubscription').mockReturnValue(new Promise(() => {}) as never);
  vi.spyOn(vendorApi, 'getCashSettlements').mockReturnValue(new Promise(() => {}) as never);
  vi.spyOn(vendorApi, 'getHours').mockReturnValue(new Promise(() => {}) as never); vi.spyOn(vatReport, 'getStoreVatStatus').mockReturnValue(new Promise(() => {}) as never); // [STORE-VAT PR4] the VAT report link
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('dashboard settings: the store card', () => {
  it('reads the selected store from data.vendors and says its documents were checked', async () => {
    stubReads();
    setSelectedStore('store-2');
    renderWithQuery(<SettingsPage />);
    expect(await screen.findByRole('heading', { name: 'Second Sample Kitchen' })).toBeTruthy();
    expect(screen.getByText(/Restaurant · Town B · Documents checked by Swift/)).toBeTruthy();
    expect(screen.getByText('Synthetic test kitchen.')).toBeTruthy();
    expect(screen.queryByText(/Verification pending|Verified ✓/)).toBeNull();
  });

  // [REVIEW-F S3-1] "Waiting for Swift" was false for a store that has not uploaded, or was asked for more.
  it('a store not yet checked says so and points to its documents, never that Swift is already checking', async () => {
    stubReads();
    setSelectedStore('store-1');
    renderWithQuery(<SettingsPage />);
    expect(await screen.findByRole('heading', { name: 'First Sample Shop' })).toBeTruthy();
    expect(screen.getByText(/Shop · Town A · Not checked by Swift yet: see your documents in the Swift app/)).toBeTruthy();
    expect(screen.queryByText(/Waiting for Swift/)).toBeNull();
  });

  it('never says "checked" once a checked document has lapsed', () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    expect(storeCheckLabel({ isVerified: true, activationValidUntil: '2026-10-16T11:59:59.000Z' }, now)).toBe('A checked document has expired: renew it in the Swift app');
    expect(storeCheckLabel({ isVerified: true, activationValidUntil: null }, now)).toBe('Documents checked by Swift');
    expect(storeCheckLabel({ isVerified: false, activationValidUntil: '2999-01-01T00:00:00.000Z' }, now)).toBe('Not checked by Swift yet: see your documents in the Swift app');
  });
});

// ---------------------------------------------------------------------------
// [UI-SWEEP U18 / U20 / U46] The Subscription card. The read is owner-only on
// the server (requireVendor OWNER), and the phone shows the card to owners only.
// Every manager, and every owner whose read failed, used to be told "No
// subscription on this store yet". The fee was the LIST rate (weeklyRate), not
// the rate charged; the status printed raw ("PAST_DUE"); the trial line read a
// `trialEndsAt` the server never sends (the column is trialEndDate). Synthetic.
// ---------------------------------------------------------------------------

const subscriptionRow = (over: Record<string, unknown> = {}) => ({
  id: 'sub-1', vendorId: 'store-1', status: 'ACTIVE', weeklyRate: '5000.00', customRate: '3000.00', weeklyFeeGyd: 3000,
  isTrialActive: false, trialEndDate: null, isInGracePeriod: false, gracePeriodEnd: null,
  currentPeriodEnd: '2026-10-20T04:00:00.000Z', nextBillingDate: '2026-10-26T16:00:00.000Z',
  ...over,
});

function stubSettings({ role = 'OWNER', subscription, settlements }: { role?: string; subscription?: () => Promise<unknown>; settlements?: () => Promise<unknown> } = {}) {
  vi.spyOn(vendorApi, 'getProfile').mockResolvedValue({ ...profile, myRole: role } as never);
  const sub = vi.spyOn(vendorApi, 'getSubscription').mockImplementation((subscription ?? (() => new Promise(() => {}))) as never);
  const cash = vi.spyOn(vendorApi, 'getCashSettlements').mockImplementation((settlements ?? (() => Promise.resolve({ unsettled: [], summary: { owed: 0, count: 0 } }))) as never);
  vi.spyOn(vendorApi, 'getHours').mockReturnValue(new Promise(() => {}) as never); vi.spyOn(vatReport, 'getStoreVatStatus').mockReturnValue(new Promise(() => {}) as never); // [STORE-VAT PR4] the VAT report link
  return { sub, cash };
}

const subscriptionCard = async () => (await screen.findByRole('heading', { name: 'Subscription' })).parentElement as HTMLElement;

describe('dashboard settings: the subscription card (U18 / U20 / U46)', () => {
  it('shows the rate this store is charged, never the list rate', async () => {
    stubSettings({ subscription: () => Promise.resolve(subscriptionRow()) });
    setSelectedStore('store-1');
    renderWithQuery(<SettingsPage />);
    const card = await subscriptionCard();
    expect(card.textContent).toContain(`$${(3000).toLocaleString()}/week`);
    expect(card.textContent).not.toContain(`$${(5000).toLocaleString()}`);
    // The next bill is the phone's nextBillingDate, not the period end.
    expect(card.textContent).toContain('next bill 26 Oct 2026');
    expect(card.textContent).toContain('Status: Active');
  });

  it('says the status in words, and shows a trial from the column the server sends', async () => {
    stubSettings({ subscription: () => Promise.resolve(subscriptionRow({ status: 'PAST_DUE' })) });
    setSelectedStore('store-1');
    const { unmount } = renderWithQuery(<SettingsPage />);
    let card = await subscriptionCard();
    expect(card.textContent).toContain('Status: Weekly fee overdue');
    expect(card.textContent).not.toMatch(/PAST_DUE/);
    unmount();
    vi.restoreAllMocks();

    stubSettings({ subscription: () => Promise.resolve(subscriptionRow({ status: 'TRIAL', isTrialActive: true, trialEndDate: '2026-11-02T16:00:00.000Z' })) });
    renderWithQuery(<SettingsPage />);
    card = await subscriptionCard();
    expect(card.textContent).toContain('Status: Free trial');
    expect(card.textContent).toContain(`Trial ends 2 Nov 2026 · then $${(3000).toLocaleString()}/week`);
  });

  it('a failed read is not "no subscription": it says it could not check, and retries', async () => {
    let calls = 0;
    stubSettings({ subscription: () => (++calls === 1 ? Promise.reject(new Error('Server error')) : Promise.resolve(subscriptionRow())) });
    setSelectedStore('store-1');
    const { user } = renderWithQuery(<SettingsPage />);
    expect(await screen.findByText("Couldn't load your subscription.")).toBeTruthy();
    expect(screen.queryByText(/No subscription on this store yet/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await subscriptionCard()).textContent).toContain(`$${(3000).toLocaleString()}/week`);
  });

  it('a manager is never shown an owner-only card, and the owner-only read is never sent', async () => {
    const { sub } = stubSettings({ role: 'MANAGER', subscription: () => Promise.reject(new Error('Forbidden')) });
    setSelectedStore('store-1');
    renderWithQuery(<SettingsPage />);
    expect(await screen.findByRole('heading', { name: 'First Sample Shop' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Subscription' })).toBeNull();
    expect(screen.queryByText(/No subscription on this store yet/)).toBeNull();
    expect(screen.queryByText(/Couldn't load your subscription/)).toBeNull();
    expect(sub).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [UI-SWEEP U03 / U19 / U47 / U66] "You owe riders". The server sends each row
// as { id, orderNumber, amount, status, rider: { name, phone } } (api
// delivery-cash-settlement.service toWire). The card read r.order.orderNumber
// and r.rider.user.firstName, so every row said "#undefined · Rider" (U66). A
// failed read removed the card, which to a store is "no debt" (U19). The words
// were not the phone's (U47). The armed confirmation did not wrap and was cut
// off at 360-390 px (U03; happy-dom has no layout, so the structure is pinned
// here and the width is measured in a real browser for the PR).
// ---------------------------------------------------------------------------

const ledger = (over: Record<string, unknown> = {}) => ({
  unsettled: [
    { id: 'set-1', orderId: 'order-1', orderNumber: 'SW-1001', amount: 500, status: 'PENDING', createdAt: '2026-10-19T10:00:00.000Z', vendor: null, rider: { name: 'Sample Rider', phone: '+5920000001' }, ...over },
  ],
  summary: { owed: 500, count: 1 },
});

describe('dashboard settings: what the store owes riders (U03 / U19 / U47 / U66)', () => {
  it('names the order and the rider from the fields the server sends, in the phone\'s words', async () => {
    stubSettings({ settlements: () => Promise.resolve(ledger()) });
    setSelectedStore('store-1');
    renderWithQuery(<SettingsPage />);
    const heading = await screen.findByRole('heading', { name: 'You owe riders' });
    const card = heading.parentElement as HTMLElement;
    await waitFor(() => expect(card.textContent).toContain('#SW-1001 · Sample Rider'));
    expect(card.textContent).not.toMatch(/undefined/);
    expect(card.textContent).toContain(`Owed now: $${(500).toLocaleString()} across 1 deliveries`);
    expect(within(card).getByRole('button', { name: 'Mark paid' })).toBeTruthy();
    expect(screen.queryByText(/Rider fees owed|Fee handed over/)).toBeNull();
  });

  it('asks before it records a cash payment, names who and how much, and sends the ledger\'s own figure', async () => {
    stubSettings({ settlements: () => Promise.resolve(ledger()) });
    const confirm = vi.spyOn(vendorApi, 'confirmSettlement').mockResolvedValue({} as never);
    setSelectedStore('store-1');
    const { user } = renderWithQuery(<SettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Mark paid' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByText(`Paid $${(500).toLocaleString()} to Sample Rider?`)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Not yet' }));
    expect(screen.queryByText(/Paid .* to Sample Rider\?/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Mark paid' }));
    await user.click(screen.getByRole('button', { name: `Yes, I paid $${(500).toLocaleString()}` }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('set-1', '500'));
  });

  it('the armed confirmation wraps on a narrow phone and its presses are touch-sized', async () => {
    stubSettings({ settlements: () => Promise.resolve(ledger()) });
    setSelectedStore('store-1');
    const { user } = renderWithQuery(<SettingsPage />);
    await user.click(await screen.findByRole('button', { name: 'Mark paid' }));
    const yes = screen.getByRole('button', { name: `Yes, I paid $${(500).toLocaleString()}` });
    const no = screen.getByRole('button', { name: 'Not yet' });
    const group = yes.parentElement as HTMLElement;
    const row = group.parentElement as HTMLElement;
    // The row stacks under 640 px and the confirmation itself may wrap: nothing is cut off.
    expect(row.className.split(' ')).toEqual(expect.arrayContaining(['flex-col', 'sm:flex-row']));
    expect(group.className.split(' ')).toEqual(expect.arrayContaining(['flex-wrap']));
    expect(group.className.split(' ')).not.toContain('shrink-0');
    for (const control of [yes, no]) expect(control.className.split(' ')).toContain('min-h-11');
  });

  it('a rider who already confirmed is said in words; a row the store marked waits on the rider', async () => {
    stubSettings({
      settlements: () => Promise.resolve({
        unsettled: [
          { ...ledger().unsettled[0], status: 'RIDER_CONFIRMED' },
          { ...ledger().unsettled[0], id: 'set-2', orderNumber: 'SW-1002', status: 'STORE_CONFIRMED' },
        ],
        summary: { owed: 1000, count: 2 },
      }),
    });
    setSelectedStore('store-1');
    renderWithQuery(<SettingsPage />);
    expect(await screen.findByText('The rider confirmed receiving it — mark it paid to close it out.')).toBeTruthy();
    expect(screen.getByText('You marked this paid — waiting for the rider to confirm.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Mark paid' })).toHaveLength(1);
  });

  it('a failed read is never "nothing owed": the card says it could not check, and retries', async () => {
    let calls = 0;
    stubSettings({ settlements: () => (++calls === 1 ? Promise.reject(new Error('Server error')) : Promise.resolve(ledger())) });
    setSelectedStore('store-1');
    const { user } = renderWithQuery(<SettingsPage />);
    expect(await screen.findByText("Couldn't load what you owe riders.")).toBeTruthy();
    expect(screen.queryByText(/Nothing owed/)).toBeNull();
    await user.click(screen.getAllByRole('button', { name: 'Try again' }).at(-1)!);
    expect(await screen.findByText(/#SW-1001 · Sample Rider/)).toBeTruthy();
  });

  it('while the read is in flight the card says it is checking, never that nothing is owed', async () => {
    stubSettings({ settlements: () => new Promise(() => {}) });
    setSelectedStore('store-1');
    renderWithQuery(<SettingsPage />);
    expect(await screen.findByText('Checking what you owe riders…')).toBeTruthy();
    expect(screen.queryByText(/Nothing owed/)).toBeNull();
  });

  it('a row it cannot identify makes the ledger unavailable, never partly shown', async () => {
    stubSettings({ settlements: () => Promise.resolve({ unsettled: [{ amount: 500, status: 'PENDING' }], summary: { owed: 500, count: 1 } }) });
    setSelectedStore('store-1');
    renderWithQuery(<SettingsPage />);
    expect(await screen.findByText("Couldn't load what you owe riders.")).toBeTruthy();
    expect(screen.queryByText(/Owed now/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [UI-SWEEP U50] A failed save left its error on screen after a later save
// worked, so "Saved" sat beside an old error.
// ---------------------------------------------------------------------------
describe('dashboard settings: operating hours (U50)', () => {
  it('a save that works clears the last save\'s error', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile as never);
    vi.spyOn(vendorApi, 'getSubscription').mockReturnValue(new Promise(() => {}) as never);
    vi.spyOn(vendorApi, 'getCashSettlements').mockReturnValue(new Promise(() => {}) as never);
    vi.spyOn(vendorApi, 'getHours').mockResolvedValue([{ dayOfWeek: 1, openTime: '08:00', closeTime: '17:00', isClosed: false }] as never);
    vi.spyOn(vatReport, 'getStoreVatStatus').mockReturnValue(new Promise(() => {}) as never); // [STORE-VAT PR4] the VAT report link
    const put = vi.spyOn(vendorApi, 'putHours')
      .mockRejectedValueOnce(new Error('Hours could not be saved'))
      .mockResolvedValue({} as never);
    setSelectedStore('store-1');
    const { user } = renderWithQuery(<SettingsPage />);
    const save = await screen.findByRole('button', { name: 'Save hours' });
    await user.click(save);
    expect(await screen.findByText('Hours could not be saved')).toBeTruthy();
    await user.click(save);
    expect(await screen.findByText(/Saved/)).toBeTruthy();
    expect(screen.queryByText('Hours could not be saved')).toBeNull();
    expect(put).toHaveBeenCalledTimes(2);
  });
});
