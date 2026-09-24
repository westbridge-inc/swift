import { describe, expect, it, vi } from 'vitest';
import { createPullToRefresh } from './pullToRefresh';

// ---------------------------------------------------------------------------
// [phone feedback P1] The pull spinner is the person's own gesture.
//
// Home bound RefreshControl.refreshing to `query.isRefetching`, which is true
// for every fetch over cached data — the focus refresh on each tab switch
// included. On iOS a programmatic `refreshing={true}` scrolls the feed down
// behind the native spinner and snaps it back: the "loading thing" on every
// Cart → Home switch, over content that never left the screen. The spinner
// must track a pull the person made, and only that.
// ---------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createPullToRefresh', () => {
  it('spins exactly for the duration of the pull it was given, then releases', async () => {
    const fetch = deferred<{ status: 'success' }>();
    const refetch = vi.fn(() => fetch.promise);
    const spinner: boolean[] = [];
    const pull = createPullToRefresh(refetch, (on) => spinner.push(on));

    const done = pull();
    expect(spinner).toEqual([true]);
    expect(refetch).toHaveBeenCalledOnce();

    fetch.resolve({ status: 'success' });
    await done;
    expect(spinner).toEqual([true, false]);
  });

  it('a second pull during the first is the same request — one fetch, one spinner cycle', async () => {
    const fetch = deferred<unknown>();
    const refetch = vi.fn(() => fetch.promise);
    const spinner: boolean[] = [];
    const pull = createPullToRefresh(refetch, (on) => spinner.push(on));

    const first = pull();
    const second = pull();
    expect(second).toBe(first);
    expect(refetch).toHaveBeenCalledOnce();

    fetch.resolve(undefined);
    await first;
    expect(spinner).toEqual([true, false]);

    // and a later pull, after release, is a fresh one
    fetch.resolve(undefined);
    await pull();
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(spinner).toEqual([true, false, true, false]);
  });

  it('releases the spinner when the refetch rejects — a failed pull never spins forever', async () => {
    const refetch = vi.fn(() => Promise.reject(new Error('offline')));
    const spinner: boolean[] = [];
    const pull = createPullToRefresh(refetch, (on) => spinner.push(on));

    await expect(pull()).resolves.toBeUndefined();
    expect(spinner).toEqual([true, false]);
  });

  it('releases the spinner when the refetch resolves with an error result (React Query does not reject)', async () => {
    const refetch = vi.fn(async () => ({ status: 'error', error: new Error('timeout') }));
    const spinner: boolean[] = [];
    const pull = createPullToRefresh(refetch, (on) => spinner.push(on));

    await pull();
    expect(spinner).toEqual([true, false]);
  });

  it('never spins on its own: no pull, no spinner, however many background fetches run', () => {
    const spinner: boolean[] = [];
    createPullToRefresh(vi.fn(async () => undefined), (on) => spinner.push(on));
    expect(spinner).toEqual([]);
  });
});
