import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiRequest } from '@/test/test-utils';
import { DeletionReceiptView } from './deletion-receipt';
import { setSelectedStore } from '@/lib/auth';
import { stashDeletionReceipt } from '@/lib/account-deletion';

// ---------------------------------------------------------------------------
// [WEB-DELETE] The deleted page signs the browser out only once the SERVER says no session is left: then it
// expires the HttpOnly cookies (only the server can) and clears what this browser remembers. A browser still
// signed in was not deleted, and a link to this page never signs anyone out.
// ---------------------------------------------------------------------------

const calls: string[] = [];
function api(me: { status: number; body: unknown }) {
  return mockApi(({ method, url }: ApiRequest) => {
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/v1/auth/me') return me;
    if (url.pathname === '/api/v1/auth/logout/refresh') return { body: { success: true } };
    return { status: 404, body: {} };
  });
}
const SIGNED_OUT = { status: 401, body: { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } } };
const expiries = () => calls.filter((c) => c === 'POST /api/v1/auth/logout/refresh');

beforeEach(() => {
  calls.length = 0;
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/account-deleted');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('[WEB-DELETE] the deleted page', () => {
  it('once the server has no session, expires the cookies, forgets the store and shows the server\'s receipt', async () => {
    api(SIGNED_OUT);
    setSelectedStore('store-1');
    stashDeletionReceipt({ deleted: false, status: 'PENDING_LEGAL_HOLD', message: 'Your account is closed. A document under review is kept until 1 February 2027.' });
    window.history.replaceState(null, '', '/account-deleted?status=PENDING_LEGAL_HOLD');
    render(<DeletionReceiptView />);
    expect(await screen.findByRole('heading', { name: 'Your account is closed' })).toBeTruthy();
    expect(screen.getByText('Your account is closed. A document under review is kept until 1 February 2027.')).toBeTruthy();
    expect(screen.getByText(/signed out of Swift in this browser and on every other device/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'What Swift keeps, and for how long' })).toBeTruthy();
    expect(expiries()).toHaveLength(1);
    expect(localStorage.getItem('swift_web_store')).toBeNull();
  });

  it('a full deletion says so in the app\'s words, from the status alone when this tab kept no receipt', async () => {
    api(SIGNED_OUT);
    window.history.replaceState(null, '', '/account-deleted?status=DELETED');
    render(<DeletionReceiptView />);
    expect(await screen.findByRole('heading', { name: 'Your account is deleted' })).toBeTruthy();
    expect(screen.getByText('Your account has been deleted.')).toBeTruthy();
    expect(expiries()).toHaveLength(1);
  });

  it('a browser still signed in was not deleted: it is told so and is NOT signed out', async () => {
    api({ status: 200, body: { success: true, data: { user: { id: 'u1' } } } });
    window.history.replaceState(null, '', '/account-deleted?status=DELETED');
    render(<DeletionReceiptView />);
    expect(await screen.findByRole('heading', { name: 'Your account is still open' })).toBeTruthy();
    expect(screen.queryByText('Your account has been deleted.')).toBeNull();
    expect(expiries()).toEqual([]);
  });

  it('when Swift cannot be reached nothing is cleared on a guess, and it can try again', async () => {
    let up = false;
    mockApi(({ method, url }: ApiRequest) => {
      calls.push(`${method} ${url.pathname}`);
      if (url.pathname === '/api/v1/auth/me') return up ? SIGNED_OUT : { status: 503, body: {} };
      return { body: { success: true } };
    });
    window.history.replaceState(null, '', '/account-deleted?status=DELETED');
    render(<DeletionReceiptView />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/can’t be reached/);
    expect(expiries()).toEqual([]);
    up = true;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Your account is deleted' })).toBeTruthy();
    await waitFor(() => expect(expiries()).toHaveLength(1));
  });

  it('with no deletion to show, it says so rather than claim one', async () => {
    api(SIGNED_OUT);
    render(<DeletionReceiptView />);
    expect(await screen.findByText(/There is no account deletion to show here/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /deleted|closed/ })).toBeNull();
  });
});
