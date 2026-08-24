import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from './authSession';
import type { AdEventScope, AdServeResponse } from './adsCore';

const mocks = vi.hoisted(() => ({
  values: new Map<string, string>(),
  currentSession: null as AuthSessionSnapshot | null,
  currentScope: { kind: 'ANONYMOUS', scopeId: 'guest-1', generation: 0 } as AdEventScope,
  uuidSequence: 0,
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  rawPost: vi.fn(),
  addAppStateListener: vi.fn(),
}));

vi.mock('react-native-mmkv', () => ({
  MMKV: class MockMMKV {
    getString(key: string) {
      return mocks.values.get(key);
    }

    set(key: string, value: string) {
      mocks.values.set(key, value);
    }

    delete(key: string) {
      mocks.values.delete(key);
    }
  },
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: mocks.addAppStateListener },
  Linking: { openURL: vi.fn(async () => undefined) },
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => `ad-test-${++mocks.uuidSequence}`,
}));

vi.mock('../services/api', () => ({
  API_URL: 'http://localhost:3000',
  api: { get: mocks.apiGet, post: mocks.apiPost },
}));

vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => mocks.currentSession,
  getAdEventTrackingScope: () => mocks.currentScope,
}));

vi.mock('axios', () => ({
  default: { post: mocks.rawPost },
}));

const accepted = (count: number) => ({
  data: { data: { results: Array.from({ length: count }, () => 'accepted' as const) } },
});

function authenticatedScope(scopeId: string, generation: number): AdEventScope {
  return { kind: 'AUTHENTICATED', scopeId, generation };
}

function authenticatedSession(
  userId: string,
  scope: AdEventScope,
  accessToken = `access-${userId}`,
): AuthSessionSnapshot {
  return {
    userId,
    generation: scope.generation,
    accessToken,
    refreshToken: `refresh-${userId}`,
    adEventScopeId: scope.scopeId,
  };
}

const servedAds: AdServeResponse = {
  placements: {
    home_top_card: {
      rotationSeconds: null,
      ttlSeconds: 300,
      items: [],
    },
  },
  _house: { home_top_card: false },
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.values.clear();
  mocks.uuidSequence = 0;
  mocks.currentSession = null;
  mocks.currentScope = { kind: 'ANONYMOUS', scopeId: 'guest-1', generation: 0 };
  vi.clearAllMocks();
  mocks.apiGet.mockReset();
  mocks.apiPost.mockImplementation(async (_url, body) => accepted(body.events.length));
  mocks.rawPost.mockImplementation(async (_url, body) => accepted(body.events.length));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('principal-bound ad event runtime', () => {
  it('restarts the flush loop when a cold launch restores queued work', async () => {
    mocks.values.set('events', JSON.stringify([{
      id: 'restored-event',
      scope: mocks.currentScope,
      token: 'restored-token',
      eventType: 'IMPRESSION',
      occurredAt: new Date().toISOString(),
      attempts: 0,
      retryAt: 0,
    }]));

    await import('./ads');

    expect(mocks.addAppStateListener).toHaveBeenCalledOnce();
    expect(mocks.addAppStateListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('keeps a guest event anonymous after B logs in', async () => {
    const ads = await import('./ads');
    const guestScope = mocks.currentScope;
    ads.trackAdEvent('guest-token', 'IMPRESSION', guestScope);

    const bScope = authenticatedScope('b-scope', 1);
    mocks.currentScope = bScope;
    mocks.currentSession = authenticatedSession('b', bScope);

    await ads.flushAdEvents();

    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(mocks.rawPost).toHaveBeenCalledOnce();
    expect(mocks.rawPost.mock.calls[0]?.[0]).toBe('http://localhost:3000/api/v1/ads/events');
    expect(mocks.rawPost.mock.calls[0]?.[1].events).toEqual([
      expect.objectContaining({ token: 'guest-token', eventType: 'IMPRESSION' }),
    ]);
    expect(mocks.rawPost.mock.calls[0]?.[1].events[0]).not.toHaveProperty('scope');
    expect(mocks.rawPost.mock.calls[0]?.[1].events[0]).not.toHaveProperty('id');
    expect(mocks.rawPost.mock.calls[0]?.[2].headers).not.toHaveProperty('Authorization');
  });

  it('never borrows B credentials for an A event, even before retirement', async () => {
    const aScope = authenticatedScope('a-scope', 1);
    mocks.currentScope = aScope;
    mocks.currentSession = authenticatedSession('a', aScope);
    const ads = await import('./ads');
    ads.trackAdEvent('a-token', 'VIEWABLE_IMPRESSION', aScope);

    const bScope = authenticatedScope('b-scope', 2);
    mocks.currentScope = bScope;
    mocks.currentSession = authenticatedSession('b', bScope);
    await ads.flushAdEvents();

    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(mocks.rawPost).not.toHaveBeenCalled();
  });

  it('does not cross from one login generation into a same-user reauthentication', async () => {
    const firstScope = authenticatedScope('a-scope-first', 1);
    mocks.currentScope = firstScope;
    mocks.currentSession = authenticatedSession('a', firstScope);
    const ads = await import('./ads');
    ads.trackAdEvent('a-token', 'IMPRESSION', firstScope);

    const secondScope = authenticatedScope('a-scope-second', 2);
    mocks.currentScope = secondScope;
    mocks.currentSession = authenticatedSession('a', secondScope);
    await ads.flushAdEvents();

    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(mocks.rawPost).not.toHaveBeenCalled();
  });

  it('lets delayed A retirement preserve and flush B with B-pinned credentials', async () => {
    const aScope = authenticatedScope('a-scope', 1);
    mocks.currentScope = aScope;
    mocks.currentSession = authenticatedSession('a', aScope);
    const ads = await import('./ads');
    const queue = await import('./adsQueue');
    ads.trackAdEvent('same-token', 'IMPRESSION', aScope);

    const bScope = authenticatedScope('b-scope', 2);
    mocks.currentScope = bScope;
    mocks.currentSession = authenticatedSession('b', bScope, 'fresh-access-b');
    ads.trackAdEvent('same-token', 'IMPRESSION', bScope);
    queue.retireAdEventScope(aScope);

    await ads.flushAdEvents();

    expect(mocks.apiPost).toHaveBeenCalledOnce();
    expect(mocks.apiPost.mock.calls[0]?.[1].events).toEqual([
      expect.objectContaining({ token: 'same-token', eventType: 'IMPRESSION' }),
    ]);
    expect(mocks.apiPost.mock.calls[0]?.[2].headers.Authorization).toBe('Bearer fresh-access-b');
  });

  it('uses a freshly rotated token while preserving the same owner scope', async () => {
    const scope = authenticatedScope('a-scope', 1);
    mocks.currentScope = scope;
    mocks.currentSession = authenticatedSession('a', scope, 'access-a-old');
    const ads = await import('./ads');
    ads.trackAdEvent('a-token', 'CLICK', scope);

    mocks.currentSession = authenticatedSession('a', scope, 'access-a-new');
    await ads.flushAdEvents();

    expect(mocks.apiPost.mock.calls[0]?.[2].headers.Authorization).toBe('Bearer access-a-new');
  });

  it('does not let a deferred A verdict remove B with the same token and type', async () => {
    const aScope = authenticatedScope('a-scope', 1);
    mocks.currentScope = aScope;
    mocks.currentSession = authenticatedSession('a', aScope);
    const ads = await import('./ads');
    ads.trackAdEvent('same-token', 'IMPRESSION', aScope);

    let resolveA!: (value: ReturnType<typeof accepted>) => void;
    mocks.apiPost.mockImplementationOnce(() => new Promise((resolve) => {
      resolveA = resolve;
    }));
    const aFlush = ads.flushAdEvents();
    await Promise.resolve();
    expect(mocks.apiPost).toHaveBeenCalledOnce();

    const bScope = authenticatedScope('b-scope', 2);
    mocks.currentScope = bScope;
    mocks.currentSession = authenticatedSession('b', bScope);
    ads.trackAdEvent('same-token', 'IMPRESSION', bScope);
    resolveA(accepted(1));
    await aFlush;

    await ads.flushAdEvents();
    expect(mocks.apiPost).toHaveBeenCalledTimes(2);
    expect(mocks.apiPost.mock.calls[1]?.[1].events).toEqual([
      expect.objectContaining({ token: 'same-token', eventType: 'IMPRESSION' }),
    ]);
    expect(mocks.apiPost.mock.calls[1]?.[2].headers.Authorization).toBe('Bearer access-b');
  });

  it('makes cached content display-only across scopes but trackable for its owner', async () => {
    const aScope = authenticatedScope('a-scope', 1);
    mocks.currentScope = aScope;
    mocks.currentSession = authenticatedSession('a', aScope);
    mocks.apiGet.mockResolvedValueOnce({ data: { data: servedAds } });
    const ads = await import('./ads');

    await expect(ads.fetchAds('*', ['home_top_card'])).resolves.toMatchObject({
      trackable: true,
      trackingScope: aScope,
    });

    mocks.apiGet.mockRejectedValue(new Error('offline'));
    await expect(ads.fetchAds('*', ['home_top_card'])).resolves.toMatchObject({
      trackable: true,
      trackingScope: aScope,
    });

    const bScope = authenticatedScope('b-scope', 2);
    mocks.currentScope = bScope;
    mocks.currentSession = authenticatedSession('b', bScope);
    await expect(ads.fetchAds('*', ['home_top_card'])).resolves.toMatchObject({
      data: servedAds,
      trackable: false,
      trackingScope: null,
    });
  });

  it('purges the persisted fallback after a block boundary', async () => {
    mocks.apiGet.mockResolvedValueOnce({ data: { data: servedAds } });
    const ads = await import('./ads');

    await expect(ads.fetchAds('*', ['home_top_card'])).resolves.toMatchObject({ data: servedAds });
    expect(mocks.values.has('serve')).toBe(true);

    ads.clearAdServeCache();
    expect(mocks.values.has('serve')).toBe(false);

    mocks.apiGet.mockRejectedValueOnce(new Error('offline'));
    await expect(ads.fetchAds('*', ['home_top_card'])).resolves.toEqual({
      data: null,
      trackable: false,
      trackingScope: null,
    });
  });
});
