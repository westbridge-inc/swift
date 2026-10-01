import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ initialUrl: null as string | null, callback: null as null | ((event: { url: string }) => void), navigate: vi.fn(() => true), track: vi.fn() }));
vi.mock('react-native', () => ({ Linking: { addEventListener: (_kind: string, cb: (event: { url: string }) => void) => { mocks.callback = cb; return { remove: vi.fn() }; }, getInitialURL: async () => mocks.initialUrl } }));
vi.mock('./api', () => ({ api: { post: vi.fn(), get: vi.fn() } }));
vi.mock('../navigation/navigationRef', () => ({ safeNavigate: mocks.navigate }));
vi.mock('../kit/toast', () => ({ toast: { show: vi.fn() } }));
vi.mock('../lib/analytics', () => ({ track: mocks.track }));
// No earner preview is open here; a payment return that ends one is proven in navigation/RootNavigator.moverPreview.navigation.test.ts.
vi.mock('../stores/moverPreviewExit', () => ({ leaveMoverPreview: () => false }));
import { installDeepLinkHandler, isWeeklyFeeReturn, resetDeepLinksForTests } from './deep-links';
afterEach(() => { resetDeepLinksForTests(); mocks.initialUrl = null; vi.clearAllMocks(); });
it('MMG return opens only WeeklyFee, never carries a token/state or emits analytics', () => {
  const dispose = installDeepLinkHandler();
  mocks.callback!({ url: 'swift://pay/mmg/return?token=untrusted&state=CONFIRMED' });
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('WeeklyFee'); expect(mocks.track).not.toHaveBeenCalled(); dispose();
});
it('matches only the fixed return route', () => {
  expect(isWeeklyFeeReturn('swift://pay/mmg/return')).toBe(true);
  for (const url of ['https://evil.test/pay/mmg/return', 'swift://pay/mmg/success', 'swift://store/pay/mmg/return', 'not a URL']) expect(isWeeklyFeeReturn(url)).toBe(false);
});

it('a cold return arriving after navigation is ready still opens the weekly fee', async () => {
  mocks.initialUrl = 'swift://pay/mmg/return?state=CONFIRMED';
  const dispose = installDeepLinkHandler();
  await Promise.resolve();
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('WeeklyFee');
  expect(mocks.track).not.toHaveBeenCalled(); dispose();
});
