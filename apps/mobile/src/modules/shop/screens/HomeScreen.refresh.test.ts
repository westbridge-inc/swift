import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [phone feedback P1] "Switching from the Cart tab to Home shows a loading
// thing, so it looks buggy even though it loads fast."
//
// The four main tabs keep their content on screen while a background refresh
// runs. The skeleton is gated on the FIRST load only (`isLoading`, or Home's
// `homeFeedState` → 'loading' with nothing cached); the pull spinner follows
// the person's own gesture (hooks/usePullToRefresh), never the query's
// `isRefetching`, which is true during every silent focus/foreground refresh
// and — on iOS — yanked the whole feed down behind a spinner on every tab
// switch. Read as source: these screens pull in react-native, which Vitest
// cannot import; the shape is what this pins.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string) => strip(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const HOME = read('./HomeScreen.tsx');
const MARKET = read('./MarketScreen.tsx');
const CART = read('../../cart/screens/CartScreen.tsx');
const PROFILE = read('../../profile/screens/ProfileScreen.tsx');
const HOOKS = read('../../../hooks/customer.ts');

describe('Home keeps its feed on screen through every background refresh', () => {
  it('the pull spinner follows the person’s pull, never the query’s isRefetching / isFetching', () => {
    expect(HOME).toContain("import { usePullToRefresh } from '../../../hooks/usePullToRefresh';");
    expect(HOME).toContain('const pull = usePullToRefresh(home.refetch);');
    expect(HOME).toMatch(/<RefreshControl refreshing=\{pull\.refreshing\} onRefresh=\{\(\) => \{ void pull\.onRefresh\(\); \}\}/);
    expect(HOME).not.toMatch(/refreshing=\{home\.(isRefetching|isFetching|isLoading)\}/);
  });

  it('the skeleton is keyed on the reliability state — the one load with nothing cached — not on a fetch flag', () => {
    expect(HOME).toContain('const feedState = homeFeedState({ ...home, data: feed });');
    expect(HOME).toMatch(/feedState === 'loading' \? \(\s*<LoadingBlock/);
    expect(HOME).not.toMatch(/home\.(isFetching|isRefetching) \? \(\s*<LoadingBlock/);
  });

  it('a refresh in flight says nothing; a FAILED refresh over retained content still says so, with a retry', () => {
    expect(HOME).not.toContain('Updating Home…');
    expect(HOME).not.toMatch(/home\.isFetching && feed \?/);
    expect(HOME).toMatch(/home\.isError && feed \? \(/);
    expect(HOME).toContain('Couldn’t update Home. Showing the last loaded feed, including its order status.');
  });

  it('the focus / foreground refresh gate and the honest offline and error states are untouched', () => {
    expect(HOME).toContain("createHomeRefreshGate(() => { void qc.invalidateQueries({ queryKey: customerKeys.homeAll, refetchType: 'active' }); }, 750)");
    expect(HOME).toContain('subscribeToHomeAttention(AppState.currentState');
    expect(HOME).toMatch(/feedState === 'offline' \? \(\s*<ErrorState message="You're offline\./);
    expect(HOME).toMatch(/feedState === 'error' \? \(\s*<ErrorState onRetry/);
    // the hook still retains the last good feed across a location key change
    expect(HOOKS).toContain('placeholderData: (previous, previousQuery) => homePlaceholderData(previous, previousQuery, scope),');
    expect(HOOKS).toContain('return { ...query, data: retainedHomeData(query.data, last, scope) };');
  });
});

describe('the other main tabs follow the same rule', () => {
  it('Market: first-load skeleton only, pull spinner on the pull', () => {
    expect(MARKET).toContain('const pull = usePullToRefresh(feed.refetch);');
    expect(MARKET).toMatch(/refreshing=\{pull\.refreshing\}/);
    expect(MARKET).not.toMatch(/refreshing=\{feed\.isRefetching/);
    expect(MARKET).toMatch(/feed\.isLoading && items\.length === 0 \? \(\s*<LoadingBlock/);
  });

  it('Cart: the block is on isLoading (first load), never on a refetch flag', () => {
    expect(CART).toMatch(/\{cart\.isLoading \? \(\s*<LoadingBlock \/>/);
    expect(CART).not.toMatch(/cart\.(isFetching|isRefetching) \? \(\s*<LoadingBlock/);
  });

  it('Profile: the block is on isLoading (first load), never on a refetch flag', () => {
    expect(PROFILE).toMatch(/if \(profile\.isLoading\) \{\s*return \(\s*<Screen>\s*<LoadingBlock \/>/);
    expect(PROFILE).not.toMatch(/profile\.(isFetching|isRefetching)\) \{\s*return \(\s*<Screen>\s*<LoadingBlock/);
  });
});
