import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot, RotatedAuthTokens } from '../lib/authSession';

const auth = vi.hoisted(() => {
  const previousApiUrl = process.env['EXPO_PUBLIC_API_URL'];
  delete process.env['EXPO_PUBLIC_API_URL'];
  const devGlobal = globalThis as typeof globalThis & { __DEV__?: boolean };
  const previousDev = devGlobal.__DEV__;
  devGlobal.__DEV__ = true;
  return {
    current: null as AuthSessionSnapshot | null,
    logoutCalls: 0,
    rotateCalls: 0,
    selectedStoreId: null as string | null,
    previousApiUrl,
    previousDev,
  };
});

function sameSession(left: AuthSessionSnapshot | null, right: AuthSessionSnapshot): boolean {
  return !!left
    && left.generation === right.generation
    && left.userId === right.userId
    && left.refreshToken === right.refreshToken;
}

vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => auth.current,
  isAuthSessionSnapshotCurrent: (expected: AuthSessionSnapshot) => sameSession(auth.current, expected),
  useAuthStore: {
    getState: () => ({
      rotateTokensIfCurrent: (expected: AuthSessionSnapshot, tokens: RotatedAuthTokens) => {
        auth.rotateCalls += 1;
        if (!sameSession(auth.current, expected)) return null;
        auth.current = { ...expected, ...tokens };
        return auth.current;
      },
      logoutIfCurrent: (expected: AuthSessionSnapshot) => {
        auth.logoutCalls += 1;
        if (!sameSession(auth.current, expected)) return false;
        auth.current = null;
        return true;
      },
    }),
  },
}));

vi.mock('../stores/storeSwitcher', () => ({
  useStoreSwitcher: { getState: () => ({ selectedStoreId: auth.selectedStoreId }) },
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: {} },
}));

vi.mock('react-native', () => ({
  TurboModuleRegistry: {
    get: () => ({
      getConstants: () => ({
        scriptURL: 'http://10.0.2.2:8081/index.bundle?platform=android',
      }),
    }),
  },
}));

import {
  API_URL,
  adsApi,
  api,
  authApi,
  courierApi,
  customerApi,
  driverApi,
  partnerApi,
  riderApi,
  servicesApi,
  verificationApi,
  vendorApi,
} from './api';

const originalAxiosAdapter = axios.defaults.adapter;
const originalApiAdapter = api.defaults.adapter;

const accountA: AuthSessionSnapshot = {
  generation: 1,
  userId: 'account-a',
  accessToken: 'access-a-1',
  refreshToken: 'refresh-a-1',
};

const accountB: AuthSessionSnapshot = {
  generation: 3,
  userId: 'account-b',
  accessToken: 'access-b-1',
  refreshToken: 'refresh-b-1',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown,
): AxiosResponse {
  return {
    config,
    status,
    statusText: status === 200 ? 'OK' : 'Unauthorized',
    headers: {},
    data,
  };
}

function unauthorized(config: InternalAxiosRequestConfig): Promise<never> {
  const result = response(config, 401, { error: 'unauthorized' });
  return Promise.reject(new AxiosError(
    'Request failed with status code 401',
    AxiosError.ERR_BAD_REQUEST,
    config,
    undefined,
    result,
  ));
}

function setAdapter(adapter: AxiosAdapter): void {
  axios.defaults.adapter = adapter;
  api.defaults.adapter = adapter;
}

function authorization(config: InternalAxiosRequestConfig): string | undefined {
  const value = config.headers.get('Authorization');
  return typeof value === 'string' ? value : undefined;
}

beforeEach(() => {
  auth.current = { ...accountA };
  auth.logoutCalls = 0;
  auth.rotateCalls = 0;
  auth.selectedStoreId = null;
});

afterEach(() => {
  axios.defaults.adapter = originalAxiosAdapter;
  api.defaults.adapter = originalApiAdapter;
  vi.restoreAllMocks();
});

afterAll(() => {
  if (auth.previousApiUrl === undefined) {
    delete process.env['EXPO_PUBLIC_API_URL'];
  } else {
    process.env['EXPO_PUBLIC_API_URL'] = auth.previousApiUrl;
  }
  const devGlobal = globalThis as typeof globalThis & { __DEV__?: boolean };
  if (auth.previousDev === undefined) {
    delete devGlobal.__DEV__;
  } else {
    devGlobal.__DEV__ = auth.previousDev;
  }
});

describe('API origin integration', () => {
  it('uses the native SourceCode host for the shared Axios base URL', () => {
    expect(API_URL).toBe('http://10.0.2.2:3000');
    expect(api.defaults.baseURL).toBe('http://10.0.2.2:3000/api/v1');
  });
});

describe('Axios auth interceptor integration', () => {
  it('captures A at the exact API invocation before an immediate synchronous B login', async () => {
    const seen: string[] = [];
    setAdapter(async (config) => {
      seen.push(authorization(config) ?? 'none');
      return response(config, 200, { ok: true });
    });

    const request = api.post('/state-changing-action', { value: 1 });
    auth.current = { ...accountB };

    await expect(request).resolves.toMatchObject({ status: 200 });
    expect(seen).toEqual(['Bearer access-a-1']);
    expect(auth.current).toEqual(accountB);
  });

  it('single-flights concurrent 401 responses and retries both with the rotated A token', async () => {
    const refresh = deferred<AxiosResponse>();
    let refreshCalls = 0;
    const attempts = new Map<string, string[]>();

    setAdapter(async (config) => {
      const url = config.url ?? '';
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return refresh.promise;
      }
      const seen = attempts.get(url) ?? [];
      seen.push(authorization(config) ?? 'none');
      attempts.set(url, seen);
      if (seen.length === 1) return unauthorized(config);
      return response(config, 200, { ok: true });
    });

    const first = api.get('/first');
    const second = api.get('/second');
    await vi.waitFor(() => expect(refreshCalls).toBe(1));

    const refreshConfig = { headers: axios.AxiosHeaders.from({}) } as InternalAxiosRequestConfig;
    refresh.resolve(response(refreshConfig, 200, {
      data: { accessToken: 'access-a-2', refreshToken: 'refresh-a-2' },
    }));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(attempts.get('/first')).toEqual(['Bearer access-a-1', 'Bearer access-a-2']);
    expect(attempts.get('/second')).toEqual(['Bearer access-a-1', 'Bearer access-a-2']);
    expect(auth.current).toMatchObject({ userId: 'account-a', accessToken: 'access-a-2' });
  });

  it('never refreshes or retries a stale A request after B becomes current', async () => {
    const initial = deferred<void>();
    const seen: string[] = [];
    let refreshCalls = 0;

    setAdapter(async (config) => {
      if ((config.url ?? '').endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return response(config, 200, {
          data: { accessToken: 'unexpected', refreshToken: 'unexpected' },
        });
      }
      seen.push(authorization(config) ?? 'none');
      await initial.promise;
      return unauthorized(config);
    });

    const request = api.post('/state-changing-action', { value: 1 });
    await vi.waitFor(() => expect(seen).toEqual(['Bearer access-a-1']));
    auth.current = { ...accountB };
    initial.resolve();

    await expect(request).rejects.toMatchObject({ response: { status: 401 } });
    expect(seen).toEqual(['Bearer access-a-1']);
    expect(refreshCalls).toBe(0);
    expect(auth.current).toEqual(accountB);
  });

  it('discards a late successful A refresh after B logs in and does not replay A', async () => {
    const refresh = deferred<AxiosResponse>();
    let requestCalls = 0;
    let refreshCalls = 0;

    setAdapter(async (config) => {
      if ((config.url ?? '').endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return refresh.promise;
      }
      requestCalls += 1;
      return unauthorized(config);
    });

    const request = api.post('/state-changing-action', { value: 1 });
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    auth.current = { ...accountB };

    const refreshConfig = { headers: axios.AxiosHeaders.from({}) } as InternalAxiosRequestConfig;
    refresh.resolve(response(refreshConfig, 200, {
      data: { accessToken: 'stale-access-a-2', refreshToken: 'stale-refresh-a-2' },
    }));

    await expect(request).rejects.toMatchObject({ response: { status: 401 } });
    expect(requestCalls).toBe(1);
    expect(auth.current).toEqual(accountB);
  });

  it('does not log B out when A refresh rejects after B logs in', async () => {
    const refresh = deferred<AxiosResponse>();
    let requestCalls = 0;
    let refreshCalls = 0;

    setAdapter(async (config) => {
      if ((config.url ?? '').endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return refresh.promise;
      }
      requestCalls += 1;
      return unauthorized(config);
    });

    const request = api.post('/state-changing-action', { value: 1 });
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    auth.current = { ...accountB };
    const refreshConfig = { headers: axios.AxiosHeaders.from({}) } as InternalAxiosRequestConfig;
    refresh.reject(new AxiosError(
      'A refresh was rejected',
      AxiosError.ERR_BAD_REQUEST,
      refreshConfig,
      undefined,
      response(refreshConfig, 401, { error: 'revoked' }),
    ));

    await expect(request).rejects.toMatchObject({ response: { status: 401 } });
    expect(requestCalls).toBe(1);
    expect(auth.logoutCalls).toBe(1);
    expect(auth.current).toEqual(accountB);
  });

  it.each([
    ['network failure', () => new AxiosError('Network Error', AxiosError.ERR_NETWORK)],
    ['timeout', () => new AxiosError('timeout exceeded', AxiosError.ECONNABORTED)],
    ['server 500', (config: InternalAxiosRequestConfig) => new AxiosError(
      'Request failed with status code 500',
      AxiosError.ERR_BAD_RESPONSE,
      config,
      undefined,
      response(config, 500, { error: 'temporary failure' }),
    )],
  ])('keeps A signed in when refresh has a non-authoritative %s', async (_label, failure) => {
    let refreshCalls = 0;
    setAdapter(async (config) => {
      if ((config.url ?? '').endsWith('/auth/refresh')) {
        refreshCalls += 1;
        throw failure(config);
      }
      return unauthorized(config);
    });

    await expect(api.post('/state-changing-action', { value: 1 }))
      .rejects.toMatchObject({ response: { status: 401 } });
    expect(refreshCalls).toBe(1);
    expect(auth.logoutCalls).toBe(0);
    expect(auth.current).toEqual(accountA);
  });

  it.each([401, 403])(
    'logs out the same current account after an authoritative refresh %i',
    async (refreshStatus) => {
    let refreshCalls = 0;
    setAdapter(async (config) => {
      if ((config.url ?? '').endsWith('/auth/refresh')) {
        refreshCalls += 1;
        const rejected = response(config, refreshStatus, { error: 'revoked' });
        throw new AxiosError(
          `Request failed with status code ${refreshStatus}`,
          AxiosError.ERR_BAD_REQUEST,
          config,
          undefined,
          rejected,
        );
      }
      return unauthorized(config);
    });

    await expect(api.post('/state-changing-action', { value: 1 }))
      .rejects.toMatchObject({ response: { status: 401 } });
    expect(refreshCalls).toBe(1);
    expect(auth.logoutCalls).toBe(1);
    expect(auth.current).toBeNull();
    },
  );

  it('guards a refresh retry from entering a second refresh loop', async () => {
    let requestCalls = 0;
    let refreshCalls = 0;

    setAdapter(async (config) => {
      if ((config.url ?? '').endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return response(config, 200, {
          data: { accessToken: 'access-a-2', refreshToken: 'refresh-a-2' },
        });
      }
      requestCalls += 1;
      return unauthorized(config);
    });

    await expect(api.post('/state-changing-action', { value: 1 }))
      .rejects.toMatchObject({ response: { status: 401 } });
    expect(requestCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });

  it('keeps a refresh retry pinned to the store selected at invocation', async () => {
    auth.selectedStoreId = 'store-a';
    const stores: string[] = [];
    let requestCalls = 0;

    setAdapter(async (config) => {
      if ((config.url ?? '').endsWith('/auth/refresh')) {
        auth.selectedStoreId = 'store-b';
        return response(config, 200, {
          data: { accessToken: 'access-a-2', refreshToken: 'refresh-a-2' },
        });
      }
      requestCalls += 1;
      stores.push(String(config.headers.get('x-vendor-id') ?? 'none'));
      if (requestCalls === 1) return unauthorized(config);
      return response(config, 200, { data: { id: 'item-a' } });
    });

    await expect(vendorApi.createItem({
      categoryId: 'category-a',
      name: 'Item A',
      basePrice: 100,
    }, accountA)).resolves.toMatchObject({ status: 200 });
    expect(stores).toEqual(['store-a', 'store-a']);
    expect(auth.selectedStoreId).toBe('store-b');
  });

  it('pins every request in an item-save chain to its original store', async () => {
    auth.selectedStoreId = 'store-b';
    const stores: string[] = [];
    setAdapter(async (config) => {
      stores.push(String(config.headers.get('x-vendor-id') ?? 'none'));
      return response(config, 200, { data: { id: 'item-a' } });
    });
    const form = new FormData();

    await vendorApi.createItem({
      categoryId: 'category-a',
      name: 'Item A',
      basePrice: 100,
    }, accountA, 'store-a');
    await vendorApi.updateItem('item-a', { name: 'Updated A' }, accountA, 'store-a');
    await vendorApi.uploadItemImage('item-a', form, accountA, 'store-a');
    await vendorApi.importItems('category,name\nFood,Item', accountA, 'store-a');
    await vendorApi.importAutomap('category,name\nFood,Item', accountA, 'store-a');
    await vendorApi.importXlsx(form, accountA, 'store-a');
    await vendorApi.importMenuPdf(form, accountA, 'store-a');

    expect(stores).toEqual([
      'store-a',
      'store-a',
      'store-a',
      'store-a',
      'store-a',
      'store-a',
      'store-a',
    ]);
    expect(auth.selectedStoreId).toBe('store-b');
  });

  it('preserves an explicitly pinned A authorization and never substitutes B', async () => {
    auth.current = { ...accountB };
    const seen: string[] = [];
    let refreshCalls = 0;

    setAdapter(async (config) => {
      if ((config.url ?? '').endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return response(config, 200, {
          data: { accessToken: 'unexpected', refreshToken: 'unexpected' },
        });
      }
      seen.push(authorization(config) ?? 'none');
      return unauthorized(config);
    });

    await expect(riderApi.location(6.8, -58.1, accountA))
      .rejects.toMatchObject({ response: { status: 401 } });
    expect(seen).toEqual(['Bearer access-a-1']);
    expect(refreshCalls).toBe(0);
    expect(auth.current).toEqual(accountB);
  });

  it('wires provider onboarding to the canonical self-service routes and pins mutations to the caller', async () => {
    auth.current = { ...accountB };
    const seen: Array<{ method?: string; url?: string; authorization?: string; data?: string }> = [];
    setAdapter(async (config) => {
      seen.push({
        method: config.method,
        url: config.url,
        authorization: authorization(config),
        data: typeof config.data === 'string' ? config.data : JSON.stringify(config.data),
      });
      return response(config, 200, { data: { id: 'provider-a' } });
    });

    await servicesApi.providerMe(accountA);
    await servicesApi.saveProvider({ trade: 'Mason', bio: 'Block work' }, accountA);
    await servicesApi.addQualification({ type: 'CVQ', referenceNumber: 'CVQ-1' }, accountA);

    expect(seen.map(({ method, url }) => [method, url])).toEqual([
      ['get', '/services/providers/me'],
      ['post', '/services/providers'],
      ['post', '/services/providers/qualifications'],
    ]);
    expect(seen.every((request) => request.authorization === 'Bearer access-a-1')).toBe(true);
    expect(JSON.parse(seen[1]?.data ?? '{}')).toMatchObject({ trade: 'Mason', bio: 'Block work' });
    expect(JSON.parse(seen[2]?.data ?? '{}')).toMatchObject({ type: 'CVQ', referenceNumber: 'CVQ-1' });
  });

  it('pins every protected multi-step API method to A while B is current', async () => {
    auth.current = { ...accountB };
    const seen: Array<{ url: string; authorization?: string; keys: string[] }> = [];
    setAdapter(async (config) => {
      seen.push({
        url: config.url ?? '',
        authorization: authorization(config),
        keys: Object.keys(config),
      });
      return response(config, 200, { data: { id: 'created', path: '/statement' } });
    });

    const form = new FormData();
    await Promise.all([
      authApi.uploadSelfie(form, accountA),
      customerApi.updateProfile({ firstName: 'A' }, accountA),
      customerApi.exportAccount(accountA),
      customerApi.deleteAccount(accountA),
      customerApi.switchRole('DRIVER', accountA),
      customerApi.rateOrder('order-a', { driverScore: 5 }, accountA),
      customerApi.tipOrder('order-a', 500, accountA),
      verificationApi.upload(form, accountA),
      verificationApi.submitDocument({
        role: 'MOVER',
        docType: 'ID',
        fileUrl: '/a-id.jpg',
        consent: true,
        privacyNoticeVersion: 'v1',
      }, accountA),
      verificationApi.submitIdentity({
        idDocumentUrl: '/a-id.jpg',
        selfieUrl: '/a-selfie.jpg',
        consent: true,
        privacyNoticeVersion: 'v1',
      }, accountA),
      partnerApi.become({ role: 'MOVER' }, accountA),
      courierApi.uploadProof('order-a', form, accountA),
      courierApi.proof('order-a', { proofPhotoUrl: '/a-proof.jpg', outcome: 'paid', gps: { lat: 6.8, lng: -58.1 } }, accountA),
      courierApi.collect('order-a', { outcome: 'paid', gps: { lat: 6.8, lng: -58.1 } }, accountA),
      riderApi.goOnline(6.8, -58.1, accountA),
      riderApi.location(6.8, -58.1, accountA),
      riderApi.handover('order-a', {
        outcome: 'paid',
        gps: { lat: 6.8, lng: -58.1 },
      }, accountA),
      riderApi.earningsStatement(accountA),
      riderApi.uploadVehiclePhoto(form, accountA),
      driverApi.goOnline(6.8, -58.1, accountA),
      driverApi.location(6.8, -58.1, accountA),
      driverApi.earningsStatement(accountA),
      driverApi.uploadVehiclePhoto(form, accountA),
      vendorApi.createItem({ categoryId: 'cat-a', name: 'Item', basePrice: 100 }, accountA),
      vendorApi.updateItem('item-a', { name: 'Updated item' }, accountA),
      vendorApi.uploadItemImage('item-a', form, accountA),
      vendorApi.addOptionGroup('item-a', { name: 'Size' }, accountA),
      vendorApi.deleteOptionGroup('group-a', accountA),
      vendorApi.addOption('group-a', { name: 'Large' }, accountA),
      vendorApi.deleteOption('option-a', accountA),
      vendorApi.salesStatement(accountA),
      vendorApi.importItems('category,name\nFood,Item', accountA),
      vendorApi.importAutomap('category,name\nFood,Item', accountA),
      vendorApi.importXlsx(form, accountA),
      vendorApi.importMenuPdf(form, accountA),
      adsApi.createCampaign({
        advertiserId: 'advertiser-a',
        placementId: 'placement-a',
        name: 'Campaign A',
        cities: ['*'],
        startWeek: '2026-08-10',
        endWeek: '2026-08-10',
      }, accountA),
      adsApi.uploadCreative('campaign-a', form, accountA),
      adsApi.reserve('campaign-a', accountA),
      adsApi.checkout('campaign-a', 'MOCK', accountA),
      adsApi.refundPreview('campaign-a', accountA),
      adsApi.cancel('campaign-a', accountA),
    ]);

    // [M-28] +1: the courier collect step joined the captured-session matrix.
    expect(seen).toHaveLength(41);
    expect(seen.every((request) => request.authorization === 'Bearer access-a-1')).toBe(true);
    expect(seen.every((request) => !request.keys.includes('_swiftAuthBindingId'))).toBe(true);
    expect(auth.current).toEqual(accountB);
  });

  it('does not expose refresh credentials through enumerable Axios config metadata', async () => {
    let inspected = false;
    setAdapter(async (config) => {
      inspected = true;
      expect(Object.keys(config)).not.toContain('_swiftAuthSession');
      expect(Object.keys(config)).not.toContain('_swiftAuthBindingId');
      expect(JSON.stringify(config)).not.toContain(accountA.refreshToken);
      return response(config, 200, { ok: true });
    });

    await expect(riderApi.location(6.8, -58.1, accountA)).resolves.toMatchObject({ status: 200 });
    expect(inspected).toBe(true);
  });
});
