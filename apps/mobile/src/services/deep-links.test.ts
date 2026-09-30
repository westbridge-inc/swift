import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPendingDeepLink, installDeepLinkHandler, resetDeepLinksForTests } from './deep-links';
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
    expect(mock.navigate).not.toHaveBeenCalled();
    expect(mock.toast).toHaveBeenCalled();
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
