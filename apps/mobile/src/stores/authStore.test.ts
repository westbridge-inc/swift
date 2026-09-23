import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@swift/types';

const { setSelectedStore, clearQueryClient, retireAdEventScope, scopeSequence } = vi.hoisted(() => ({
  setSelectedStore: vi.fn(),
  clearQueryClient: vi.fn(),
  retireAdEventScope: vi.fn(),
  scopeSequence: { value: 0 },
}));

const storageData = new Map<string, string>();
const preparePushTokenForLogout = vi.fn(async () => 'ExponentPushToken[device-a]');
const revokeAuthSession = vi.fn(async () => undefined);
const stopMoverLocation = vi.fn(async () => undefined);
const disconnectSocket = vi.fn(() => undefined);

vi.mock('../lib/storage', () => ({
  zustandStorage: {
    getItem: (key: string) => storageData.get(key) ?? null,
    setItem: (key: string, value: string) => storageData.set(key, value),
    removeItem: (key: string) => storageData.delete(key),
  },
}));
vi.mock('../lib/queryClient', () => ({ queryClient: { clear: clearQueryClient } }));
vi.mock('../lib/adsQueue', () => ({ retireAdEventScope }));
vi.mock('expo-crypto', () => ({
  randomUUID: () => `test-ad-scope-${++scopeSequence.value}`,
}));
vi.mock('../services/push', () => ({ preparePushTokenForLogout }));
vi.mock('../services/api', () => ({ revokeAuthSession }));
vi.mock('../services/backgroundLocation', () => ({ stopMoverLocation }));
vi.mock('../services/socket', () => ({ disconnectSocket }));
vi.mock('./storeSwitcher', () => ({
  useStoreSwitcher: { getState: () => ({ setSelectedStore }) },
}));

import {
  AuthSessionBoundaryError,
  getAuthSessionSnapshot,
  requireAuthSessionForPrincipal,
  useAuthStore,
} from './authStore';
import { AuthRefreshCoordinator } from '../lib/authSession';
import { rootEntryGate } from '../navigation/rootEntryGate';
import { hydrationCounters, resetHydrationCountersForTests } from '../lib/authHydration';
import { readFileSync } from 'node:fs';
import { logoutAndSwitchExperience } from '../modules/advertiser/advertiserExit';
import { useBookingStore } from './bookingStore';
import { useVendorPreview } from './vendorPreview';

const priorIntents = ['customer', 'mover', 'vendor', 'advertiser'] as const;

function user(id: string): User {
  return {
    id,
    firstName: id,
    lastName: 'Test',
    phone: `+592${id}`,
    roles: ['CUSTOMER'],
    activeRole: 'CUSTOMER',
  } as unknown as User;
}

function authenticatedIntent(intent: (typeof priorIntents)[number]) {
  useAuthStore.getState().setAuth(
    { ...user(intent), selfieCapturedAt: new Date(0).toISOString() } as unknown as User,
    `access-${intent}`,
    `refresh-${intent}`,
  );
  useAuthStore.setState({
    intent,
    wantsAuth: true,
    moverPreset: 'taxi',
    countryCode: 'GY',
    dialCode: '+592',
    currencyCode: 'GYD',
    currencySymbol: 'GY$',
  });
  return getAuthSessionSnapshot()!;
}

function currentRootEntryGate() {
  const state = useAuthStore.getState();
  return rootEntryGate({
    isAuthenticated: state.isAuthenticated,
    wantsAuth: state.wantsAuth,
    intent: state.intent,
    countryCode: state.countryCode,
    anyPreview: false,
    needsSelfie: state.isAuthenticated && !!state.user && !(state.user as any).selfieCapturedAt,
  });
}

function expectLoggedOutAtExperiencePicker() {
  expect(useAuthStore.getState()).toMatchObject({
    user: null,
    accessToken: null,
    refreshToken: null,
    isAuthenticated: false,
    wantsAuth: false,
    intent: null,
    moverPreset: null,
    countryCode: 'GY',
    dialCode: '+592',
    currencyCode: 'GYD',
    currencySymbol: 'GY$',
  });
  expect(currentRootEntryGate()).toBe('role-picker');
}

beforeEach(() => {
  storageData.clear();
  vi.clearAllMocks();
  scopeSequence.value = 0;
  useBookingStore.getState().clear();
  useAuthStore.setState({
    user: null,
    accessToken: null,
    refreshToken: null,
    isAuthenticated: false,
    isLoading: false,
    wantsAuth: false,
    intent: null,
    moverPreset: null,
    countryCode: null,
    dialCode: null,
    currencyCode: null,
    currencySymbol: null,
    sessionGeneration: 0,
    adEventScopeId: 'test-anonymous-scope',
  });
});

describe('authStore session boundaries', () => {
  it('clears a fresh guest Home cache before interactive login', () => {
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    useAuthStore.getState().setAuth(user('a'), 'access-a', 'refresh-a');
    expect(clearQueryClient).toHaveBeenCalledOnce();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it.each(priorIntents)(
    'returns a signed-out %s session to the experience picker while retaining country',
    (intent) => {
      authenticatedIntent(intent);

      useAuthStore.getState().logout();

      expectLoggedOutAtExperiencePicker();
    },
  );

  it.each(priorIntents)(
    'returns an authoritatively expired %s session to the experience picker',
    (intent) => {
      const captured = authenticatedIntent(intent);
      useBookingStore.getState().setAppointment('shared-service-item', {
        slotStart: '2026-08-09T14:00:00.000Z',
      });

      expect(useAuthStore.getState().logoutIfCurrent(captured)).toBe(true);

      expectLoggedOutAtExperiencePicker();
      expect(useBookingStore.getState().appointments).toEqual({});
      expect(retireAdEventScope).toHaveBeenCalledWith({
        kind: 'AUTHENTICATED',
        scopeId: captured.adEventScopeId,
        generation: captured.generation,
      });
    },
  );

  it('returns sign-out from the mandatory selfie gate to the experience picker', () => {
    useAuthStore.getState().setAuth(user('selfie'), 'access-selfie', 'refresh-selfie');
    useAuthStore.setState({
      intent: 'vendor',
      countryCode: 'GY',
      dialCode: '+592',
      currencyCode: 'GYD',
      currencySymbol: 'GY$',
    });
    expect(currentRootEntryGate()).toBe('selfie');

    useAuthStore.getState().logout();

    expectLoggedOutAtExperiencePicker();
  });

  it('routes an authoritative refresh rejection through guarded logout to the picker', async () => {
    const captured = authenticatedIntent('customer');
    const coordinator = new AuthRefreshCoordinator(
      {
        current: getAuthSessionSnapshot,
        rotateTokensIfCurrent: (expected, tokens) => (
          useAuthStore.getState().rotateTokensIfCurrent(expected, tokens)
        ),
        logoutIfCurrent: (expected) => useAuthStore.getState().logoutIfCurrent(expected),
      },
      async () => {
        throw Object.assign(new Error('refresh rejected'), { status: 401 });
      },
      (error) => (error as { status?: number }).status === 401,
    );

    await expect(coordinator.resolve(captured)).resolves.toBeNull();

    expectLoggedOutAtExperiencePicker();
  });

  it('keeps the advertiser exit wrapper compatible with the central logout invariant', () => {
    authenticatedIntent('advertiser');
    const state = useAuthStore.getState();

    logoutAndSwitchExperience({ setIntent: state.setIntent, logout: state.logout });

    expectLoggedOutAtExperiencePicker();
  });

  it('rotates tokens only for the exact captured session', () => {
    useAuthStore.getState().setAuth(user('a'), 'access-a-1', 'refresh-a-1');
    const captured = getAuthSessionSnapshot()!;

    expect(useAuthStore.getState().rotateTokensIfCurrent(captured, {
      accessToken: 'access-a-2',
      refreshToken: 'refresh-a-2',
    })).toMatchObject({ accessToken: 'access-a-2', refreshToken: 'refresh-a-2' });

    expect(useAuthStore.getState().rotateTokensIfCurrent(captured, {
      accessToken: 'stale',
      refreshToken: 'stale',
    })).toBeNull();
    expect(getAuthSessionSnapshot()).toMatchObject({
      userId: 'a',
      accessToken: 'access-a-2',
      refreshToken: 'refresh-a-2',
    });
  });

  it('restores the same opaque ad owner across a cold hydration and token rotation', async () => {
    useAuthStore.getState().setAuth(user('a'), 'access-a-1', 'refresh-a-1');
    const original = getAuthSessionSnapshot()!;
    useAuthStore.getState().rotateTokensIfCurrent(original, {
      accessToken: 'access-a-2',
      refreshToken: 'refresh-a-2',
    });
    const durableState = storageData.get('swift-auth')!;

    useAuthStore.setState({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      sessionGeneration: 0,
      adEventScopeId: 'new-process-default',
    });
    storageData.set('swift-auth', durableState);
    await useAuthStore.persist.rehydrate();

    expect(getAuthSessionSnapshot()).toMatchObject({
      userId: 'a',
      generation: original.generation,
      adEventScopeId: original.adEventScopeId,
      accessToken: 'access-a-2',
      refreshToken: 'refresh-a-2',
    });
  });

  it('durably migrates a legacy authenticated v1 owner before a second cold start', async () => {
    storageData.set('swift-auth', JSON.stringify({
      version: 1,
      state: {
        user: user('legacy-a'),
        accessToken: 'legacy-access-a',
        refreshToken: 'legacy-refresh-a',
        isAuthenticated: true,
        intent: 'customer',
        moverPreset: null,
        countryCode: 'GY',
        dialCode: '+592',
        currencyCode: 'GYD',
        currencySymbol: 'GY$',
      },
    }));

    await useAuthStore.persist.rehydrate();
    const firstBoot = getAuthSessionSnapshot()!;
    const migratedStorage = storageData.get('swift-auth')!;
    expect(JSON.parse(migratedStorage)).toMatchObject({
      version: 2,
      state: {
        sessionGeneration: firstBoot.generation,
        adEventScopeId: firstBoot.adEventScopeId,
      },
    });

    useAuthStore.setState({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      sessionGeneration: 0,
      adEventScopeId: 'second-process-default',
    });
    storageData.set('swift-auth', migratedStorage);
    await useAuthStore.persist.rehydrate();

    expect(getAuthSessionSnapshot()).toMatchObject({
      userId: 'legacy-a',
      generation: firstBoot.generation,
      adEventScopeId: firstBoot.adEventScopeId,
    });
  });

  it('captures A teardown credentials and cannot disturb B after synchronous logout', async () => {
    useAuthStore.getState().setAuth(user('a'), 'access-a', 'refresh-a');
    const aSession = getAuthSessionSnapshot()!;
    useBookingStore.getState().setAppointment('shared-service-item', {
      slotStart: '2026-08-09T14:00:00.000Z',
      mode: 'AT_BUSINESS',
    });

    useAuthStore.getState().logout();
    expect(getAuthSessionSnapshot()).toBeNull();
    expect(useBookingStore.getState().appointments).toEqual({});
    expect(retireAdEventScope).toHaveBeenCalledWith({
      kind: 'AUTHENTICATED',
      scopeId: aSession.adEventScopeId,
      generation: aSession.generation,
    });
    expect(setSelectedStore).toHaveBeenCalledWith(null);
    useAuthStore.getState().setAuth(user('b'), 'access-b', 'refresh-b');

    await vi.waitFor(() => {
      expect(preparePushTokenForLogout).toHaveBeenCalledWith(aSession);
      expect(revokeAuthSession).toHaveBeenCalledWith(
        'refresh-a',
        'ExponentPushToken[device-a]',
      );
    });
    expect(getAuthSessionSnapshot()).toMatchObject({
      userId: 'b',
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
    });
    expect(stopMoverLocation).toHaveBeenCalledWith(aSession);
    expect(disconnectSocket).toHaveBeenCalledWith(aSession);
  });

  it('ignores a stale refresh failure after a new principal boundary', () => {
    useAuthStore.getState().setAuth(user('a'), 'access-a', 'refresh-a');
    const staleA = getAuthSessionSnapshot()!;
    useAuthStore.getState().logout();
    useAuthStore.getState().setAuth(user('b'), 'access-b', 'refresh-b');
    useBookingStore.getState().setAppointment('b-service-item', {
      slotStart: '2026-08-10T15:00:00.000Z',
    });
    retireAdEventScope.mockClear();

    expect(useAuthStore.getState().logoutIfCurrent(staleA)).toBe(false);
    expect(getAuthSessionSnapshot()).toMatchObject({ userId: 'b', accessToken: 'access-b' });
    expect(useBookingStore.getState().appointments).toEqual({
      'b-service-item': { slotStart: '2026-08-10T15:00:00.000Z' },
    });
    expect(retireAdEventScope).not.toHaveBeenCalled();
  });

  it('fully tears A down before a direct interactive B replacement', async () => {
    useAuthStore.getState().setAuth(user('a'), 'access-a', 'refresh-a');
    const accountA = getAuthSessionSnapshot()!;
    useBookingStore.getState().setAppointment('shared-service-item', {
      slotStart: '2026-08-09T14:00:00.000Z',
      mode: 'MOBILE',
    });
    vi.clearAllMocks();

    useAuthStore.getState().setAuth(user('b'), 'access-b', 'refresh-b');

    expect(clearQueryClient).toHaveBeenCalledOnce();
    expect(useBookingStore.getState().appointments).toEqual({});
    expect(retireAdEventScope).toHaveBeenCalledWith({
      kind: 'AUTHENTICATED',
      scopeId: accountA.adEventScopeId,
      generation: accountA.generation,
    });
    expect(setSelectedStore).toHaveBeenCalledWith(null);
    expect(getAuthSessionSnapshot()).toMatchObject({
      generation: 2,
      userId: 'b',
      accessToken: 'access-b',
    });
    await vi.waitFor(() => {
      expect(preparePushTokenForLogout).toHaveBeenCalledWith(accountA);
      expect(stopMoverLocation).toHaveBeenCalledWith(accountA);
      expect(disconnectSocket).toHaveBeenCalledWith(accountA);
    });
  });

  it('cannot apply an A user update after B becomes current', () => {
    useAuthStore.getState().setAuth(user('a'), 'access-a', 'refresh-a');
    const staleA = getAuthSessionSnapshot()!;
    useAuthStore.getState().logout();
    useAuthStore.getState().setAuth(user('b'), 'access-b', 'refresh-b');

    const updated = useAuthStore.getState().setUserIfCurrent(
      staleA,
      { ...user('a'), firstName: 'Overwritten by stale A' },
    );

    expect(updated).toBe(false);
    expect(useAuthStore.getState().setIntentIfCurrent(staleA, 'mover')).toBe(false);
    expect(getAuthSessionSnapshot()).toMatchObject({ userId: 'b', accessToken: 'access-b' });
    expect(useAuthStore.getState().user?.firstName).toBe('b');
  });

  it('continues the same principal with freshly rotated credentials', () => {
    useAuthStore.getState().setAuth(user('a'), 'access-a-1', 'refresh-a-1');
    const owner = getAuthSessionSnapshot()!;
    useAuthStore.getState().rotateTokensIfCurrent(owner, {
      accessToken: 'access-a-2',
      refreshToken: 'refresh-a-2',
    });

    expect(requireAuthSessionForPrincipal(owner)).toMatchObject({
      userId: 'a',
      accessToken: 'access-a-2',
      refreshToken: 'refresh-a-2',
    });
    expect(useAuthStore.getState().setUserIfCurrent(
      owner,
      { ...user('a'), firstName: 'A after safe rotation' },
    )).toBe(true);
    expect(useAuthStore.getState().user?.firstName).toBe('A after safe rotation');
  });

  it('fails a continuation lease after another principal logs in', () => {
    useAuthStore.getState().setAuth(user('a'), 'access-a', 'refresh-a');
    const staleA = getAuthSessionSnapshot()!;
    useAuthStore.getState().logout();
    useAuthStore.getState().setAuth(user('b'), 'access-b', 'refresh-b');

    expect(() => requireAuthSessionForPrincipal(staleA)).toThrow(AuthSessionBoundaryError);
    expect(getAuthSessionSnapshot()).toMatchObject({ userId: 'b' });
  });
});

describe('[MOB-007 / TST-008] corrupt persisted auth normalizes SIGNED OUT before the first privileged render', () => {
  const persisted = (state: Record<string, unknown>, version = 2) => storageData.set('swift-auth', JSON.stringify({ version, state }));
  const base = () => ({
    user: user('a'), accessToken: 'access-a', refreshToken: 'refresh-a', isAuthenticated: true, intent: 'customer', moverPreset: null,
    countryCode: 'GY', dialCode: '+592', currencyCode: 'GYD', currencySymbol: 'GY$', sessionGeneration: 3, adEventScopeId: 'scope-a',
  });
  const freshProcess = () => {
    resetHydrationCountersForTests();
    clearQueryClient.mockClear();
    setSelectedStore.mockClear();
    useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false, intent: null, moverPreset: null, sessionGeneration: 0, adEventScopeId: 'process-default' });
  };

  const cases: Array<[string, Record<string, unknown>, string, number?]> = [
    ['authenticated with a null user', { ...base(), user: null }, 'authenticated_without_user'],
    ['a user without an id', { ...base(), user: { ...user('a'), id: '' } }, 'user_without_id'],
    ['no access token', { ...base(), accessToken: null }, 'missing_access_token'],
    ['an empty refresh token', { ...base(), refreshToken: '' }, 'missing_refresh_token'],
    ['credentials without the authenticated flag', { ...base(), isAuthenticated: false }, 'credentials_without_authentication'],
    ['an invalid generation', { ...base(), sessionGeneration: 1.5 }, 'invalid_generation'],
    ['an empty scope', { ...base(), adEventScopeId: '' }, 'invalid_scope'],
    ['malformed roles', { ...base(), user: { ...user('a'), roles: 'CUSTOMER' } }, 'invalid_roles'],
    ['an active role outside the roles', { ...base(), user: { ...user('a'), activeRole: 'VENDOR' } }, 'invalid_active_role'],
    ['a tuple from a future schema version', base(), 'unknown_version', 3],
    ['a legacy v1 tuple missing its refresh token', (() => { const v1: Record<string, unknown> = { ...base(), refreshToken: null }; delete v1['sessionGeneration']; delete v1['adEventScopeId']; return v1; })(), 'missing_refresh_token', 1],
  ];
  for (const [label, state, reason, version] of cases) {
    it(`${label} → signed out, caches cleared, boundary advanced, reason ${reason}`, async () => {
      freshProcess();
      persisted(state, version);
      await useAuthStore.persist.rehydrate();
      const s = useAuthStore.getState();
      expect(s.isAuthenticated).toBe(false);
      expect(getAuthSessionSnapshot()).toBeNull();
      expect(s.user).toBeNull();
      expect(s.accessToken).toBeNull();
      expect(s.refreshToken).toBeNull();
      expect(s.intent).toBeNull();
      expect(s.countryCode).toBe('GY'); // device context is not session context
      // the boundary advances past a VALID persisted generation; an unreadable one restarts at 1
      const g = state['sessionGeneration'];
      expect(s.sessionGeneration).toBe(typeof g === 'number' && Number.isSafeInteger(g) && g >= 0 ? g + 1 : 1);
      expect(s.adEventScopeId).not.toBe('scope-a');
      expect(clearQueryClient).toHaveBeenCalled();
      expect(setSelectedStore).toHaveBeenCalledWith(null);
      expect(hydrationCounters()).toEqual({ [reason]: 1 });
      // the root gate for this state can never be the main stack
      expect(rootEntryGate({ isAuthenticated: s.isAuthenticated, wantsAuth: false, intent: s.intent, countryCode: s.countryCode, anyPreview: false, needsSelfie: false })).toBe('role-picker');
      // durable: storage now holds the normalized tuple, so the next boot is a plain signed-out hydration
      expect(JSON.parse(storageData.get('swift-auth')!)).toMatchObject({ version: 2, state: { isAuthenticated: false, user: null, accessToken: null, refreshToken: null } });
      clearQueryClient.mockClear();
      await useAuthStore.persist.rehydrate();
      expect(hydrationCounters()).toEqual({ [reason]: 1, signed_out: 1 });
      expect(clearQueryClient).not.toHaveBeenCalled();
    });
  }

  it('a fully consistent v2 tuple hydrates authenticated, unchanged, reason ok, nothing cleared', async () => {
    freshProcess();
    persisted(base());
    await useAuthStore.persist.rehydrate();
    expect(getAuthSessionSnapshot()).toMatchObject({ userId: 'a', generation: 3, accessToken: 'access-a', refreshToken: 'refresh-a', adEventScopeId: 'scope-a' });
    expect(hydrationCounters()).toEqual({ ok: 1 });
    expect(clearQueryClient).not.toHaveBeenCalled();
  });

  it('unreadable storage hydrates nothing and is counted', async () => {
    freshProcess();
    storageData.set('swift-auth', '{not json');
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(getAuthSessionSnapshot()).toBeNull();
    expect(hydrationCounters()).toEqual({ unreadable: 1 });
  });

  it('the root navigator no longer makes the selfie gate conditional on a user being present', () => {
    const src = readFileSync(new URL('../navigation/RootNavigator.tsx', import.meta.url), 'utf8');
    expect(src).toContain('const needsSelfie = isAuthenticated && !user?.selfieCapturedAt;');
    expect(src).not.toContain('isAuthenticated && !!user && !user.selfieCapturedAt');
    // an authenticated state with no user can only reach 'selfie', never 'main'
    expect(rootEntryGate({ isAuthenticated: true, wantsAuth: false, intent: 'customer', countryCode: 'GY', anyPreview: false, needsSelfie: true })).toBe('selfie');
  });
});

// ---------------------------------------------------------------------------
// Business-entry state is principal-scoped, like the store selection above.
//
// A non-null vendor `previewType` switches EVERY vendor hook to canned sample
// data, disables the real profile query and turns every mutation into a no-op.
// It lived in a process-global store that no session boundary cleared, so a
// guest who walked the sample dashboard and then signed in to a real business
// saw "Georgetown Grill" instead of their own store — real orders hidden, every
// action answered "Preview is read-only". A half-typed List-your-business form
// is the same kind of state: it belongs to exactly one signed-in account.
// ---------------------------------------------------------------------------
describe('business-entry state never crosses a principal boundary', () => {
  const draftStore = async () => (await import('./businessSetupDraft')).useBusinessSetupDraft;
  const typedForm = { name: 'Kitty Bakes', phone: '6001234', addr: '12 Regent Street', agree: true };

  beforeEach(() => {
    useVendorPreview.getState().exitPreview();
  });

  it('a guest who walked the sample dashboard signs in to their real account, not the sample', () => {
    useVendorPreview.getState().enterPreview('SUPERMARKET');

    useAuthStore.getState().setAuth(user('vendor-a'), 'access-a', 'refresh-a');

    expect(useVendorPreview.getState()).toMatchObject({ preview: false, previewType: null });
  });

  it.each([
    ['the sample dashboard', () => useVendorPreview.getState().enterPreview('RESTAURANT')],
    ['the pending-vendor peek', () => useVendorPreview.getState().enterPreview()],
  ])('logout ends %s', (_label, enter) => {
    authenticatedIntent('vendor');
    enter();

    useAuthStore.getState().logout();

    expect(useVendorPreview.getState()).toMatchObject({ preview: false, previewType: null });
    expectLoggedOutAtExperiencePicker();
  });

  it('an authoritative session expiry ends the preview', () => {
    const captured = authenticatedIntent('vendor');
    useVendorPreview.getState().enterPreview();

    expect(useAuthStore.getState().logoutIfCurrent(captured)).toBe(true);

    expect(useVendorPreview.getState()).toMatchObject({ preview: false, previewType: null });
  });

  it('a direct A → B replacement ends A’s preview', () => {
    useAuthStore.getState().setAuth(user('a'), 'access-a', 'refresh-a');
    useVendorPreview.getState().enterPreview('STORE');

    useAuthStore.getState().setAuth(user('b'), 'access-b', 'refresh-b');

    expect(useVendorPreview.getState()).toMatchObject({ preview: false, previewType: null });
  });

  it('a guest leaving the sample dashboard by its header sign-out lands at the welcome with nothing left behind', () => {
    useAuthStore.setState({ intent: 'vendor', countryCode: 'GY' });
    useVendorPreview.getState().enterPreview('SERVICE');

    useAuthStore.getState().logout();

    expect(useVendorPreview.getState()).toMatchObject({ preview: false, previewType: null });
    expect(useAuthStore.getState().intent).toBeNull();
    expect(currentRootEntryGate()).toBe('role-picker');
  });

  it('logout discards the signed-in account’s half-typed business form', async () => {
    const drafts = await draftStore();
    const owner = authenticatedIntent('vendor');
    drafts.getState().update(owner, typedForm);

    useAuthStore.getState().logout();

    expect(drafts.getState().owner).toBeNull();
    expect(drafts.getState().draft).toMatchObject({ name: '', phone: '', addr: '', agree: false });
  });

  it('an authoritative session expiry discards the business form', async () => {
    const drafts = await draftStore();
    const owner = authenticatedIntent('vendor');
    drafts.getState().update(owner, typedForm);

    expect(useAuthStore.getState().logoutIfCurrent(owner)).toBe(true);

    expect(drafts.getState().owner).toBeNull();
    expect(drafts.getState().draft.name).toBe('');
  });

  it('a direct A → B replacement never hands A’s business form to B', async () => {
    const drafts = await draftStore();
    useAuthStore.getState().setAuth(user('a'), 'access-a', 'refresh-a');
    const accountA = getAuthSessionSnapshot()!;
    drafts.getState().update(accountA, typedForm);

    useAuthStore.getState().setAuth(user('b'), 'access-b', 'refresh-b');

    expect(drafts.getState().owner).toBeNull();
    expect(drafts.getState().draft).toMatchObject({ name: '', phone: '', addr: '', agree: false });
  });

  it('a token refresh keeps the same account’s form and preview', async () => {
    const drafts = await draftStore();
    useAuthStore.getState().setAuth(user('a'), 'access-a-1', 'refresh-a-1');
    const owner = getAuthSessionSnapshot()!;
    drafts.getState().update(owner, typedForm);
    useVendorPreview.getState().enterPreview();

    useAuthStore.getState().rotateTokensIfCurrent(owner, {
      accessToken: 'access-a-2',
      refreshToken: 'refresh-a-2',
    });

    expect(drafts.getState().draft).toMatchObject(typedForm);
    expect(useVendorPreview.getState()).toMatchObject({ preview: true, previewType: null });
  });
});
