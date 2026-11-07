import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn() }), usePathname: () => '/dashboard/branches/add' }));
// The map picker is a map; here it confirms a fixed pin.
vi.mock('@/app/signup/store-picker-loader', () => ({
  loadStorePicker: async () => ({
    StoreLocationPicker: ({ onConfirm }: { onConfirm: (_p: { latitude: number; longitude: number; address: string | null }) => void }) => (
      <button type="button" onClick={() => onConfirm({ latitude: 6.81, longitude: -58.16, address: '2 Camp Street' })}>Use this pin</button>
    ),
  }),
}));
import AddBranchPage from './page';

// ---------------------------------------------------------------------------
// [CHAINS PR2 · owner 29 Oct 2026] Add a branch on the website. The terms are the server's: this branch's weekly
// fee, ticked for this branch; the shared trial holds only if Swift approves the branch before it ends (REVIEW-M
// #2211 S4-2); the trial is the business's, a branch closed during it still uses it up (N1); the chain's agreed rate.
// The add asks this browser to confirm it's you, then is sent once more.
// ---------------------------------------------------------------------------

const FOOD_TICK = 'Everyone who handles food here holds a current food handler’s certificate.';
const TERMS = { version: 'v1', items: [{ heading: 'When it starts', text: 'After Swift approves the store.' }], tick: 'I understand the weekly fee' };
const posts: Array<{ path: string; body: unknown }> = [];

function api(opts: { trialEnds?: string | null; role?: string; stepUp?: boolean; feeChangedOnce?: boolean; sameAmount?: boolean; noFood?: boolean } = {}) {
  let stepped = !opts.stepUp;
  let feeChanged = !!opts.feeChangedOnce;
  let amount = 15000;
  return mockApi(({ method, url, init }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (method === 'POST') posts.push({ path, body });
    if (path === '/vendor/stores' && method === 'GET') return { body: { success: true, data: { stores: [{ id: 'north', name: 'Royal North', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'north', myRole: opts.role ?? 'OWNER' } } };
    if (path === '/vendor/stores/branch-terms') return { body: { success: true, data: {
      weeklyFee: { amount, currencyCode: 'GYD', tier: 'SMALL', version: 'v1' }, terms: TERMS,
      sharedTrialEndsAt: opts.trialEnds === undefined ? '2026-11-05T16:00:00.000Z' : opts.trialEnds, stores: 1, limit: 50,
      dealWeeklyRate: 12000, dealCurrencyCode: 'GYD',
      foodHandlers: opts.noFood ? null : { version: 'v1', tick: FOOD_TICK },
    } } };
    if (path === '/auth/step-up') return { body: { success: true, data: { sentTo: '+592 ••• 1234' } } };
    if (path === '/auth/step-up/verify') { stepped = true; return { body: { success: true, data: {} } }; }
    if (path === '/vendor/stores' && method === 'POST') {
      if (!stepped) return { status: 403, body: { success: false, error: { code: 'STEP_UP_REQUIRED', message: 'Confirm it’s you first.' } } };
      if (feeChanged) { feeChanged = false; if (!opts.sameAmount) amount = 20000; return { status: 409, body: { success: false, error: { code: 'WEEKLY_FEE_CHANGED', message: 'The weekly fee has changed. Read it again and tick to continue.' } } }; }
      return { status: 201, body: { success: true, data: { id: 'camp', name: 'Royal Camp', status: 'PENDING_APPROVAL' } } };
    }
    return { status: 404, body: { success: false } };
  });
}

async function fill(user: Awaited<ReturnType<typeof renderWithQuery>>['user']) {
  await user.type(await screen.findByLabelText('Branch name'), 'Royal Camp');
  await user.clear(screen.getByLabelText(/^Branch phone/));
  await user.type(screen.getByLabelText(/^Branch phone/), '+5926001234');
  await user.clear(screen.getByLabelText('The number customers can call'));
  await user.type(screen.getByLabelText('The number customers can call'), '+592 600 7788');
  await user.type(screen.getByLabelText('Street address'), '2 Camp Street');
  await user.type(screen.getByLabelText('City or town'), 'Georgetown');
  await user.click(screen.getByRole('button', { name: 'Place the branch on the map' }));
  await user.click(await screen.findByRole('button', { name: 'Use this pin' }));
}

beforeEach(async () => {
  posts.length = 0;
  nav.push.mockReset();
  (await import('@/lib/auth')).setSelectedStore('north');
});

describe('[CHAINS] add a branch (web)', () => {
  it('states the terms: own fee, the shared trial only if approved before it ends, the trial is the business\'s, the agreed rate', async () => {
    api();
    renderWithQuery(<AddBranchPage />);
    expect(await screen.findByText('Each branch pays its own weekly fee: $15,000/week.')).toBeTruthy();
    expect(screen.getByText('Free until 5 November 2026 if Swift approves it before 5 November 2026. After that, $15,000/week.')).toBeTruthy();
    expect(screen.getByText('The free trial belongs to your business, not to one branch: a branch you close during the free trial still uses it up.')).toBeTruthy();
    expect(screen.getByText('Your agreed rate: $12,000/week (or the branch’s own fee, if lower).')).toBeTruthy();
    expect(screen.getByText('A person at Swift checks every new branch before it goes live. If a branch still needs something from you first, the Branches page says what is left and where to do it on this website.')).toBeTruthy();
    expect(screen.queryByText(/with a button to finish it/)).toBeNull();
    // [REVIEW-F #2220 f710ebda N1] The header never promises no documents: a branch of another type can owe its own.
    expect(screen.getByText('A new store of your business, under this same login. Documents Swift already checked are not asked again.')).toBeTruthy();
    expect(screen.queryByText(/Your documents are not asked again/)).toBeNull();
    expect(screen.queryByText(/You’ll see it as waiting for Swift’s approval/)).toBeNull();
  });

  it('with no running trial: billed from the day Swift approves it', async () => {
    api({ trialEnds: null });
    renderWithQuery(<AddBranchPage />);
    expect(await screen.findByText('Billed from the day Swift approves it: $15,000/week.')).toBeTruthy();
  });

  it('sends the branch and the fee ticked for it; confirms it\'s you, then sends it once more; goes to the branches', async () => {
    api({ stepUp: true });
    const { user } = renderWithQuery(<AddBranchPage />);
    await fill(user);
    const add = screen.getByRole('button', { name: 'Add this branch' }) as HTMLButtonElement;
    expect(add.disabled, 'nothing is sent before the fee is ticked').toBe(true);
    await user.click(await screen.findByRole('checkbox', { name: 'I understand the weekly fee' }));
    await user.click(add);
    const code = await screen.findByLabelText('Code');
    expect(await screen.findByText('To confirm this account change, we texted a code to +592 ••• 1234.')).toBeTruthy();
    await user.type(code, '123456');
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/dashboard/branches'));
    const sends = posts.filter((p) => p.path === '/vendor/stores');
    expect(sends).toHaveLength(2);
    expect(sends[1]!.body).toEqual({
      business: { name: 'Royal Camp', vendorType: 'RESTAURANT', phone: '+5926001234', addressLine1: '2 Camp Street', city: 'Georgetown', latitude: 6.81, longitude: -58.16 },
      weeklyFeeAck: { version: 'v1', amount: 15000, currencyCode: 'GYD' },
      publicPhone: '+592 600 7788',
    });
    expect(posts.find((p) => p.path === '/auth/step-up/verify')?.body).toEqual({ code: '123456' });
  });

  // [REVIEW-F #2220 S3-1] What go-live needs from the owner comes with the add.
  it('the branch phone is labelled as Swift\'s private line; the number customers can call is asked with its disclosure and is required', async () => {
    api();
    const { user } = renderWithQuery(<AddBranchPage />);
    expect(await screen.findByLabelText('Branch phone (Swift\'s contact line for the branch; customers don\'t see it)')).toBeTruthy();
    expect(screen.queryByText(/customers see it\)/)).toBeNull();
    expect(screen.getByLabelText('The number customers can call').getAttribute('aria-describedby')).toBe('call-us-help');
    expect(document.getElementById('call-us-help')?.textContent).toMatch(/This is separate from the number you sign in with, which stays private\./);
    await fill(user);
    await user.click(await screen.findByRole('checkbox', { name: 'I understand the weekly fee' }));
    await user.clear(screen.getByLabelText('The number customers can call'));
    expect((screen.getByRole('button', { name: 'Add this branch' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a restaurant\'s food handlers tick, in the server\'s words: sent only when ticked; another business type is not asked', async () => {
    api();
    const { user } = renderWithQuery(<AddBranchPage />);
    await fill(user);
    await user.click(await screen.findByRole('checkbox', { name: 'I understand the weekly fee' }));
    await user.click(await screen.findByRole('checkbox', { name: FOOD_TICK }));
    await user.click(screen.getByRole('button', { name: 'Add this branch' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/dashboard/branches'));
    const sent = posts.filter((p) => p.path === '/vendor/stores').at(-1)!.body as Record<string, unknown>;
    expect(sent['foodHandlers']).toEqual({ accept: true, attestationVersion: 'v1' });
  });

  it('no food handlers tick sent when it is not ticked, or when the server asks none', async () => {
    api({ noFood: true });
    const { user } = renderWithQuery(<AddBranchPage />);
    await fill(user);
    await user.click(await screen.findByRole('checkbox', { name: 'I understand the weekly fee' }));
    expect(screen.queryByRole('checkbox', { name: FOOD_TICK })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add this branch' }));
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    expect(posts.filter((p) => p.path === '/vendor/stores').at(-1)!.body).not.toHaveProperty('foodHandlers');
  });

  it('a fee that changed: the terms are read again and the tick is asked again', async () => {
    api({ feeChangedOnce: true });
    const { user } = renderWithQuery(<AddBranchPage />);
    await fill(user);
    await user.click(await screen.findByRole('checkbox', { name: 'I understand the weekly fee' }));
    await user.click(screen.getByRole('button', { name: 'Add this branch' }));
    expect(await screen.findByText('The weekly fee has changed. Read it again and tick to continue.')).toBeTruthy();
    expect(await screen.findByText('Each branch pays its own weekly fee: $20,000/week.')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'I understand the weekly fee' }) as HTMLInputElement).checked).toBe(false);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('a refused tick is asked again even when the price read back is the same', async () => {
    api({ feeChangedOnce: true, sameAmount: true });
    const { user } = renderWithQuery(<AddBranchPage />);
    await fill(user);
    await user.click(await screen.findByRole('checkbox', { name: 'I understand the weekly fee' }));
    await user.click(screen.getByRole('button', { name: 'Add this branch' }));
    expect(await screen.findByText('The weekly fee has changed. Read it again and tick to continue.')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'I understand the weekly fee' }) as HTMLInputElement).checked).toBe(false);
  });

  it('a manager cannot add a branch', async () => {
    api({ role: 'MANAGER' });
    renderWithQuery(<AddBranchPage />);
    expect(await screen.findByText('Only the store owner can add a branch.')).toBeTruthy();
  });
});
