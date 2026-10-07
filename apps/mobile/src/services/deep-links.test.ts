import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPendingDeepLink, installDeepLinkHandler, resetDeepLinksForTests, retryQrDestination } from './deep-links';
import { setLinkPolicyForTests } from '../lib/deepLinkParse';
import { policyFrom } from '../lib/linkPolicy';

const mock = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), navigate: vi.fn(), initial: vi.fn(), remove: vi.fn(), toast: vi.fn(),
  listener: null as null | ((event: { url: string }) => void),
}));
vi.mock('react-native', () => ({ Linking: {
  getInitialURL: () => mock.initial(),
  addEventListener: (_type: string, listener: typeof mock.listener) => { mock.listener = listener; return { remove: mock.remove }; },
} }));
vi.mock('./api', () => ({ api: { get: mock.get, post: mock.post } }));
vi.mock('../navigation/navigationRef', () => ({ safeNavigate: mock.navigate }));
vi.mock('../kit/toast', () => ({ toast: { show: mock.toast } }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
// No earner preview is open in these tests; ending one on a link is proven
// through the real router in navigation/RootNavigator.moverPreview.navigation.test.ts.
vi.mock('../stores/moverPreviewExit', () => ({ leaveMoverPreview: () => false }));

let uninstall: (() => void) | undefined;
const flush = async () => { await vi.runAllTimersAsync(); };
const storeRoute = (vendorId: string) => ['Storefront', { screen: 'Restaurant', params: { vendorId } }];

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); resetDeepLinksForTests();
  setLinkPolicyForTests(policyFrom({ webUrl: 'https://swiftgy.com', isDev: false }));
  mock.initial.mockResolvedValue(null); mock.post.mockResolvedValue({}); mock.navigate.mockReturnValue(true);
  mock.get.mockImplementation(async (path: string) => ({ data: { data: path.includes('/qr/')
    ? { verdict: 'WEB_RENDER', vendorId: 'short-store' } : { id: 'slug-store' } } }));
});
afterEach(() => { uninstall?.(); vi.useRealTimers(); });

describe('store QR navigation through the installed link handler', () => {
  it.each([
    ['https://swiftgy.com/s/BCDFGHJKMN', '/public/qr/BCDFGHJKMN', 'short-store'],
    ['https://swiftgy.com/store/garden-kitchen?src=qr', '/public/storefronts/garden-kitchen', 'slug-store'],
  ])('opens %s on exactly its menu, including when the initial URL arrives after onReady', async (url, endpoint, vendorId) => {
    let deliver!: (value: string) => void;
    mock.initial.mockReturnValue(new Promise<string>(resolve => { deliver = resolve; }));
    uninstall = installDeepLinkHandler();
    flushPendingDeepLink();
    deliver(url);
    await flush();
    expect(mock.get).toHaveBeenCalledWith(endpoint);
    expect(mock.navigate).toHaveBeenCalledExactlyOnceWith(...storeRoute(vendorId));
  });

  it('retains an early initial URL until navigation is ready', async () => {
    mock.initial.mockResolvedValue('https://swiftgy.com/store/garden-kitchen');
    uninstall = installDeepLinkHandler();
    await flush();
    expect(mock.navigate).not.toHaveBeenCalled();
    flushPendingDeepLink();
    await flush();
    expect(mock.navigate).toHaveBeenCalledExactlyOnceWith(...storeRoute('slug-store'));
  });

  it('opens warm short links and store links on their own resolved menus', async () => {
    uninstall = installDeepLinkHandler(); flushPendingDeepLink(); await flush();
    mock.listener!({ url: 'swift://s/BCDFGHJKMN' }); await flush();
    expect(mock.navigate).toHaveBeenLastCalledWith(...storeRoute('short-store'));
    mock.listener!({ url: 'https://swiftgy.com/store/another-store' }); await flush();
    expect(mock.get).toHaveBeenLastCalledWith('/public/storefronts/another-store');
    expect(mock.navigate).toHaveBeenLastCalledWith(...storeRoute('slug-store'));
  });

  it.each(['RETIRED_PAGE', 'UNAVAILABLE_PAGE', 'NOT_FOUND'])('never opens an unrelated store for %s', async verdict => {
    mock.get.mockResolvedValue({ data: { data: { verdict, vendorId: 'must-not-open' } } });
    uninstall = installDeepLinkHandler(); flushPendingDeepLink(); await flush();
    mock.listener!({ url: 'https://swiftgy.com/s/BCDFGHJKMN' }); await flush();
    expect(mock.navigate).toHaveBeenCalledExactlyOnceWith('QrOutcome', expect.objectContaining({ destination: { kind: 'short', code: 'BCDFGHJKMN' } }));
    expect(mock.navigate).not.toHaveBeenCalledWith('Storefront', expect.anything());
    expect(mock.toast).not.toHaveBeenCalled();
  });

  it('ignores an untrusted QR origin', async () => {
    uninstall = installDeepLinkHandler(); flushPendingDeepLink(); await flush();
    mock.listener!({ url: 'https://attacker.example/store/garden-kitchen' }); await flush();
    expect(mock.get).not.toHaveBeenCalled(); expect(mock.navigate).not.toHaveBeenCalled();
  });

  it('a newer scan wins when the first store lookup returns late', async () => {
    let finish!: (value: unknown) => void;
    mock.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    uninstall = installDeepLinkHandler(); flushPendingDeepLink(); await flush();
    mock.listener!({ url: 'https://swiftgy.com/store/first-store' });
    mock.listener!({ url: 'https://swiftgy.com/s/BCDFGHJKMN' }); await flush();
    finish({ data: { data: { id: 'first-store' } } }); await flush();
    expect(mock.navigate).toHaveBeenCalledExactlyOnceWith(...storeRoute('short-store'));
  });

  it('does not let a late initial URL replace a warm scan', async () => {
    let initial!: (url: string) => void;
    mock.initial.mockReturnValue(new Promise<string>(resolve => { initial = resolve; }));
    uninstall = installDeepLinkHandler(); flushPendingDeepLink();
    mock.listener!({ url: 'https://swiftgy.com/s/BCDFGHJKMN' }); await flush();
    initial('https://swiftgy.com/store/old-store'); await flush();
    expect(mock.navigate).toHaveBeenCalledExactlyOnceWith(...storeRoute('short-store'));
  });

  it('does not navigate after the handler unmounts during a lookup', async () => {
    let finish!: (value: unknown) => void;
    mock.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    uninstall = installDeepLinkHandler(); flushPendingDeepLink(); await flush();
    mock.listener!({ url: 'https://swiftgy.com/store/garden-kitchen' });
    uninstall(); uninstall = undefined;
    finish({ data: { data: { id: 'old-store' } } }); await flush();
    expect(mock.navigate).not.toHaveBeenCalled();
  });
});


const fromNative = createRequire(import.meta.resolve('@react-navigation/native'));
const fromCore = createRequire(fromNative.resolve('@react-navigation/core'));
const { StackRouter } = await import(fromCore.resolve('@react-navigation/routers')) as Pick<typeof import('@react-navigation/native'), 'StackRouter'>;

describe('QR-04: cold and warm QR failures replace the visible destination', () => {
  for (const start of ['cold', 'warm']) {
    it.each([
      ['RETIRED_PAGE', 'replaced'], ['UNAVAILABLE_PAGE', 'unavailable'],
      ['NOT_FOUND', 'not-a-swift-code'], ['CONNECTION', 'offline'],
    ])(`${start} %s opens a dedicated outcome with the original code`, async (verdict, reason) => {
      const router = StackRouter({});
      const options = { routeNames: ['Main', 'Storefront', 'QrOutcome'], routeParamList: {}, routeGetIdList: {} };
      let state = router.getInitialState(options);
      if (start === 'warm') state = router.getRehydratedState(router.getStateForAction(state, { type: 'NAVIGATE', payload: { name: 'Storefront', params: { vendorId: 'ANOTHER-store' } } }, options)!, options);
      mock.navigate.mockImplementation((name, params) => {
        state = router.getRehydratedState(router.getStateForAction(state, { type: 'NAVIGATE', payload: { name, params } }, options)!, options);
        return true;
      });
      if (verdict === 'CONNECTION') mock.get.mockRejectedValue(new Error('private upstream detail'));
      else mock.get.mockResolvedValue({ data: { data: { verdict, vendorId: 'must-not-open', reason: 'private suspension detail' } } });
      const url = 'https://swiftgy.com/s/BCDFGHJKMN';
      mock.initial.mockResolvedValue(start === 'cold' ? url : null);
      uninstall = installDeepLinkHandler();
      await flush();
      flushPendingDeepLink();
      if (start === 'warm') mock.listener!({ url });
      await flush();
      expect(state.routes[state.index]).toMatchObject({ name: 'QrOutcome', params: { reason, destination: { kind: 'short', code: 'BCDFGHJKMN' } } });
      expect(JSON.stringify(state.routes[state.index]?.params)).not.toContain('private');
      expect(mock.toast).not.toHaveBeenCalled();
    });
  }
});


describe('QR-04 retry keeps scan context', () => {
  it('retries the same code and lands on only its resolved menu', async () => {
    mock.get.mockRejectedValueOnce(new Error('offline'));
    uninstall = installDeepLinkHandler(); flushPendingDeepLink(); await flush();
    mock.listener!({ url: 'https://swiftgy.com/s/BCDFGHJKMN' }); await flush();
    const params = mock.navigate.mock.calls.at(-1)![1];
    expect(params.reason).toBe('offline');
    await retryQrDestination(params.destination, params.requestId);
    expect(mock.get.mock.calls).toEqual([['/public/qr/BCDFGHJKMN'], ['/public/qr/BCDFGHJKMN']]);
    expect(mock.navigate).toHaveBeenLastCalledWith(...storeRoute('short-store'));
    expect(mock.toast).not.toHaveBeenCalled();
  });

  it('a retry cannot overwrite a newer scan or resurrect an older outcome', async () => {
    mock.get.mockRejectedValueOnce(new Error('offline'));
    uninstall = installDeepLinkHandler(); flushPendingDeepLink(); await flush();
    mock.listener!({ url: 'https://swiftgy.com/s/BCDFGHJKMN' }); await flush();
    const params = mock.navigate.mock.calls.at(-1)![1];
    let finish!: (value: unknown) => void;
    mock.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const retry = retryQrDestination(params.destination, params.requestId);
    mock.listener!({ url: 'https://swiftgy.com/store/new-store' }); await flush();
    finish({ data: { data: { verdict: 'RETIRED_PAGE' } } }); await retry;
    expect(mock.navigate).toHaveBeenLastCalledWith(...storeRoute('slug-store'));
    const count = mock.get.mock.calls.length;
    await retryQrDestination(params.destination, params.requestId);
    expect(mock.get).toHaveBeenCalledTimes(count);
  });

  it.each([
    ['https://swiftgy.com/s/BCDFGHJKMN', 404, 'not-a-swift-code'],
    ['https://swiftgy.com/store/closed-store', 404, 'unavailable'],
    ['https://swiftgy.com/s/BCDFGHJKMN', 410, 'replaced'],
    ['https://swiftgy.com/s/BCDFGHJKMN', 503, 'offline'],
  ])('classifies %s HTTP %s without showing server detail', async (url, status, reason) => {
    mock.get.mockRejectedValue({ response: { status, data: { reason: 'private suspension detail' } } });
    uninstall = installDeepLinkHandler(); flushPendingDeepLink(); await flush();
    mock.listener!({ url }); await flush();
    expect(mock.navigate).toHaveBeenLastCalledWith('QrOutcome', expect.objectContaining({ reason }));
    expect(JSON.stringify(mock.navigate.mock.calls)).not.toContain('private');
  });
});
