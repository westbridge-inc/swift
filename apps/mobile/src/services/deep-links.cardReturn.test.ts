import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ initialUrl: null as string | null, callback: null as null | ((event: { url: string }) => void), navigate: vi.fn(() => true), track: vi.fn() }));
vi.mock('react-native', () => ({ Linking: { addEventListener: (_kind: string, cb: (event: { url: string }) => void) => { mocks.callback = cb; return { remove: vi.fn() }; }, getInitialURL: async () => mocks.initialUrl } }));
vi.mock('./api', () => ({ api: { post: vi.fn(), get: vi.fn() } }));
vi.mock('../navigation/navigationRef', () => ({ safeNavigate: mocks.navigate }));
vi.mock('../kit/toast', () => ({ toast: { show: vi.fn() } }));
vi.mock('../lib/analytics', () => ({ track: mocks.track }));
import { installDeepLinkHandler, isWeeklyFeeReturn, resetDeepLinksForTests } from './deep-links';
afterEach(() => { resetDeepLinksForTests(); mocks.initialUrl = null; vi.clearAllMocks(); });
it('the card page return opens only WeeklyFee, never carries its parameters or emits analytics', () => {
  const dispose = installDeepLinkHandler();
  mocks.callback!({ url: 'swift://pay/card/return?session=untrusted&state=SUCCEEDED' });
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('WeeklyFee'); expect(mocks.track).not.toHaveBeenCalled(); dispose();
});
it('matches only the fixed card return route', () => {
  expect(isWeeklyFeeReturn('swift://pay/card/return')).toBe(true);
  for (const url of ['https://evil.test/pay/card/return', 'swift://pay/card/success', 'swift://store/pay/card/return', 'swift://pay/card/return/extra', 'swift://pay/cards/return']) expect(isWeeklyFeeReturn(url)).toBe(false);
});
