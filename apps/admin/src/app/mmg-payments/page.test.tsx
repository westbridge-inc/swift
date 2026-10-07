import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MMG_CHECKOUT_CREDITED_PERIOD_KEYS,
  MMG_CHECKOUT_SUPPORT_DETAIL_KEYS,
  MMG_CHECKOUT_SUPPORT_PARTNER_KEYS,
  MMG_CHECKOUT_SUPPORT_ROW_KEYS,
  MMG_CHECKOUT_TIMELINE_KEYS,
  type MmgCheckoutSupportDetail,
  type MmgCheckoutSupportRow,
} from '@swift/types';
import MmgPaymentsPage from './page';
import { API_ORIGIN, mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [MMG support lookup] The console's MMG payments page, against the API's own
// contract: the fixtures below are built from, and checked against, the key
// lists in @swift/types that the API test asserts its real answers carry. The
// page finds a payment by any id, shows only what the server answered (never a
// row drawn before it arrives, and an error as an error), and opens one
// payment with its timeline and credited period.
// ---------------------------------------------------------------------------

const PATH = '/api/v1/admin/billing/mmg-checkouts';
const confirmed: MmgCheckoutSupportRow = {
  id: 'co_confirmed', swiftReference: '175933829900012345', mmgTransactionId: '20402048536279', mmgTransactionReference: '20402048601581',
  amount: 2100, currencyCode: 'GYD', status: 'CONFIRMED', platform: 'ios',
  partner: { kind: 'VENDOR', displayName: 'Shanta Kitchen', maskedPhone: '+592•••••1234', subscriptionId: 'sub_store_1' },
  createdAt: '2026-10-01T19:38:19.000Z', replyAt: '2026-10-01T19:39:40.000Z', confirmedAt: '2026-10-01T19:39:42.000Z', reason: null, matchedBy: [],
};
const held: MmgCheckoutSupportRow = {
  id: 'co_held', swiftReference: '175933840000054321', mmgTransactionId: null, mmgTransactionReference: '20402048609999',
  amount: 6000, currencyCode: 'GYD', status: 'HELD', platform: 'android',
  partner: { kind: 'RIDER', displayName: 'Devon Persaud', maskedPhone: '+592•••••7788', subscriptionId: 'sub_rider_1' },
  createdAt: '2026-10-01T18:10:00.000Z', replyAt: '2026-10-01T18:11:00.000Z', confirmedAt: null, reason: 'AMOUNT_MISMATCH', matchedBy: [],
};
/** A row as the detail route carries it: everything but matchedBy. */
const withoutMatch = (row: MmgCheckoutSupportRow): Omit<MmgCheckoutSupportRow, 'matchedBy'> => {
  const base: Partial<MmgCheckoutSupportRow> = { ...row };
  delete base.matchedBy;
  return base as Omit<MmgCheckoutSupportRow, 'matchedBy'>;
};
const confirmedBase = withoutMatch(confirmed);
const detailOf = (row: MmgCheckoutSupportRow, extra: Partial<MmgCheckoutSupportDetail> = {}): MmgCheckoutSupportDetail =>
  ({ ...withoutMatch(row), timeline: [], timelineTruncated: false, creditedPeriod: null, ...extra });
const confirmedDetail: MmgCheckoutSupportDetail = {
  ...confirmedBase,
  timeline: [
    { at: '2026-10-01T19:39:40.000Z', source: 'RETURN', resultCode: '0', transactionStatus: null, mmgTransactionId: '20402048536279', mmgTransactionReference: null, amount: null, currency: null, windowCheck: 'INSIDE', failure: null },
    { at: '2026-10-01T19:39:41.000Z', source: 'LOOKUP', resultCode: null, transactionStatus: 'successful', mmgTransactionId: '20402048536279', mmgTransactionReference: '20402048601581', amount: '2100', currency: 'GYD', windowCheck: null, failure: null },
    { at: '2026-10-01T19:39:42.000Z', source: 'HISTORY', resultCode: null, transactionStatus: 'completed', mmgTransactionId: '20402048536279', mmgTransactionReference: null, amount: '2100', currency: 'GYD', windowCheck: 'INSIDE', failure: null },
  ],
  timelineTruncated: false,
  creditedPeriod: { state: 'APPLIED', periodStart: '2026-09-30T12:00:00.000Z', periodEnd: '2026-10-07T12:00:00.000Z', receiptNumber: 'SWF-SWIFT-2026-000123' },
};
const page = (data: MmgCheckoutSupportRow[], nextCursor: string | null = null) => ({ body: { success: true, data, nextCursor } });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'short', year: 'numeric' });
const listCalls = (fetchMock: ReturnType<typeof mockApi>) => fetchMock.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.pathname === PATH);

afterEach(() => vi.unstubAllGlobals());

describe('the fixtures are the API contract', () => {
  it('rows, partners, details, timeline entries and the credited period carry exactly the contract keys', () => {
    for (const row of [confirmed, held]) {
      expect(Object.keys(row).sort()).toEqual([...MMG_CHECKOUT_SUPPORT_ROW_KEYS].sort());
      expect(Object.keys(row.partner).sort()).toEqual([...MMG_CHECKOUT_SUPPORT_PARTNER_KEYS].sort());
    }
    expect(Object.keys(confirmedDetail).sort()).toEqual([...MMG_CHECKOUT_SUPPORT_DETAIL_KEYS].sort());
    for (const entry of confirmedDetail.timeline) expect(Object.keys(entry).sort()).toEqual([...MMG_CHECKOUT_TIMELINE_KEYS].sort());
    expect(Object.keys(confirmedDetail.creditedPeriod!).sort()).toEqual([...MMG_CHECKOUT_CREDITED_PERIOD_KEYS].sort());
  });
});

describe('MMG payments: find a payment by any id', () => {
  it('opens on the newest payments, as the server answered them, and draws nothing before it answers', async () => {
    let answer!: (_reply: ReturnType<typeof page>) => void;
    const fetchMock = mockApi(() => new Promise((resolve) => { answer = resolve; }));
    renderWithQuery(<MmgPaymentsPage />);
    expect(screen.getByRole('searchbox', { name: 'Search MMG payments' }).getAttribute('placeholder'))
      .toBe('Swift reference, MMG transaction ID, MMG reference or partner phone');
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Searching…');
    expect(screen.queryByRole('table')).toBeNull();
    answer(page([confirmed, held]));
    const table = await screen.findByRole('table');
    const [first] = listCalls(fetchMock);
    expect(first!.search).toBe('');
    expect(within(table).getByText(confirmed.swiftReference)).toBeTruthy();
    expect(within(table).getByText(confirmed.mmgTransactionId!)).toBeTruthy();
    expect(within(table).getByText(confirmed.mmgTransactionReference!)).toBeTruthy();
    expect(within(table).getByText('GY$2,100')).toBeTruthy();
    expect(within(table).getByText('Confirmed')).toBeTruthy();
    expect(within(table).getByText('Shanta Kitchen')).toBeTruthy();
    expect(within(table).getByText('Store · +592•••••1234')).toBeTruthy();
    expect(within(table).getByText('Held for review')).toBeTruthy();
    expect(within(table).getByText('Not confirmed')).toBeTruthy();
    expect(within(table).queryByText('Matched by')).toBeNull();
  });

  it('a search sends the query and the status filter, and says which identifier matched', async () => {
    const fetchMock = mockApi(({ url }: ApiRequest) => (url.searchParams.get('q')
      ? page([{ ...held, matchedBy: ['MMG_CANDIDATE'] }])
      : page([confirmed])));
    const { user } = renderWithQuery(<MmgPaymentsPage />);
    await screen.findByRole('table');
    await user.type(screen.getByRole('searchbox', { name: 'Search MMG payments' }), '  2040 2048 536279 ');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'HELD');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(listCalls(fetchMock)).toHaveLength(2));
    const searched = listCalls(fetchMock)[1]!;
    expect(searched.searchParams.get('q')).toBe('2040 2048 536279');
    expect(searched.searchParams.get('status')).toBe('HELD');
    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).queryByText(confirmed.swiftReference)).toBeNull());
    expect(within(table).getByText('Matched by')).toBeTruthy();
    expect(within(table).getByText("Named in MMG's reply")).toBeTruthy();
    expect(within(table).getByText(held.swiftReference)).toBeTruthy();
  });

  it('a search that matches nothing says so', async () => {
    mockApi(({ url }: ApiRequest) => page(url.searchParams.get('q') ? [] : [confirmed]));
    const { user } = renderWithQuery(<MmgPaymentsPage />);
    await screen.findByRole('table');
    await user.type(screen.getByRole('searchbox', { name: 'Search MMG payments' }), '999999999999');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No MMG payment matches that exactly.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('an error is an error: the server message, and no rows', async () => {
    mockApi(() => ({ status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'This admin action requires the billing.mmg.read capability' } } }));
    renderWithQuery(<MmgPaymentsPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This admin action requires the billing.mmg.read capability');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('No MMG payments yet.')).toBeNull();
  });

  it('"Load more" continues with the cursor the server gave', async () => {
    const fetchMock = mockApi(({ url }: ApiRequest) => (url.searchParams.get('cursor') === 'page2_cursor' ? page([held]) : page([confirmed], 'page2_cursor')));
    const { user } = renderWithQuery(<MmgPaymentsPage />);
    const table = await screen.findByRole('table');
    expect(within(table).queryByText(held.swiftReference)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(table).getByText(held.swiftReference)).toBeTruthy());
    expect(within(table).getByText(confirmed.swiftReference)).toBeTruthy();
    expect(listCalls(fetchMock).map((url) => url.searchParams.get('cursor'))).toEqual([null, 'page2_cursor']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});

describe('MMG payments: one payment, its timeline and what it paid', () => {
  it("opening a confirmed payment shows both ids, MMG's reply and lookup, the week it paid and the receipt", async () => {
    const fetchMock = mockApi(({ url }: ApiRequest) => (url.pathname === `${PATH}/${confirmed.id}` ? { body: { success: true, data: confirmedDetail } } : page([confirmed])));
    const { user } = renderWithQuery(<MmgPaymentsPage />);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: `Open payment ${confirmed.swiftReference}` }));
    const panel = await screen.findByRole('region', { name: 'Payment detail' });
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `${API_ORIGIN}${PATH}/${confirmed.id}`)).toBe(true);
    expect(within(panel).getByRole('heading', { name: confirmed.swiftReference })).toBeTruthy();
    expect(within(panel).getAllByText('20402048536279').length).toBeGreaterThan(0);
    expect(within(panel).getByText('Result code 0 (successful)')).toBeTruthy();
    expect(within(panel).getByText('MMG status: successful')).toBeTruthy();
    // [7 Oct] MMG's history record of it: the window is read from its time, never from the lookup.
    expect(within(panel).getByText('MMG transaction history')).toBeTruthy();
    expect(within(panel).getByText('MMG status: completed')).toBeTruthy();
    expect(within(panel).getAllByText('Amount: 2100 GYD')).toHaveLength(2);
    expect(within(panel).getAllByText('Inside the checkout window')).toHaveLength(2);
    expect(within(panel).getByText(`Paid the week of ${day('2026-09-30T12:00:00.000Z')} to ${day('2026-10-07T12:00:00.000Z')}.`)).toBeTruthy();
    expect(within(panel).getByText('Receipt SWF-SWIFT-2026-000123')).toBeTruthy();
  });

  it('a held payment shows its operator reason, no MMG transaction ID and no credited period', async () => {
    mockApi(({ url }: ApiRequest) => (url.pathname === `${PATH}/${held.id}`
      ? { body: { success: true, data: detailOf(held, { timeline: [{ at: held.replyAt!, source: 'LOOKUP', resultCode: null, transactionStatus: 'successful', mmgTransactionId: '20402048536280', mmgTransactionReference: held.mmgTransactionReference, amount: '6001', currency: 'GYD', windowCheck: 'INSIDE', failure: null }] }) } }
      : page([held])));
    const { user } = renderWithQuery(<MmgPaymentsPage />);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: `Open payment ${held.swiftReference}` }));
    const panel = await screen.findByRole('region', { name: 'Payment detail' });
    expect(within(panel).getByText('Reason (operators only)')).toBeTruthy();
    expect(within(panel).getByText('AMOUNT_MISMATCH')).toBeTruthy();
    expect(within(panel).getByText('Not confirmed')).toBeTruthy();
    expect(within(panel).getByText('Amount: 6001 GYD')).toBeTruthy();
    expect(within(panel).queryByText('Credited period')).toBeNull();
  });

  it("[Sol, DS663 · 7 Oct] MMG's history record dated after MMG's first reply says so, never 'Inside the checkout window'", async () => {
    mockApi(({ url }: ApiRequest) => (url.pathname === `${PATH}/${held.id}`
      ? { body: { success: true, data: detailOf(held, { timeline: [{ at: held.replyAt!, source: 'HISTORY', resultCode: null, transactionStatus: 'completed', mmgTransactionId: '20402048536280', mmgTransactionReference: null, amount: '6001', currency: 'GYD', windowCheck: 'AFTER_REPLY', failure: null }] }) } }
      : page([held])));
    const { user } = renderWithQuery(<MmgPaymentsPage />);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: `Open payment ${held.swiftReference}` }));
    const panel = await screen.findByRole('region', { name: 'Payment detail' });
    expect(within(panel).getByText("After MMG's first reply: MMG's time may not match the zone setting, or it is another payment")).toBeTruthy();
    expect(within(panel).queryByText('Inside the checkout window')).toBeNull();
  });

  it.each([
    ['NOT_IN_HISTORY', "Not in MMG's transaction history", 'HISTORY_NOT_FOUND'],
    ['AMBIGUOUS', "More than one record in MMG's transaction history", null],
    ['DISAGREES', "MMG's transaction history record does not match the checkout", null],
    ['UNAVAILABLE', "MMG's transaction history could not be read in full", 'HISTORY_FAILED'],
  ] as const)("[7 Oct] MMG's history answer %s is said in plain words, never 'Inside the checkout window'", async (windowCheck, words, failure) => {
    mockApi(({ url }: ApiRequest) => (url.pathname === `${PATH}/${held.id}`
      ? { body: { success: true, data: detailOf(held, { timeline: [{ at: held.replyAt!, source: 'HISTORY', resultCode: null, transactionStatus: null, mmgTransactionId: '20402048536280', mmgTransactionReference: null, amount: null, currency: null, windowCheck, failure }] }) } }
      : page([held])));
    const { user } = renderWithQuery(<MmgPaymentsPage />);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: `Open payment ${held.swiftReference}` }));
    const panel = await screen.findByRole('region', { name: 'Payment detail' });
    expect(within(panel).getByText('MMG transaction history')).toBeTruthy();
    expect(within(panel).getByText(words)).toBeTruthy();
    expect(within(panel).queryByText('Inside the checkout window')).toBeNull();
  });

  it('a payment that cannot be opened shows the error, never a stale panel', async () => {
    mockApi(({ url }: ApiRequest) => (url.pathname === `${PATH}/${confirmed.id}`
      ? { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'MMG checkout not found' } } }
      : page([confirmed])));
    const { user } = renderWithQuery(<MmgPaymentsPage />);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: `Open payment ${confirmed.swiftReference}` }));
    expect((await screen.findByRole('alert')).textContent).toContain('MMG checkout not found');
    expect(screen.queryByRole('region', { name: 'Payment detail' })).toBeNull();
  });
});
