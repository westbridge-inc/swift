import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// [row 205 · DS256 F2] A safety check-in or ride notification tapped after the
// session ended landed nowhere after signing back in: the tap was routed at
// once into a root that does not mount its screen (the picker, sign-in), and
// the queue it fell into was flushed only when navigation first loaded.
// Now the tap opens sign-in and waits; it lands once the SAME account is back
// through every root gate, and is dropped silently for anyone else.
// Real: the router. Fake: the native notification + navigation edges, and the
// auth store's three reads the router makes.
const fx = vi.hoisted(() => ({
  owner: null as null | { userId: string; generation: number },
  lastSignedOut: null as string | null,
  ready: true,
  navigate: vi.fn(),
  promptLogin: vi.fn(),
  listener: undefined as undefined | ((response: unknown) => void),
}));
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (listener: typeof fx.listener) => { fx.listener = listener; return { remove: vi.fn() }; },
  getLastNotificationResponseAsync: () => Promise.resolve(null),
}));
vi.mock('../navigation/navigationRef', () => ({ navigationRef: { isReady: () => fx.ready }, safeNavigate: fx.navigate }));
vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => (fx.owner ? { ...fx.owner } : null),
  getLastSignedOutUserId: () => fx.lastSignedOut,
  useAuthStore: { getState: () => ({ intent: 'customer', promptLogin: fx.promptLogin }) },
}));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null, storeGeneration: 0 }) } }));

import { installNotificationTapRouter, settleTapAfterSignIn } from './notification-router';

const checkIn = { kind: 'guardian_checkin', orderId: 'ride-1' };
const rideNotice = { kind: 'ride_queue_matched', orderId: 'ride-2' };
const orderNotice = { kind: 'substitution_pending', orderId: 'order-3' };

const pickerSignedOut = { isAuthenticated: false, wantsAuth: false, entryGate: 'role-picker' };
const signingIn = { isAuthenticated: false, wantsAuth: true, entryGate: 'auth' };
const selfieGate = { isAuthenticated: true, wantsAuth: false, entryGate: 'selfie' };
const inApp = { isAuthenticated: true, wantsAuth: false, entryGate: 'main' };

function tap(data: Record<string, unknown>) {
  fx.listener!({ notification: { request: { identifier: 'n', content: { data } } }, actionIdentifier: 'default' });
}
const signIn = (userId: string) => { fx.owner = { userId, generation: 7 }; };
const screens = () => fx.navigate.mock.calls.map(([screen, params]) => [screen, params]);

let uninstall: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  fx.owner = null; fx.lastSignedOut = 'rider-a'; fx.ready = true;
  fx.navigate.mockReturnValue(true);
  uninstall = installNotificationTapRouter();
});
afterEach(() => { uninstall(); });

describe('a notification tapped after sign-out', () => {
  it.each([
    ['a safety check-in', checkIn, ['Taxi', undefined]],
    ['a ride notice', rideNotice, ['Taxi', undefined]],
    ['an order notice', orderNotice, ['Delivery', { orderId: 'order-3' }]],
  ] as const)('%s opens sign-in, waits through every root gate, then lands for the same account', async (_name, data, landing) => {
    tap(data);
    expect(fx.navigate).not.toHaveBeenCalled(); // never into a root that does not mount it
    expect(fx.promptLogin).toHaveBeenCalledOnce();

    expect(settleTapAfterSignIn(signingIn)).toBe('waiting');
    signIn('rider-a');
    expect(settleTapAfterSignIn(selfieGate)).toBe('waiting');
    expect(fx.navigate).not.toHaveBeenCalled();

    expect(settleTapAfterSignIn(inApp)).toBe('delivered');
    await vi.waitFor(() => expect(screens()).toEqual([landing]));
    expect(settleTapAfterSignIn(inApp)).toBe('none'); // one-shot
  });

  it('is dropped silently when a different account signs in, at whichever gate it is seen', async () => {
    tap(checkIn);
    signIn('rider-b');
    expect(settleTapAfterSignIn(selfieGate)).toBe('dropped');
    expect(settleTapAfterSignIn(inApp)).toBe('none');
    signIn('rider-a'); // even the owner coming back later gets nothing
    expect(settleTapAfterSignIn(inApp)).toBe('none');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fx.navigate).not.toHaveBeenCalled();
  });

  it('is dropped when the sign-in it opened is cancelled', () => {
    tap(checkIn);
    expect(settleTapAfterSignIn(pickerSignedOut)).toBe('dropped');
    signIn('rider-a');
    expect(settleTapAfterSignIn(inApp)).toBe('none');
    expect(fx.navigate).not.toHaveBeenCalled();
  });

  it('with no known owner (a cold start after sign-out) is not held and does not ask anyone to sign in', () => {
    fx.lastSignedOut = null;
    tap(checkIn);
    expect(fx.promptLogin).not.toHaveBeenCalled();
    signIn('rider-a');
    expect(settleTapAfterSignIn(inApp)).toBe('none');
    expect(fx.navigate).not.toHaveBeenCalled();
  });

  it('yields to any newer tap: the newest one wins, an unknown one opens the app normally', async () => {
    tap(checkIn);
    tap(orderNotice);
    signIn('rider-a');
    expect(settleTapAfterSignIn(inApp)).toBe('delivered');
    await vi.waitFor(() => expect(screens()).toEqual([['Delivery', { orderId: 'order-3' }]]));

    fx.navigate.mockClear(); fx.promptLogin.mockClear(); fx.owner = null;
    tap(checkIn);
    tap({ kind: 'kind_nothing_sends' });
    expect(fx.promptLogin).toHaveBeenCalledOnce(); // only the check-in asked
    signIn('rider-a');
    expect(settleTapAfterSignIn(inApp)).toBe('none');
    expect(fx.navigate).not.toHaveBeenCalled();
  });

  it('waits for the navigation container before it routes', async () => {
    tap(checkIn);
    signIn('rider-a');
    fx.ready = false;
    expect(settleTapAfterSignIn(inApp)).toBe('waiting');
    fx.ready = true;
    expect(settleTapAfterSignIn(inApp)).toBe('delivered');
    await vi.waitFor(() => expect(screens()).toEqual([['Taxi', undefined]]));
  });

  it('does not survive the router being torn down', () => {
    tap(checkIn);
    uninstall();
    uninstall = installNotificationTapRouter();
    signIn('rider-a');
    expect(settleTapAfterSignIn(inApp)).toBe('none');
  });

  it('a tap while signed in still routes at once, with no sign-in prompt', async () => {
    signIn('rider-a');
    tap(checkIn);
    await vi.waitFor(() => expect(screens()).toEqual([['Taxi', undefined]]));
    expect(fx.promptLogin).not.toHaveBeenCalled();
    expect(settleTapAfterSignIn(inApp)).toBe('none');
  });

  it('is settled by the root navigator on every root-gate change: after commit when the app root is open, at once otherwise', () => {
    const src = readFileSync(new URL('../navigation/RootNavigator.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/import \{[^}]*\bsettleTapAfterSignIn\b[^}]*\} from '\.\.\/services\/notification-router';/);
    const effect = src.slice(src.indexOf('const settle = () => { settleTapAfterSignIn('));
    expect(effect).toMatch(/^const settle = \(\) => \{ settleTapAfterSignIn\(\{ isAuthenticated, wantsAuth, entryGate \}\); \};/);
    expect(effect).toMatch(/if \(!isAuthenticated \|\| entryGate !== 'main'\) \{ settle\(\); return; \}/);
    expect(effect).toMatch(/setTimeout\(settle, 0\);[\s\S]*setTimeout\(settle, 250\);/);
    expect(effect).toMatch(/\}, \[entryGate, isAuthenticated, sessionGeneration, wantsAuth\]\);/);
  });
});
