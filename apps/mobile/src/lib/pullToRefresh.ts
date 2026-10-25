/**
 * The pull spinner belongs to the person's own gesture — never to a
 * background refetch.
 *
 * Home bound `RefreshControl.refreshing` to `query.isRefetching`. That flag
 * is true for EVERY fetch over cached data: the focus refresh on each tab
 * switch, the foreground refresh, an order invalidation. On iOS a
 * programmatic `refreshing={true}` calls the native control's
 * beginRefreshing, which scrolls the content down to reveal the spinner and
 * snaps it back when the fetch lands. The feed was already on screen the
 * whole time; the app still looked as though it had to reload it — the
 * "loading thing" on every Cart → Home switch, over a 0.4s response.
 *
 * Stale-while-revalidate means the cached content stays put and the refresh
 * is silent. The spinner shows exactly while a pull the person made is in
 * flight, and it is released whether that fetch succeeds or fails.
 */
export function createPullToRefresh(
  refetch: () => Promise<unknown>,
  setRefreshing: (refreshing: boolean) => void,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    // A second pull during the first is the same request, not a second spinner cycle.
    if (inFlight) return inFlight;
    setRefreshing(true);
    // The fetch starts on the gesture itself, not a tick later.
    let started: Promise<unknown>;
    try {
      started = Promise.resolve(refetch());
    } catch (error) {
      started = Promise.reject(error);
    }
    inFlight = started
      // React Query's refetch() resolves with an error result rather than
      // rejecting; a refetch that does reject must still release the spinner.
      .then(() => undefined, () => undefined)
      .finally(() => {
        inFlight = null;
        setRefreshing(false);
      });
    return inFlight;
  };
}
