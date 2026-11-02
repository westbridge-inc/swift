import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { DeleteAccountFlow, type DeletionArea } from './delete-account-flow';
import type { DeletionCheck } from '@/lib/account-deletion';
import { CLOSURE_LEAD, DELETE_LEAD, DELETION_GONE, DELETION_KEPT, MOVER_DELETION_EFFECTS, STAFF_DELETION_EFFECTS, STORE_CLOSURE_EFFECTS, STORE_ORDERS_PAUSED, STORE_ORDERS_PAUSE_NOW } from '@/lib/account-deletion-words';

// ---------------------------------------------------------------------------
// [WEB-DELETE · owner 1 Nov 2026] A person who signed up on the website deletes their own account there, as the
// phone does it (PersonalDataScreen): the server's answer decides delete or closure request (a store owner), the
// phone's words, a tick, "Confirm it's you" when the server asks for a code, then the deleted page. The deletion
// check names which live orders, jobs and money stop the delete, before any code is asked for.
// ---------------------------------------------------------------------------

const CLEAR: DeletionCheck = {
  closure: 'DELETE', ownsStore: false, closureRequest: null,
  openOrders: { count: 0, items: [] }, openServiceJobs: { count: 0, items: [] }, settleFirst: null,
};

const calls: Array<{ method: string; path: string }> = [];
function api(opts: {
  check?: DeletionCheck;
  checks?: DeletionCheck[];
  stepUp?: boolean;
  deleteReply?: { status: number; body: unknown };
  closureReply?: { status: number; body: unknown };
  cancelReply?: { status: number; body: unknown };
} = {}) {
  let stepped = !opts.stepUp;
  let reads = 0;
  return mockApi(({ method, url, init }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    calls.push({ method, path: `${path}${url.search}` });
    if (path === '/customer/account/deletion-check') {
      const list = opts.checks ?? [opts.check ?? CLEAR];
      const answer = list[Math.min(reads, list.length - 1)]!;
      reads += 1;
      return { body: { success: true, data: answer } };
    }
    if (path === '/auth/step-up') return { body: { success: true, data: { sentTo: '+592•••••0000' } } };
    if (path === '/auth/step-up/verify') {
      expect(JSON.parse(String(init?.body))).toEqual({ code: '123456' });
      stepped = true;
      return { body: { success: true, data: { validForSeconds: 600 } } };
    }
    if (path === '/customer/account' && method === 'DELETE') {
      if (!stepped) return { status: 403, body: { success: false, error: { code: 'STEP_UP_REQUIRED', message: 'Confirm it’s you first — we’ll text a code to the phone on this account.' } } };
      const reply = opts.deleteReply ?? { status: 200, body: { success: true, data: { deleted: true } } };
      return { status: reply.status, body: reply.body };
    }
    if (path === '/customer/account/closure-request' && method === 'POST') {
      if (!stepped) return { status: 403, body: { success: false, error: { code: 'STEP_UP_REQUIRED', message: 'Confirm it’s you first.' } } };
      const reply = opts.closureReply ?? { status: 202, body: { success: true, data: { deleted: false, status: 'CLOSURE_REQUESTED', ticketId: 't1', message: 'Your account closure request is received.' } } };
      return { status: reply.status, body: reply.body };
    }
    if (path === '/customer/account/closure-request/cancel' && method === 'POST') {
      if (!stepped) return { status: 403, body: { success: false, error: { code: 'STEP_UP_REQUIRED', message: 'Confirm it’s you first.' } } };
      const reply = opts.cancelReply ?? { status: 200, body: { success: true, data: { cancelled: true, ticketId: 't1', storesLifted: 1, message: 'Your closure request is cancelled. Your store still takes no new orders until you press Resume orders on the Orders page.' } } };
      return { status: reply.status, body: reply.body };
    }
    return { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: `unexpected ${method} ${path}` } } };
  });
}

let replace: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  calls.length = 0;
  window.sessionStorage.clear();
  replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const render = (area: DeletionArea = 'customer') => renderWithQuery(<DeleteAccountFlow area={area} backHref="/back" />);
const deletes = () => calls.filter((c) => c.method === 'DELETE' && c.path.startsWith('/customer/account'));
const mainButton = (name: RegExp | string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('[WEB-DELETE] deleting an account on the website', () => {
  it('shows the phone\'s words, what is deleted and what is kept (and for how long), and asks for a tick before anything is sent', async () => {
    api();
    const { user } = render();
    expect(await screen.findByRole('heading', { name: 'Delete my account', level: 1 })).toBeTruthy();
    expect(screen.getByText(DELETE_LEAD)).toBeTruthy();
    const gone = screen.getByRole('region', { name: 'What is deleted' });
    for (const line of DELETION_GONE) expect(within(gone).getByText(line)).toBeTruthy();
    const kept = screen.getByRole('region', { name: 'What Swift keeps, and for how long' });
    for (const row of DELETION_KEPT) {
      expect(within(kept).getByText(row.what)).toBeTruthy();
      expect(within(kept).getByText(`${row.why} ${row.howLong}`)).toBeTruthy();
    }
    // The disabled button says what it waits for, and nothing is sent until the box is ticked.
    expect(mainButton('Tick the box to continue').disabled).toBe(true);
    expect(screen.getByRole('link', { name: 'Keep my account' }).getAttribute('href')).toBe('/back');
    await user.click(screen.getByRole('checkbox', { name: 'I understand that deleting my account cannot be undone.' }));
    expect(mainButton('Delete my account').disabled).toBe(false);
    expect(deletes()).toEqual([]);
  });

  it('deletes with the app\'s receipt contract, then leaves for the deleted page with the server\'s receipt', async () => {
    api({ deleteReply: { status: 202, body: { success: true, data: { deleted: false, status: 'PENDING_DOCUMENT_ERASURE', message: 'Your account is closed. Some personal-data erasure is pending; no further sign-in is needed.' } } } });
    const { user } = render();
    await user.click(await screen.findByRole('checkbox'));
    await user.click(mainButton('Delete my account'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/account-deleted?status=PENDING_DOCUMENT_ERASURE'));
    expect(deletes()).toEqual([{ method: 'DELETE', path: '/customer/account?receipts=v2' }]);
    expect(JSON.parse(window.sessionStorage.getItem('swift_web_deletion_receipt')!)).toEqual({
      status: 'PENDING_DOCUMENT_ERASURE', message: 'Your account is closed. Some personal-data erasure is pending; no further sign-in is needed.',
    });
    // The button stays disabled while the page leaves: a second press sends nothing.
    expect(mainButton('Deleting your account…').disabled).toBe(true);
  });

  it('a second press while the first is in flight sends nothing more', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = api();
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') await held;
      return real(input, init);
    });
    const { user } = render();
    await user.click(await screen.findByRole('checkbox'));
    const button = mainButton('Delete my account');
    await user.click(button);
    button.click();
    button.click();
    release();
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(deletes()).toHaveLength(1);
  });

  it('when the server asks for a fresh code, "Confirm it\'s you" opens, and the same delete runs once more after the code', async () => {
    api({ stepUp: true });
    const { user } = render();
    await user.click(await screen.findByRole('checkbox'));
    await user.click(mainButton('Delete my account'));
    await user.type(await screen.findByLabelText('Code'), '123456');
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/account-deleted?status=DELETED'));
    expect(deletes()).toHaveLength(2);
    expect(calls.filter((c) => c.path === '/auth/step-up/verify')).toHaveLength(1);
  });

  it('closing "Confirm it\'s you" is not an error, deletes nothing, and the button works again', async () => {
    api({ stepUp: true });
    const { user } = render();
    await user.click(await screen.findByRole('checkbox'));
    await user.click(mainButton('Delete my account'));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText('Code')).toBeNull());
    expect(screen.queryAllByRole('alert')).toEqual([]);
    expect(replace).not.toHaveBeenCalled();
    expect(mainButton('Delete my account').disabled).toBe(false);
  });

  it('names WHICH live orders, jobs and money stop the delete, and sends nothing until they are done', async () => {
    api({ check: {
      ...CLEAR,
      openOrders: { count: 12, items: [
        { id: 'o1', orderNumber: 'A100', status: 'PREPARING', orderType: 'FOOD_DELIVERY', createdAt: '2026-11-01T10:00:00.000Z', side: 'CUSTOMER', storeName: 'Sample Kitchen' },
        { id: 'o2', orderNumber: 'A101', status: 'PICKED_UP', orderType: 'FOOD_DELIVERY', createdAt: '2026-11-01T10:00:00.000Z', side: 'RIDER', storeName: 'Other Shop' },
      ] },
      openServiceJobs: { count: 1, items: [{ id: 'j1', status: 'SCHEDULED', scheduledFor: null, createdAt: '2026-11-01T10:00:00.000Z', side: 'PROVIDER' }] },
      settleFirst: { blockers: ['CASH_HELD'], message: 'You are holding vendor cash from a delivery that has not been settled.' },
    } });
    render();
    const list = await screen.findByRole('region', { name: 'Finish these first' });
    expect(within(list).getByText(/A100/).closest('li')!.textContent).toBe('#A100 · Preparing · your order from Sample Kitchen');
    expect(within(list).getByText(/A101/).closest('li')!.textContent).toBe('#A101 · Picked up · a delivery assigned to you');
    expect(within(list).getByText(/a job you are booked for/)).toBeTruthy();
    expect(within(list).getByText('And 10 more.')).toBeTruthy();
    expect(within(list).getByText('You are holding vendor cash from a delivery that has not been settled.')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(mainButton('Finish or settle the things above first').disabled).toBe(true);
    expect(deletes()).toEqual([]);
  });

  it('a refusal the check explains shows the server\'s sentence, reads the check again and shows the list', async () => {
    const sentence = 'Finish or cancel your active orders and jobs before deleting your account. For a job already collected, finish the handover or open Get help to resolve it.';
    api({
      checks: [CLEAR, { ...CLEAR, openOrders: { count: 1, items: [{ id: 'o9', orderNumber: 'B9', status: 'PENDING', orderType: 'FOOD_DELIVERY', createdAt: '2026-11-01T10:00:00.000Z', side: 'CUSTOMER', storeName: null }] } }],
      deleteReply: { status: 409, body: { success: false, error: { code: 'ACTIVE_ORDERS', message: sentence } } },
    });
    const { user } = render();
    await user.click(await screen.findByRole('checkbox'));
    await user.click(mainButton('Delete my account'));
    expect((await screen.findByRole('alert')).textContent).toBe(sentence);
    expect(await screen.findByText('#B9')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Contact Swift support' }).getAttribute('href')).toBe('/contact');
    expect(replace).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.path === '/customer/account/deletion-check')).toHaveLength(2);
  });

  it('a connection failure is said in plain words, never as a browser error', async () => {
    const fetchMock = api();
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') throw new TypeError('Failed to fetch');
      return real(input, init);
    });
    const { user } = render();
    await user.click(await screen.findByRole('checkbox'));
    await user.click(mainButton('Delete my account'));
    expect((await screen.findByRole('alert')).textContent).toBe('Swift can’t be reached right now. Check your connection and try again.');
    expect(replace).not.toHaveBeenCalled();
  });

  it('a check that cannot be read is never an all-clear: no button to delete', async () => {
    mockApi(() => ({ status: 503, body: { success: false, error: { code: 'UNAVAILABLE', message: 'Swift is busy' } } }));
    render();
    expect(await screen.findByText(/Couldn.t load what your account still has open/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Delete my account/ })).toBeNull();
  });
});

describe('[WEB-DELETE] a store owner closes by a request the team completes', () => {
  const OWNER: DeletionCheck = { ...CLEAR, closure: 'REQUEST', ownsStore: true };

  it('says new orders stop now, what happens to the store, its team and the weekly fee, sends the closure request (never a delete) and stays signed in', async () => {
    api({ checks: [OWNER, { ...OWNER, closureRequest: { ticketId: 't1', status: 'OPEN', requestedAt: '2026-11-01T12:00:00.000Z', ordersPaused: true } }] });
    const { user } = render('store');
    expect(await screen.findByRole('heading', { name: 'Request account closure', level: 1 })).toBeTruthy();
    expect(screen.getByText(CLOSURE_LEAD)).toBeTruthy();
    const store = screen.getByRole('region', { name: 'What happens to your store' });
    for (const line of STORE_CLOSURE_EFFECTS) expect(within(store).getByText(line)).toBeTruthy();
    expect(within(store).getByText(/^New orders stop now/)).toBeTruthy();
    expect(screen.getByText(STORE_ORDERS_PAUSE_NOW)).toBeTruthy();
    // [owner ruling 1 Nov] The request itself pauses new orders: the old "press Pause new orders" advice is gone.
    expect(screen.queryByText(/Pause new orders/)).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'I want Swift to close my account. I understand my store stops taking new orders now.' }));
    await user.click(mainButton('Request account closure'));
    expect(await screen.findByRole('heading', { name: 'Your closure request is with our team' })).toBeTruthy();
    expect(await screen.findByText(STORE_ORDERS_PAUSED)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/customer/account/closure-request')).toHaveLength(1);
    expect(deletes()).toEqual([]);
    expect(replace).not.toHaveBeenCalled();
    expect(calls.some((c) => c.path.startsWith('/auth/logout'))).toBe(false);
  });

  it('an open request is shown, not sent again; the store\'s live orders are listed but do not stop the request', async () => {
    api({ check: { ...OWNER, closureRequest: { ticketId: 't1', status: 'OPEN', requestedAt: '2026-11-01T12:00:00.000Z', ordersPaused: true },
      openOrders: { count: 1, items: [{ id: 'o1', orderNumber: 'S1', status: 'PREPARING', orderType: 'FOOD_DELIVERY', createdAt: '2026-11-01T10:00:00.000Z', side: 'STORE', storeName: 'Sample Kitchen' }] } } });
    render('store');
    expect(await screen.findByRole('heading', { name: 'Your closure request is with our team' })).toBeTruthy();
    expect(screen.getByText(/We received your request on 1 November 2026/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Before our team can close your account' }).textContent).toContain('#S1 · Preparing · an order at your store Sample Kitchen');
    expect(screen.queryByRole('button', { name: /Request account closure/ })).toBeNull();
  });

  it('the owner can cancel the open request (with a fresh code when asked): the page says the server\'s words and offers the request again', async () => {
    const OPEN = { ...OWNER, closureRequest: { ticketId: 't1', status: 'OPEN', requestedAt: '2026-11-01T12:00:00.000Z', ordersPaused: true } };
    api({ checks: [OPEN, OWNER], stepUp: true });
    const { user } = render('store');
    expect(await screen.findByText(STORE_ORDERS_PAUSED)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel my closure request' }));
    await user.type(await screen.findByLabelText('Code'), '123456');
    expect(await screen.findByText('Your closure request is cancelled. Your store still takes no new orders until you press Resume orders on the Orders page.')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Request account closure', level: 1 })).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/customer/account/closure-request/cancel')).toHaveLength(2);
    expect(calls.some((c) => c.path === '/customer/account/closure-request')).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  it('a cancel the server refuses is said in its words, and the request stays shown', async () => {
    api({ check: { ...OWNER, closureRequest: { ticketId: 't1', status: 'OPEN', requestedAt: '2026-11-01T12:00:00.000Z', ordersPaused: true } },
      cancelReply: { status: 409, body: { success: false, error: { code: 'NO_CLOSURE_REQUEST', message: 'There is no open account closure request to cancel.' } } } });
    const { user } = render('store');
    await user.click(await screen.findByRole('button', { name: 'Cancel my closure request' }));
    expect((await screen.findByRole('alert')).textContent).toBe('There is no open account closure request to cancel.');
    expect(screen.getByRole('heading', { name: 'Your closure request is with our team' })).toBeTruthy();
  });

  it('when the server says closure for an account the check called a deletion, the request is shown and nobody is signed out', async () => {
    api({ checks: [CLEAR, { ...OWNER, closureRequest: { ticketId: 't1', status: 'OPEN', requestedAt: '2026-11-01T12:00:00.000Z', ordersPaused: true } }],
      deleteReply: { status: 202, body: { success: true, data: { deleted: false, status: 'CLOSURE_REQUESTED', ticketId: 't1', message: 'received' } } } });
    const { user } = render('store');
    await user.click(await screen.findByRole('checkbox'));
    await user.click(mainButton('Delete my account'));
    expect(await screen.findByRole('heading', { name: 'Your closure request is with our team' })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('[WEB-DELETE] partners who delete directly are told what it does to their work', () => {
  it('a store manager or staff member leaves the team; the store stays its owner\'s', async () => {
    api();
    render('store');
    const team = await screen.findByRole('region', { name: 'Your store team' });
    for (const line of STAFF_DELETION_EFFECTS) expect(within(team).getByText(line)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'What happens to your store' })).toBeNull();
  });

  it('a rider or driver: offline for good, the weekly fee, documents and cash', async () => {
    api();
    render('mover');
    const mover = await screen.findByRole('region', { name: 'Your rider or driver account' });
    for (const line of MOVER_DELETION_EFFECTS) expect(within(mover).getByText(line)).toBeTruthy();
  });
});
