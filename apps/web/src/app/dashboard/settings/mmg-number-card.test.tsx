import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { setSelectedStore } from '@/lib/auth';
import { mmgHoldSentence } from '../../../../../mobile/src/lib/mmgHold';
import { fmtWhen } from '../../../../../mobile/src/lib/stepUp';
import { MMG_NUMBER_WORDS, MmgNumberCard } from './mmg-number-card';

// ---------------------------------------------------------------------------
// [WEB-SETTINGS · owner 31 Oct 2026] The store's MMG number on the website, as the phone's Account > "Your MMG number"
// (MmgNumberCard + VendorAccountScreen): the same PUT /vendor/profile { mmgNumber }, the same "Confirm it's you" before
// it, the same staged change with the old number live and the same "This wasn't me" cancel, in the phone's words.
// The owner changes it; a manager only sees it. Unlike the phone, the website shows the number MASKED only and never
// puts it in a field, an address or the browser's storage. Synthetic numbers only.
// ---------------------------------------------------------------------------

const LIVE = '+5926001234';
const PENDING = '+5926005678';
const APPLY_AT = '2026-11-01T15:00:00.000Z';

type Opts = { role?: string; live?: string | null; pending?: string | null; holdHours?: number | null; stepUp?: boolean; refuse?: string; appliedBeforeCancel?: boolean };
const calls: Array<{ method: string; path: string; url: string; body: unknown }> = [];

function api(opts: Opts = {}) {
  let stepped = !opts.stepUp;
  let live = opts.live === undefined ? LIVE : opts.live;
  let pending = opts.pending ?? null;
  return mockApi(({ method, url, init }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, path, url: url.toString(), body });
    if (path === '/vendor/profile' && method === 'GET') {
      return { body: { success: true, data: { id: 'owner-1', userId: 'user-1', myRole: opts.role ?? 'OWNER', vendors: [
        { id: 'store-1', name: 'Sample Kitchen', vendorType: 'RESTAURANT', mmgNumber: live, mmgNumberPending: pending, mmgNumberApplyAt: pending ? APPLY_AT : null, mmgNumberHoldHours: opts.holdHours === undefined ? 24 : opts.holdHours },
      ] } } };
    }
    if (path === '/auth/step-up') return { body: { success: true, data: { sentTo: '+592 ••• 1234' } } };
    if (path === '/auth/step-up/verify') { stepped = true; return { body: { success: true, data: {} } }; }
    if (path === '/vendor/profile' && method === 'PUT') {
      if (!stepped) return { status: 403, body: { success: false, error: { code: 'STEP_UP_REQUIRED', message: 'Confirm it’s you first.' } } };
      if (opts.refuse) return { status: 400, body: { success: false, error: { code: 'INVALID_MMG_NUMBER', message: opts.refuse } } };
      if (body.mmgNumber === null) { live = null; pending = null; } else pending = '+5926009876';
      return { body: { success: true, data: {} } };
    }
    if (path === '/vendor/profile/mmg-number/pending' && method === 'DELETE') {
      // The API's answer (money-surface.ts cancelMmgLinkChange): cancelled only when a change was still waiting.
      if (opts.appliedBeforeCancel && pending) { live = pending; pending = null; }
      const cancelled = pending !== null;
      pending = null;
      return { body: { success: true, data: { cancelled, revokedSessions: cancelled ? 2 : 0 } } };
    }
    return { body: { success: true, data: {} } };
  });
}

const writes = () => calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/vendor/'));
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const phoneCard = squash(readFileSync(join(process.cwd(), '..', 'mobile', 'src', 'components', 'MmgNumberCard.tsx'), 'utf8'));
const phoneScreen = squash(readFileSync(join(process.cwd(), '..', 'mobile', 'src', 'modules', 'vendor', 'screens', 'VendorAccountScreen.tsx'), 'utf8'));

beforeEach(() => {
  calls.length = 0;
  setSelectedStore('store-1');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('[WEB-SETTINGS] the store\'s MMG number (web)', () => {
  it('the owner sees the live number masked, never in full, and the box starts empty', async () => {
    api();
    renderWithQuery(<MmgNumberCard storeId="store-1" />);
    expect(await screen.findByRole('heading', { name: 'Your MMG number' })).toBeTruthy();
    expect(await screen.findByText('+592 ••• •234')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/600\s?1234/);
    expect((screen.getByLabelText('New MMG number') as HTMLInputElement).value).toBe('');
  });

  it('saving asks "Confirm it\'s you", then sends exactly { mmgNumber } once more, as the phone does', async () => {
    api({ stepUp: true, holdHours: 24 });
    const { user } = renderWithQuery(<MmgNumberCard storeId="store-1" />);
    await user.type(await screen.findByLabelText('New MMG number'), '  +592 600 9876 ');
    // The phone's sentence, with the server's hours, before anything is sent.
    expect(screen.getByText(mmgHoldSentence('number', 24, true))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save number' }));
    await user.type(await screen.findByLabelText('Code'), '654321');
    await waitFor(() => expect(writes().filter((w) => w.method === 'PUT')).toHaveLength(2));
    expect(writes().map((w) => w.body)).toEqual([{ mmgNumber: '+592 600 9876' }, { mmgNumber: '+592 600 9876' }]);
    // After the save the box is emptied; the staged number shows masked from the server's answer.
    await waitFor(() => expect((screen.getByLabelText('New MMG number') as HTMLInputElement).value).toBe(''));
    expect(await screen.findByText('+592 ••• •876')).toBeTruthy();
  });

  it('the payout number never goes into an address, a log line or the browser\'s storage', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    api();
    const { user } = renderWithQuery(<MmgNumberCard storeId="store-1" />);
    await user.type(await screen.findByLabelText('New MMG number'), '+5926009876');
    await user.click(screen.getByRole('button', { name: 'Save number' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    for (const c of calls) expect(c.url).not.toMatch(/9876|1234/);
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toMatch(/9876|1234/);
    for (const spy of [log, info, warn, err]) expect(JSON.stringify(spy.mock.calls)).not.toMatch(/9876|1234/);
  });

  it('the first-ever number gets the server\'s 1-hour words; no live number says customers can\'t choose MMG yet', async () => {
    api({ live: null, holdHours: 1 });
    const { user } = renderWithQuery(<MmgNumberCard storeId="store-1" />);
    expect(await screen.findByText('Cash only')).toBeTruthy();
    await user.type(screen.getByLabelText('New MMG number'), '+5926009876');
    expect(screen.getByText(mmgHoldSentence('number', 1, false))).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove number' })).toBeNull();
  });

  it('a staged change shows when it takes effect, masked, and the owner can cancel it ("This wasn\'t me")', async () => {
    api({ pending: PENDING });
    const { user } = renderWithQuery(<MmgNumberCard storeId="store-1" />);
    expect(await screen.findByText(`New number takes effect ${fmtWhen(APPLY_AT)}`)).toBeTruthy();
    expect(screen.getByText('+592 ••• •678')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/600\s?5678/);
    expect(screen.getByText(MMG_NUMBER_WORDS.untilKeep)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: MMG_NUMBER_WORDS.cancel }));
    await waitFor(() => expect(writes()).toEqual([expect.objectContaining({ method: 'DELETE', path: '/vendor/profile/mmg-number/pending' })]));
    expect(await screen.findByText(MMG_NUMBER_WORDS.cancelled)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('+592 ••• •678')).toBeNull());
  });

  it('a cancel the server did not make (the change already went live) is never shown as cancelled: it warns and re-reads', async () => {
    api({ pending: PENDING, appliedBeforeCancel: true });
    const { user } = renderWithQuery(<MmgNumberCard storeId="store-1" />);
    await user.click(await screen.findByRole('button', { name: MMG_NUMBER_WORDS.cancel }));
    expect((await screen.findByRole('alert')).textContent).toBe(MMG_NUMBER_WORDS.notCancelled);
    expect(screen.queryByText(MMG_NUMBER_WORDS.cancelled)).toBeNull();
    // Re-read: the number that went live is shown (masked), so the owner can check it.
    expect(await screen.findByText('+592 ••• •678')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/vendor/profile').length).toBeGreaterThanOrEqual(2);
  });

  it('removing the number goes through the same confirmation and sends { mmgNumber: null }', async () => {
    api({ stepUp: true });
    const { user } = renderWithQuery(<MmgNumberCard storeId="store-1" />);
    await user.click(await screen.findByRole('button', { name: 'Remove number' }));
    await user.type(await screen.findByLabelText('Code'), '654321');
    await waitFor(() => expect(writes().filter((w) => w.method === 'PUT')).toHaveLength(2));
    expect(writes().at(-1)!.body).toEqual({ mmgNumber: null });
    expect(await screen.findByText('Cash only')).toBeTruthy();
  });

  it('the server\'s refusal is shown in its own words', async () => {
    api({ refuse: 'MMG works on a mobile number. Enter the mobile number your MMG account uses, like +592 600 1234.' });
    const { user } = renderWithQuery(<MmgNumberCard storeId="store-1" />);
    await user.type(await screen.findByLabelText('New MMG number'), '+5922251234');
    await user.click(screen.getByRole('button', { name: 'Save number' }));
    expect((await screen.findByRole('alert')).textContent).toBe('MMG works on a mobile number. Enter the mobile number your MMG account uses, like +592 600 1234.');
  });

  it('closing "Confirm it\'s you" is not an error, and nothing is saved', async () => {
    api({ stepUp: true });
    const { user } = renderWithQuery(<MmgNumberCard storeId="store-1" />);
    await user.type(await screen.findByLabelText('New MMG number'), '+5926009876');
    await user.click(screen.getByRole('button', { name: 'Save number' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText('Code')).toBeNull());
    expect(screen.queryAllByRole('alert')).toEqual([]);
    expect(writes().filter((w) => w.method === 'PUT')).toHaveLength(1);
  });

  it('a manager sees the number masked and cannot change it or cancel a change (owner only, as the phone)', async () => {
    api({ role: 'MANAGER', pending: PENDING });
    renderWithQuery(<MmgNumberCard storeId="store-1" />);
    expect(await screen.findByText('+592 ••• •234')).toBeTruthy();
    expect(screen.getByText(MMG_NUMBER_WORDS.ownerOnly)).toBeTruthy();
    expect(screen.queryByLabelText('New MMG number')).toBeNull();
    expect(screen.queryByRole('button', { name: MMG_NUMBER_WORDS.cancel })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save number|Remove number/ })).toBeNull();
  });

  it('staff are not shown the card', async () => {
    api({ role: 'STAFF' });
    renderWithQuery(<MmgNumberCard storeId="store-1" />);
    await waitFor(() => expect(calls.some((c) => c.path === '/vendor/profile')).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('heading', { name: 'Your MMG number' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/•234/);
  });

  it('every sentence is the phone\'s own (MmgNumberCard.tsx, VendorAccountScreen.tsx)', () => {
    for (const words of [MMG_NUMBER_WORDS.title, MMG_NUMBER_WORDS.about, MMG_NUMBER_WORDS.ownerOnly, MMG_NUMBER_WORDS.cancel,
      MMG_NUMBER_WORDS.untilKeep, MMG_NUMBER_WORDS.untilCash, MMG_NUMBER_WORDS.waiting, MMG_NUMBER_WORDS.takesEffect, MMG_NUMBER_WORDS.cashOnly]) {
      expect(phoneCard, words).toContain(words);
    }
    for (const words of [MMG_NUMBER_WORDS.saveFailed, 'Your current number stays. Other devices were signed out.', 'Try again in a moment.']) {
      expect(phoneScreen, words).toContain(words);
    }
    expect(MMG_NUMBER_WORDS.cancelled).toBe('Change cancelled. Your current number stays. Other devices were signed out.');
  });
});
