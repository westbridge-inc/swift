import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The client half of "cancelling an order must take it off Home".
//
// Home's live-order card is fed by `useHome()` — a different React Query entry
// from the order this screen shows — and Home does not refetch on focus. So
// after a cancel, refetching only `order` left the card on Home counting down
// the free-cancel window of an order that no longer existed, until the
// customer happened to pull to refresh. The founder watched it happen.
//
// The fix is an invalidation of the feed PREFIX. These assert the shape that
// makes it hold: the prefix really is a prefix of every Home key, the cancel
// invalidates it on success AND on an unknown outcome, and it does so before
// the early return that guards the rest of the handler.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREEN = strip(readFileSync(new URL('./DeliveryScreen.tsx', import.meta.url), 'utf8'));
const RIDES = strip(readFileSync(new URL('../../../hooks/rides.ts', import.meta.url), 'utf8'));
// Read as source rather than imported: hooks/customer.ts pulls in services/api,
// which imports react-native, whose Flow-typed entry vitest cannot parse. The
// two literals are compared textually, which still fails the moment one is
// renamed without the other.
const KEYS = strip(readFileSync(new URL('../../../hooks/customer.ts', import.meta.url), 'utf8'));

describe('homeAll is a real prefix, not a look-alike', () => {
  it('every Home key starts with it, whatever the coordinates', () => {
    // If someone renamed the feed key and forgot the prefix, invalidating the
    // prefix would silently match nothing. This is the assertion that fails.
    const home = /home:\s*\(lat\?: number, lng\?: number\) => \[([^\]]+)\]/.exec(KEYS);
    const all = /homeAll:\s*\[([^\]]+)\]/.exec(KEYS);
    expect(home, 'customerKeys.home must exist').toBeTruthy();
    expect(all, 'customerKeys.homeAll must exist').toBeTruthy();
    const homeParts = home![1]!.split(',').map((x) => x.trim());
    const allParts = all![1]!.split(',').map((x) => x.trim());
    expect(homeParts.slice(0, allParts.length)).toEqual(allParts);
    expect(allParts).toEqual(["'customer'", "'home'"]);
  });
});

describe('the order screen’s cancel invalidates Home', () => {
  const cancelBlock = SCREEN.slice(SCREEN.indexOf('const cancelOrder = useMutation'), SCREEN.indexOf('const decideSub ='));

  it('on success, and BEFORE the early return', () => {
    expect(cancelBlock.length).toBeGreaterThan(200);
    const success = cancelBlock.slice(cancelBlock.indexOf('onSuccess:'), cancelBlock.indexOf('onError:'));
    const invalidate = success.indexOf('queryKey: customerKeys.homeAll');
    const earlyReturn = success.indexOf('activeOrderIdRef.current) return;');
    expect(invalidate, 'onSuccess must invalidate the Home feed').toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(-1);
    // The feed is wrong regardless of which order this screen happens to be
    // showing, so the invalidation may not sit behind that guard.
    expect(invalidate, 'the invalidation must precede the early return').toBeLessThan(earlyReturn);
  });

  it('on an unknown outcome too — a timeout can mean the cancel landed', () => {
    const error = cancelBlock.slice(cancelBlock.indexOf('onError:'));
    expect(error).toContain('queryKey: customerKeys.homeAll');
  });

  it('invalidates the prefix, never a single coordinate variant', () => {
    expect(cancelBlock).not.toMatch(/customerKeys\.home\(/);
  });
});

describe('a cancelled ride leaves Home as well', () => {
  it('useCancelRide invalidates the Home feed', () => {
    const block = RIDES.slice(RIDES.indexOf('export function useCancelRide'), RIDES.indexOf('export function useRideSos'));
    expect(block).toContain('queryKey: customerKeys.homeAll');
  });
});
