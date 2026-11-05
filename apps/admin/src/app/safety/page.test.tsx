import { useState } from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SafetyPage from './page';
import { retryUnlessRefused } from '@/lib/query-retry';
import { mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [SAFETY BOARD] The console's place to work an SOS and a safety case. Before it the console could only acknowledge the
// page: a responder could not see who asked for help or where, and a person held by a one-tap report stayed off the road
// until someone called the API by hand. Asserted: every open SOS says who, where, which order and when; the number is the
// audited read; only what the server's own state machine allows is offered; a refused read leaves no working button.
// ---------------------------------------------------------------------------

const TRIGGERED = '2026-11-05T14:04:00.000Z';
const sos = (over: Record<string, unknown> = {}) => ({
  id: 'sos-1', tenantId: 'swift-default', actorUserId: 'user-1', actorRole: 'MOVER', status: 'ACTIVE', orderId: 'ord-1', orderType: 'TAXI', serviceJobId: null,
  counterpartyUserId: 'user-2', triggeredAt: TRIGGERED, triggerSource: 'BUTTON', triggerLat: 6.80123, triggerLng: -58.15567, triggerAccuracyM: 12, triggerAddressText: null,
  triggerNote: null, retriggers: null, userSafeFlaggedAt: null, acknowledgedAt: null, retriggerCount: 0, ...over,
});
const kase = (over: Record<string, unknown> = {}) => ({
  id: 'case-1', caseNumber: 'INC-0001', status: 'OPEN', severity: 'S1', category: 'IDENTITY_MISMATCH', summary: 'The car did not match the app.', subjectUserId: 'user-3',
  reporterUserId: 'user-reporter', orderId: 'ord-2', sosAlertId: null, escalatedPoliceAt: null, legalHold: false, interimAction: 'NONE', slaAckBy: '2099-01-01T00:00:00.000Z',
  slaDecideBy: '2099-01-02T00:00:00.000Z', ackedAt: null, decidedAt: null, closedAt: null, decisionCode: null, createdAt: '2026-11-05T13:00:00.000Z', ...over,
});
const person = (id: string, firstName: string) => ({ id, firstName, lastName: 'Example', phone: '••••••1234', status: 'ACTIVE' });
const refused: ApiReply = { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Only ops can list alerts.' } } };
const broken: ApiReply = { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } } };
const ok = (data: unknown): ApiReply => ({ body: { success: true, data } });

type Read = unknown[] | ApiReply | 'network-down' | 'hangs';
type Replies = { orderRead?: ApiReply; alerts?: Read; cases?: Read; onWrite?: (_r: ApiRequest) => ApiReply; people?: (_id: string) => ApiReply; phone?: (_r: ApiRequest) => ApiReply };
function asReply(v: Read): ApiReply | Promise<ApiReply> {
  if (v === 'network-down') throw new TypeError('Failed to fetch');
  if (v === 'hangs') return new Promise<ApiReply>(() => undefined);
  return Array.isArray(v) ? ok(v) : v;
}
function serve(replies: Replies = {}) {
  const state = { ...replies };
  const fetchMock = mockApi((r) => {
    const path = r.url.pathname;
    if (r.method === 'GET' && path === '/api/v1/safety/sos') return asReply(state.alerts ?? []);
    if (r.method === 'GET' && path === '/api/v1/safety/incidents') return asReply(state.cases ?? []);
    if (r.method === 'GET' && path.startsWith('/api/v1/admin/orders/') && state.orderRead) return state.orderRead;
    if (r.method === 'GET' && path === '/api/v1/admin/orders/ord-1') return ok({ id: 'ord-1', orderNumber: 'SW-1001' });
    const phone = path.match(/^\/api\/v1\/admin\/users\/([^/]+)\/phone$/);
    if (r.method === 'GET' && phone) return state.phone?.(r) ?? ok({ party: 'user', phone: '+5926001234', auditId: 'a1' });
    const user = path.match(/^\/api\/v1\/admin\/users\/([^/]+)$/);
    if (r.method === 'GET' && user) return state.people?.(user[1]!) ?? ok(person(user[1]!, user[1] === 'user-1' ? 'Asha' : 'Dev'));
    if (r.method === 'POST' && state.onWrite) return state.onWrite(r);
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
  return { fetchMock, state };
}
const posts = (fetchMock: ReturnType<typeof mockApi>) => requestsByMethod(fetchMock, 'POST').map(([url, init]) => ({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body ?? '{}')) as unknown }));
const alertCard = () => screen.findByRole('listitem', { name: /^SOS from / });
const caseCard = (name = 'Case INC-0001') => screen.findByRole('listitem', { name });
const noWork = () => {
  for (const name of [/Acknowledge/, /Resolve/, /Decide/, /Close case/, /Lift/, /Show number/]) expect(screen.queryByRole('button', { name })).toBeNull();
};

describe('[SAFETY BOARD] an open SOS', () => {
  it('asks the server for the open alerts and says who, where, which order and when, in the console’s words', async () => {
    const { fetchMock } = serve({ alerts: [sos()] });
    renderWithQuery(<SafetyPage />);
    const card = await alertCard();
    await within(card).findByRole('link', { name: 'Asha Example' });
    expect(within(card).getByRole('link', { name: 'Asha Example' }).getAttribute('href')).toBe('/users/user-1');
    expect(card.textContent).toContain('Rider or driver');
    expect(card.textContent).toContain('••• ••• 1234');
    expect(card.textContent).toContain('6.80123, -58.15567');
    expect(card.textContent).toContain('±12 m');
    expect(card.textContent).toContain('5 Nov 2026, 10:04');
    const order = await within(card).findByRole('link', { name: 'SW-1001' });
    expect(order.getAttribute('href')).toBe('/orders/ord-1');
    expect(card.textContent).toContain('Taxi ride');
    expect(await within(card).findByRole('link', { name: 'Dev Example' })).toBeTruthy();
    const listCall = fetchMock.mock.calls.map(([url]) => new URL(String(url))).find((u) => u.pathname === '/api/v1/safety/sos')!;
    expect(listCall.searchParams.get('status')).toBe('open');
    expect(card.textContent).not.toMatch(/\bACTIVE\b|\bMOVER\b|\bBUTTON\b/);
  });

  it('an order that cannot be read keeps its door and says so', async () => {
    serve({ alerts: [sos({ orderId: 'ord-gone', counterpartyUserId: null })], orderRead: { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } } } });
    renderWithQuery(<SafetyPage />);
    const card = await alertCard();
    expect(await within(card).findByText('Its number could not be read.')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open the order' }).getAttribute('href')).toBe('/orders/ord-gone');
  });

  it('says so when no position was captured, and names a service job that has no order', async () => {
    serve({ alerts: [sos({ triggerLat: null, triggerLng: null, triggerAccuracyM: null, orderId: null, orderType: null, serviceJobId: 'job-1', counterpartyUserId: null })] });
    renderWithQuery(<SafetyPage />);
    const card = await alertCard();
    expect(card.textContent).toContain('No location was captured.');
    expect(card.textContent).toContain('On a service job (home visit)');
    expect(within(card).queryByRole('link', { name: /SW-/ })).toBeNull();
  });

  it('coordinates with no accuracy say so: a bare 5-decimal point reads as exact', async () => {
    serve({ alerts: [sos({ triggerAccuracyM: null })] });
    renderWithQuery(<SafetyPage />);
    const where = within(await alertCard()).getByRole('region', { name: 'Where' });
    expect(where.textContent).toContain('6.80123, -58.15567');
    expect(where.textContent).toContain('Accuracy not reported');
  });

  it('an address the server does hold is shown', async () => {
    serve({ alerts: [sos({ triggerAddressText: 'Regent Street, Georgetown' })] });
    renderWithQuery(<SafetyPage />);
    expect(within(await alertCard()).getByRole('region', { name: 'Where' }).textContent).toContain('Regent Street, Georgetown');
  });

  // The server's shape: a repeat press with coordinates OVERWRITES the alert's own, so the first position is gone from the
  // row and printing the row as "first" would say they have not moved.
  it('a repeat press that moved: the newest position with its own accuracy, and no false first position', async () => {
    serve({ alerts: [sos({
      triggerLat: 6.81, triggerLng: -58.16, triggerAccuracyM: 900, retriggerCount: 2,
      retriggers: [
        { seq: 1, at: '2026-11-05T14:06:00.000Z', lat: 6.81, lng: -58.16, accuracyM: 900, addressText: null, note: null },
        { seq: 2, at: '2026-11-05T14:08:00.000Z', lat: null, lng: null, accuracyM: null, addressText: null, note: 'please hurry' },
      ],
    })] });
    renderWithQuery(<SafetyPage />);
    const card = await alertCard();
    const where = within(card).getByRole('region', { name: 'Where' });
    expect(where.textContent).toContain('6.81000, -58.16000');
    expect(where.textContent).toContain('±900 m');
    expect(where.textContent).toMatch(/repeat press ×1 at 10:06/);
    expect(where.textContent).not.toMatch(/First position/);
    expect(where.textContent!.match(/6\.81000/g)).toHaveLength(1);
    expect(card.textContent).toContain('Asked again ×2');
    expect(card.textContent).toContain('please hurry');
  });

  it('what they typed reads first, as text; a press that said nothing is not a message', async () => {
    serve({ alerts: [sos({ triggerNote: '<b>he took a wrong turn</b>' })] });
    renderWithQuery(<SafetyPage />);
    const said = within(await alertCard()).getByRole('region', { name: 'What they said' });
    expect(said.textContent).toContain('<b>he took a wrong turn</b>');
    expect(said.querySelector('b')).toBeNull();
  });

  it('“I’m safe” closes nothing: it reads as a reason to call back, and Resolve stays', async () => {
    serve({ alerts: [sos({ userSafeFlaggedAt: '2026-11-05T14:05:00.000Z', status: 'ACKNOWLEDGED', acknowledgedAt: '2026-11-05T14:05:00.000Z' })] });
    renderWithQuery(<SafetyPage />);
    const card = await alertCard();
    expect(card.textContent).toContain('They tapped “I’m safe”. That does not close this: call back and check before resolving.');
    expect(within(card).getByRole('button', { name: 'Resolve…' })).toBeTruthy();
  });

  it('Acknowledge is the server’s one route, says what it does and does not do, and the board reads again', async () => {
    const { fetchMock, state } = serve({ alerts: [sos()], onWrite: () => {
      state.alerts = [sos({ status: 'ACKNOWLEDGED', acknowledgedAt: '2026-11-05T14:05:00.000Z' })];
      return ok({ id: 'sos-1', status: 'ACKNOWLEDGED', acknowledgedAt: '2026-11-05T14:05:00.000Z' });
    } });
    const { user } = renderWithQuery(<SafetyPage />);
    await user.click(within(await alertCard()).getByRole('button', { name: 'Acknowledge…' }));
    const dialog = screen.getByRole('dialog', { name: 'Acknowledge this SOS?' });
    expect(dialog.textContent).toMatch(/stops re-paging/);
    expect(dialog.textContent).toMatch(/does not close/);
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText('Acknowledged.')).toBeTruthy();
    // The route does not say whether its page was acknowledged too, so the console does not claim it, and it does not
    // send them to acknowledge it there: someone outside the page's audience is refused there too.
    expect(screen.getByText(/still on Ops alerts/).textContent).toMatch(/still re-paging/);
    expect(screen.getByText(/still on Ops alerts/).textContent).not.toMatch(/acknowledge it there/);
    expect(posts(fetchMock)).toEqual([{ path: '/api/v1/safety/sos/sos-1/ack', body: {} }]);
    await waitFor(async () => expect(within(await alertCard()).queryByRole('button', { name: 'Acknowledge…' })).toBeNull());
    expect(within(await alertCard()).getByRole('button', { name: 'Resolve…' })).toBeTruthy();
  });

  it('Resolve sends the server’s own code and the note, and every code on offer is one the server takes', async () => {
    const { fetchMock, state } = serve({ alerts: [sos()], onWrite: () => { state.alerts = []; return ok({ id: 'sos-1', status: 'RESOLVED', resolutionCode: 'SAFE_CONFIRMED' }); } });
    const { user } = renderWithQuery(<SafetyPage />);
    await user.click(within(await alertCard()).getByRole('button', { name: 'Resolve…' }));
    const dialog = screen.getByRole('dialog', { name: 'Resolve this SOS?' });
    const offered = within(dialog).getAllByRole('radio').map((r) => (r as HTMLInputElement).value);
    expect(offered).toEqual(['SAFE_CONFIRMED', 'POLICE_INVOLVED', 'MEDICAL', 'FALSE_ALARM', 'ABUSE', 'UNREACHABLE_CLOSED']);
    expect(dialog.textContent).toMatch(/all-clear/);
    expect(dialog.textContent).toMatch(/opens a safety case/);
    expect(dialog.textContent).toMatch(/taken offline at once and told they are under review/);
    expect(within(dialog).getByRole('radio', { name: 'Abuse by the other person' })).toBeTruthy();
    await user.click(within(dialog).getByRole('radio', { name: 'Confirmed safe' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Notes' }), 'Spoke to her, she is home.');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }));
    expect(await screen.findByText('Resolved as Confirmed safe.')).toBeTruthy();
    expect(posts(fetchMock)).toEqual([{ path: '/api/v1/safety/sos/sos-1/resolve', body: { resolutionCode: 'SAFE_CONFIRMED', notes: 'Spoke to her, she is home.' } }]);
    await screen.findByText('No open SOS.');
  });

  it('Resolve with no note sends no notes key, and will not go without a code', async () => {
    const { fetchMock } = serve({ alerts: [sos()], onWrite: () => ok({ id: 'sos-1', status: 'RESOLVED', resolutionCode: 'FALSE_ALARM' }) });
    const { user } = renderWithQuery(<SafetyPage />);
    await user.click(within(await alertCard()).getByRole('button', { name: 'Resolve…' }));
    const dialog = screen.getByRole('dialog', { name: 'Resolve this SOS?' });
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }));
    expect(posts(fetchMock)).toEqual([]);
    await user.click(within(dialog).getByRole('radio', { name: 'False alarm' }));
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(posts(fetchMock)).toEqual([{ path: '/api/v1/safety/sos/sos-1/resolve', body: { resolutionCode: 'FALSE_ALARM' } }]));
  });

  it('a refusal stays in the panel with the server’s words', async () => {
    serve({ alerts: [sos()], onWrite: () => ({ status: 409, body: { success: false, error: { code: 'SOS_TRANSITION_RACE', message: 'The alert changed underneath this action — retry.' } } }) });
    const { user } = renderWithQuery(<SafetyPage />);
    await user.click(within(await alertCard()).getByRole('button', { name: 'Acknowledge…' }));
    const dialog = screen.getByRole('dialog', { name: 'Acknowledge this SOS?' });
    await user.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
    expect(await within(dialog).findByText(/The alert changed underneath this action/)).toBeTruthy();
  });

  it('in the grace window the server refuses both moves, so neither is offered, and the card says why', async () => {
    serve({ alerts: [sos({ status: 'TRIGGER_PENDING', graceEndsAt: '2026-11-05T14:05:00.000Z' })] });
    renderWithQuery(<SafetyPage />);
    const card = await alertCard();
    expect(card.textContent).toMatch(/can still cancel/);
    expect(within(card).queryByRole('button', { name: /Acknowledge/ })).toBeNull();
    expect(within(card).queryByRole('button', { name: /Resolve/ })).toBeNull();
  });

  it('past the grace window with no page: it says nobody was paged and marks the card, never “they can still cancel”', async () => {
    serve({ alerts: [sos({ status: 'TRIGGER_PENDING', graceEndsAt: '2020-01-01T00:00:00.000Z' })] });
    renderWithQuery(<SafetyPage />);
    const card = await alertCard();
    expect(card.textContent).not.toMatch(/can still cancel/);
    expect(card.textContent).toMatch(/grace window ended/);
    expect(card.className).toContain('border-[var(--mc-bad)]');
    expect(within(card).queryByRole('button', { name: /Resolve/ })).toBeNull();
  });

  it('an acknowledged alert offers Resolve only', async () => {
    serve({ alerts: [sos({ status: 'ACKNOWLEDGED', acknowledgedAt: '2026-11-05T14:05:00.000Z' })] });
    renderWithQuery(<SafetyPage />);
    const card = await alertCard();
    expect(within(card).queryByRole('button', { name: /Acknowledge/ })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Resolve…' })).toBeTruthy();
  });
});

describe('[SAFETY BOARD] the person behind an SOS', () => {
  it('the number is the audited read: a reason, sent as the reason header, the full number for this view only', async () => {
    const seen: ApiRequest[] = [];
    serve({ alerts: [sos({ counterpartyUserId: null })], phone: (r) => { seen.push(r); return ok({ party: 'user', phone: '+5926001234', auditId: 'a1' }); } });
    const { user } = renderWithQuery(<SafetyPage />);
    const card = await alertCard();
    await user.click(await within(card).findByRole('button', { name: 'Show number' }));
    const dialog = screen.getByRole('dialog', { name: "Show Asha Example's full number?" });
    expect(dialog.textContent).toMatch(/recorded in the audit log/);
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Calling back on an open SOS alert');
    await user.click(within(dialog).getByRole('button', { name: 'Show number' }));
    expect(await within(card).findByText('+5926001234')).toBeTruthy();
    expect(new Headers(seen[0]!.init?.headers).get('x-swift-reason')).toBe('Calling back on an open SOS alert');
    expect(seen[0]!.url.pathname).toBe('/api/v1/admin/users/user-1/phone');
  });

  it('a person with no number on file says so', async () => {
    serve({ alerts: [sos({ counterpartyUserId: null })], people: () => ok({ id: 'user-1', firstName: 'Asha', lastName: 'Example', phone: null }) });
    renderWithQuery(<SafetyPage />);
    const card = await alertCard();
    expect(await within(card).findByText('No number on file')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Show number' })).toBeNull();
  });

  it('a person read once is not read again on every refresh of the board', async () => {
    const { fetchMock } = serve({ alerts: [sos({ counterpartyUserId: null })] });
    const { queryClient } = renderWithQuery(<SafetyPage />);
    await within(await alertCard()).findByRole('link', { name: 'Asha Example' });
    await queryClient.invalidateQueries({ queryKey: ['safety-sos'] });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/v1/safety/sos').length).toBeGreaterThan(1));
    expect(fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/v1/admin/users/user-1')).toHaveLength(1);
  });

  it('a person this account cannot read: says so, offers no number, keeps the door to their page and the SOS actions', async () => {
    serve({ alerts: [sos({ counterpartyUserId: null })], people: () => ({ status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'This admin action requires the user.read capability' } } }) });
    renderWithQuery(<SafetyPage />);
    const card = await alertCard();
    expect(await within(card).findByText(/cannot read this person/)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Show number' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Resolve…' })).toBeTruthy();
  });
});

describe('[SAFETY BOARD] a refused or failed read', () => {
  it('a refused SOS read says so and leaves no working button', async () => {
    serve({ alerts: refused, cases: [] });
    renderWithQuery(<SafetyPage />);
    expect(await screen.findByText(/Couldn't load the open SOS alerts/)).toBeTruthy();
    expect(screen.getByText('Only ops can list alerts.')).toBeTruthy();
    noWork();
  });

  it('cards already on screen go when the server starts refusing: the role was taken away', async () => {
    const { state } = serve({ alerts: [sos({ counterpartyUserId: null })], cases: [kase()] });
    const { queryClient } = renderWithQuery(<SafetyPage />);
    await alertCard();
    await caseCard();
    state.alerts = refused;
    state.cases = refused;
    await queryClient.invalidateQueries({ queryKey: ['safety-sos'] });
    await queryClient.invalidateQueries({ queryKey: ['safety-cases'] });
    await waitFor(() => expect(screen.queryByRole('listitem', { name: /^SOS from / })).toBeNull());
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Case INC-0001' })).toBeNull());
    noWork();
  });

  it('a failed refresh keeps the alerts on screen and says they may be old: an outage never blanks a live emergency', async () => {
    const { state } = serve({ alerts: [sos({ counterpartyUserId: null })] });
    const { queryClient } = renderWithQuery(<SafetyPage />);
    await alertCard();
    state.alerts = broken;
    await queryClient.invalidateQueries({ queryKey: ['safety-sos'] });
    expect(await screen.findByText(/Not read since \d\d:\d\d:\d\d\. There may be an open SOS\./)).toBeTruthy();
    expect(within(await alertCard()).getByRole('button', { name: 'Resolve…' })).toBeTruthy();
  });

  it('a 429 is not a refusal: the cards stay on both lists', async () => {
    const tooMany: ApiReply = { status: 429, body: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } } };
    const { state } = serve({ alerts: [sos({ counterpartyUserId: null })], cases: [kase()] });
    const { queryClient } = renderWithQuery(<SafetyPage />);
    await alertCard();
    await caseCard();
    state.alerts = tooMany;
    state.cases = tooMany;
    await queryClient.invalidateQueries({ queryKey: ['safety-sos'] });
    await queryClient.invalidateQueries({ queryKey: ['safety-cases'] });
    expect(await screen.findByText(/Not read since/)).toBeTruthy();
    expect(await screen.findByText(/could not refresh/)).toBeTruthy();
    expect(within(await alertCard()).getByRole('button', { name: 'Resolve…' })).toBeTruthy();
    expect(await caseCard()).toBeTruthy();
  });

  it('a first read that fails is never “No open SOS.”', async () => {
    serve({ alerts: broken });
    renderWithQuery(<SafetyPage />);
    expect(await screen.findByText(/Couldn't load the open SOS alerts/)).toBeTruthy();
    expect(screen.queryByText('No open SOS.')).toBeNull();
  });
});

// [G13 S1-1] "No open SOS." is a claim about a person in danger. It may be said only on a read that ran and came back
// recently: never because a read paused with the Wi-Fi, hung, or waited behind a hidden tab.
describe('[SAFETY BOARD] “No open SOS.” needs a recent read', () => {
  const NONE = 'No open SOS.';
  /** The client the console really runs on (app/providers.tsx): the test default would hide all of this. */
  const board = (ui = <SafetyPage />) => renderWithQuery(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: retryUnlessRefused } } })}>{ui}</QueryClientProvider>,
  );
  const sosReads = (fetchMock: ReturnType<typeof mockApi>) => fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/v1/safety/sos');
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); onlineManager.setOnline(true); focusManager.setFocused(undefined); });

  it('prints when it was read, to the second', async () => {
    serve();
    board();
    await screen.findByText(NONE);
    expect(screen.getByText(/^Read at \d\d:\d\d:\d\d$/)).toBeTruthy();
  });

  it('the Wi-Fi drops after a good read: the read still runs, fails, and the all-clear goes', async () => {
    const { fetchMock, state } = serve();
    board();
    await screen.findByText(NONE);
    const before = sosReads(fetchMock).length;
    state.alerts = 'network-down';
    act(() => { onlineManager.setOnline(false); });
    await advance(15_000);
    expect(sosReads(fetchMock).length).toBeGreaterThan(before);
    expect(screen.queryByText(NONE)).toBeNull();
    expect(screen.getByText(/Not read since \d\d:\d\d:\d\d\. There may be an open SOS\./)).toBeTruthy();
  });

  it('offline at first load: says so, never a heading over nothing', async () => {
    act(() => { onlineManager.setOnline(false); });
    serve({ alerts: 'network-down' });
    board();
    expect(await screen.findByText(/Couldn't load the open SOS alerts/)).toBeTruthy();
    expect(screen.queryByText(NONE)).toBeNull();
  });

  it('a read that hangs is given up on at 10 seconds and the all-clear goes', async () => {
    const { fetchMock, state } = serve();
    board();
    await screen.findByText(NONE);
    state.alerts = 'hangs';
    await advance(15_000);
    const hung = sosReads(fetchMock).at(-1)!;
    expect((hung[1]?.signal as AbortSignal).aborted).toBe(false);
    await advance(9_000);
    expect((hung[1]?.signal as AbortSignal).aborted).toBe(false);
    await advance(1_500);
    expect((hung[1]?.signal as AbortSignal).aborted).toBe(true);
    expect(screen.queryByText(NONE)).toBeNull();
    expect(screen.getByText(/Not read since/)).toBeTruthy();
  });

  it('a read that never gets past the token refresh is given up on too: the timer does not depend on fetch answering the abort', async () => {
    serve({ alerts: 'hangs' });
    board();
    await advance(10_500);
    expect(screen.getByText(/Couldn't load the open SOS alerts/)).toBeTruthy();
  });

  it('a hidden tab keeps reading', async () => {
    const { fetchMock } = serve();
    board();
    await screen.findByText(NONE);
    act(() => { focusManager.setFocused(false); });
    const before = sosReads(fetchMock).length;
    await advance(15_000);
    expect(sosReads(fetchMock).length).toBe(before + 1);
  });

  it('a tab coming back reads at once, not at the next tick', async () => {
    const { fetchMock } = serve();
    board();
    await screen.findByText(NONE);
    act(() => { focusManager.setFocused(false); });
    const before = sosReads(fetchMock).length;
    act(() => { focusManager.setFocused(true); });
    await waitFor(() => expect(sosReads(fetchMock).length).toBe(before + 1));
  });

  it('opening the page reads at once, even with a recent answer in the cache', async () => {
    const { fetchMock } = serve();
    let show: (_on: boolean) => void = () => undefined;
    function Doors() { const [on, set] = useState(true); show = set; return on ? <SafetyPage /> : null; }
    board(<Doors />);
    await screen.findByText(NONE);
    act(() => show(false));
    const before = sosReads(fetchMock).length;
    act(() => show(true));
    await waitFor(() => expect(sosReads(fetchMock).length).toBe(before + 1));
  });

  it('a laptop waking: no timer ran, the read is old, and the all-clear is gone the moment the tab shows', async () => {
    const { state } = serve();
    board();
    await screen.findByText(NONE);
    state.alerts = 'hangs';
    vi.setSystemTime(Date.now() + 60_000);
    act(() => { document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); });
    expect(screen.queryByText(NONE)).toBeNull();
    expect(screen.getByText(/Not read since/)).toBeTruthy();
  });

  it('the page’s own clock takes the all-clear away with no read and no event', async () => {
    const { state } = serve();
    board();
    await screen.findByText(NONE);
    state.alerts = 'hangs';
    vi.setSystemTime(Date.now() + 60_000);
    await advance(5_000);
    expect(screen.queryByText(NONE)).toBeNull();
    expect(screen.getByText(/Not read since/)).toBeTruthy();
  });

  it('a card on screen says the same when its read is old: a repeat press may not be showing', async () => {
    const { state } = serve({ alerts: [sos({ counterpartyUserId: null })] });
    board();
    await alertCard();
    state.alerts = 'network-down';
    await advance(15_000);
    expect(screen.getByText(/Not read since/)).toBeTruthy();
    expect(screen.getByRole('listitem', { name: /^SOS from / })).toBeTruthy();
  });

  it('cases take the same road: offline ends “No cases in this view.”', async () => {
    const { state } = serve();
    board();
    await screen.findByText('No cases in this view.');
    state.cases = 'network-down';
    act(() => { onlineManager.setOnline(false); });
    await advance(60_000);
    expect(screen.queryByText('No cases in this view.')).toBeNull();
    expect(screen.getByText(/could not refresh/)).toBeTruthy();
  });
});

describe('[SAFETY BOARD] a case', () => {
  it.each([
    ['open', { status: 'OPEN' }, ['Acknowledge…']],
    ['triaged', { status: 'TRIAGED', ackedAt: '2026-11-05T13:10:00.000Z' }, ['Decide…']],
    ['investigating', { status: 'INVESTIGATING', ackedAt: '2026-11-05T13:10:00.000Z' }, ['Decide…']],
    ['decided', { status: 'DECIDED', ackedAt: '2026-11-05T13:10:00.000Z', decidedAt: '2026-11-05T13:20:00.000Z' }, ['Close case…']],
    ['closed', { status: 'CLOSED', closedAt: '2026-11-05T13:30:00.000Z' }, []],
    ['open with a suspension', { status: 'OPEN', interimAction: 'SUSPENDED_PENDING_REVIEW' }, ['Acknowledge…', 'Lift suspension…']],
    ['triaged with a restriction', { status: 'TRIAGED', interimAction: 'SHADOW_RESTRICTED' }, ['Decide…', 'Lift restriction…']],
    // The server lifts on a closed case, and nothing else ever clears the stamp: this is the way out, not a mistake.
    ['closed with the suspension still on', { status: 'CLOSED', interimAction: 'SUSPENDED_PENDING_REVIEW' }, ['Lift suspension…']],
  ])('%s: offers exactly what the server allows', async (_name, over, buttons) => {
    serve({ cases: [kase(over)] });
    renderWithQuery(<SafetyPage />);
    const card = await caseCard();
    expect(within(card).queryAllByRole('button').map((b) => b.textContent)).toEqual(buttons);
  });

  it('says what it is in words, with its clocks, and links the person and the order; never the reporter', async () => {
    serve({ cases: [kase({ slaAckBy: '2020-01-01T00:00:00.000Z', interimAction: 'SUSPENDED_PENDING_REVIEW' })] });
    renderWithQuery(<SafetyPage />);
    const card = await caseCard();
    expect(card.textContent).toContain('INC-0001');
    expect(card.textContent).toContain('The car did not match the app.');
    expect(card.textContent).toContain('Wrong person or vehicle');
    expect(card.textContent).toContain('Waiting for acknowledgement');
    expect(card.textContent).toContain('Suspended pending review');
    expect(card.textContent).toMatch(/Acknowledge by[^]*overdue/i);
    expect(within(card).getByRole('link', { name: 'Open the person’s page' }).getAttribute('href')).toBe('/users/user-3');
    expect(within(card).getByRole('link', { name: 'Open the order' }).getAttribute('href')).toBe('/orders/ord-2');
    expect(card.innerHTML).not.toContain('user-reporter');
  });

  it('a closed case that still lists a hold does not swear the person is still held: another case’s lift can clear it', async () => {
    serve({ cases: [kase({ status: 'CLOSED', interimAction: 'SUSPENDED_PENDING_REVIEW' })] });
    renderWithQuery(<SafetyPage />);
    const card = await caseCard();
    expect(card.textContent).toMatch(/still lists a suspension/);
    expect(card.textContent).not.toMatch(/is still on/);
  });

  it('Lift goes to the one route that clears the hold, and says the person is told and what another case keeps', async () => {
    const { fetchMock, state } = serve({ cases: [kase({ interimAction: 'SUSPENDED_PENDING_REVIEW' })], onWrite: () => { state.cases = [kase()]; return ok(kase()); } });
    const { user } = renderWithQuery(<SafetyPage />);
    await user.click(within(await caseCard()).getByRole('button', { name: 'Lift suspension…' }));
    const dialog = screen.getByRole('dialog', { name: 'Lift the suspension on case INC-0001?' });
    expect(dialog.textContent).toMatch(/They are told/);
    expect(dialog.textContent).toMatch(/Another open case/);
    await user.click(within(dialog).getByRole('button', { name: 'Lift suspension' }));
    expect(await screen.findByText('INC-0001: the suspension is lifted.')).toBeTruthy();
    expect(posts(fetchMock)).toEqual([{ path: '/api/v1/safety/incidents/case-1/lift-interim', body: {} }]);
    await waitFor(async () => expect(within(await caseCard()).queryByRole('button', { name: /Lift/ })).toBeNull());
  });

  it('Acknowledge starts the case', async () => {
    const { fetchMock } = serve({ cases: [kase()], onWrite: () => ok(kase({ status: 'TRIAGED' })) });
    const { user } = renderWithQuery(<SafetyPage />);
    await user.click(within(await caseCard()).getByRole('button', { name: 'Acknowledge…' }));
    const dialog = screen.getByRole('dialog', { name: 'Acknowledge case INC-0001?' });
    await user.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText('INC-0001 is acknowledged.')).toBeTruthy();
    expect(posts(fetchMock)).toEqual([{ path: '/api/v1/safety/incidents/case-1/ack', body: {} }]);
  });

  it('Decide sends the server’s code and the note; it warns what a decision leaves in force', async () => {
    const { fetchMock } = serve({ cases: [kase({ status: 'TRIAGED', interimAction: 'SUSPENDED_PENDING_REVIEW' })], onWrite: () => ok(kase({ status: 'DECIDED' })) });
    const { user } = renderWithQuery(<SafetyPage />);
    await user.click(within(await caseCard()).getByRole('button', { name: 'Decide…' }));
    const dialog = screen.getByRole('dialog', { name: 'Decide case INC-0001?' });
    expect(within(dialog).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['DISMISSED', 'WARNING_ISSUED', 'SUSPENSION_PERMANENT', 'RESOLVED_OTHER']);
    expect(dialog.textContent).toMatch(/Only Dismissed lifts the suspension/);
    expect(dialog.textContent).toMatch(/does not suspend anyone/);
    expect(dialog.textContent).toMatch(/Warning issued is a record: Swift sends them nothing\. Warn them yourself\./);
    await user.click(within(dialog).getByRole('radio', { name: /Warning issued/ }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Notes' }), 'Spoke to both people.');
    await user.click(within(dialog).getByRole('button', { name: 'Record the decision' }));
    expect(await screen.findByText('INC-0001 is decided: Warning issued.')).toBeTruthy();
    expect(posts(fetchMock)).toEqual([{ path: '/api/v1/safety/incidents/case-1/decide', body: { decisionCode: 'WARNING_ISSUED', notes: 'Spoke to both people.' } }]);
  });

  it('Decide with no note sends no notes key, and will not go without a decision', async () => {
    const { fetchMock } = serve({ cases: [kase({ status: 'TRIAGED' })], onWrite: () => ok(kase({ status: 'DECIDED' })) });
    const { user } = renderWithQuery(<SafetyPage />);
    await user.click(within(await caseCard()).getByRole('button', { name: 'Decide…' }));
    const dialog = screen.getByRole('dialog', { name: 'Decide case INC-0001?' });
    expect(dialog.textContent).not.toMatch(/Only Dismissed lifts/);
    await user.click(within(dialog).getByRole('button', { name: 'Record the decision' }));
    expect(posts(fetchMock)).toEqual([]);
    await user.click(within(dialog).getByRole('radio', { name: 'Dismissed' }));
    await user.click(within(dialog).getByRole('button', { name: 'Record the decision' }));
    await waitFor(() => expect(posts(fetchMock)).toEqual([{ path: '/api/v1/safety/incidents/case-1/decide', body: { decisionCode: 'DISMISSED' } }]));
  });

  it('Close warns when a suspension would stay on, and goes to the close route', async () => {
    const { fetchMock } = serve({ cases: [kase({ status: 'DECIDED', interimAction: 'SUSPENDED_PENDING_REVIEW' })], onWrite: () => ok(kase({ status: 'CLOSED' })) });
    const { user } = renderWithQuery(<SafetyPage />);
    await user.click(within(await caseCard()).getByRole('button', { name: 'Close case…' }));
    const dialog = screen.getByRole('dialog', { name: 'Close case INC-0001?' });
    expect(dialog.textContent).toMatch(/Closing does not lift/);
    await user.click(within(dialog).getByRole('button', { name: 'Close case' }));
    expect(await screen.findByText('INC-0001 is closed.')).toBeTruthy();
    expect(posts(fetchMock)).toEqual([{ path: '/api/v1/safety/incidents/case-1/close', body: {} }]);
  });

  it('Close with no hold says nothing about one', async () => {
    serve({ cases: [kase({ status: 'DECIDED' })] });
    const { user } = renderWithQuery(<SafetyPage />);
    await user.click(within(await caseCard()).getByRole('button', { name: 'Close case…' }));
    expect(screen.getByRole('dialog', { name: 'Close case INC-0001?' }).textContent).not.toMatch(/Closing does not lift/);
  });

  it('the view switches to past a deadline, and to all', async () => {
    const { fetchMock } = serve({ cases: [] });
    const { user } = renderWithQuery(<SafetyPage />);
    await screen.findByText('No cases in this view.');
    await user.click(screen.getByRole('button', { name: 'Past a deadline' }));
    await user.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => {
      const asked = fetchMock.mock.calls.map(([url]) => new URL(String(url))).filter((u) => u.pathname === '/api/v1/safety/incidents').map((u) => u.searchParams.get('status'));
      expect(asked).toEqual(['open', 'breached', 'all']);
    });
  });

  it('the worst case comes first, and the list says when it stopped short', async () => {
    const many = Array.from({ length: 200 }, (_, i) => kase({ id: `case-${i}`, caseNumber: `INC-${i}`, severity: 'S3' }));
    serve({ cases: [...many.slice(0, 199), kase({ id: 'case-top', caseNumber: 'INC-TOP', severity: 'S0' })] });
    renderWithQuery(<SafetyPage />);
    await caseCard('Case INC-TOP');
    expect(screen.getAllByRole('listitem', { name: /^Case / })[0]!.getAttribute('aria-label')).toBe('Case INC-TOP');
    expect(screen.getByText(/first 200/).textContent).toMatch(/There may be more/);
  });
});
