import { startTransition, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [SPEED 6 Nov · owner: "the business tabs take a moment to open"] The first tap
// on a tab used to MOUNT that screen: every card and row was built at the tap.
// #2243 already holds each tab's data, so what was left was the drawing.
//
// Once the open tab has painted and Swift has been quiet for a moment (no read
// in flight, nothing changing in the cache), the named tabs are allowed to mount
// while hidden, one per quiet moment, as a low-priority (transition) render that
// a tap interrupts. A tab mounted this way is still frozen while hidden
// (freezeOnBlur, react-native-screens' DelayedFreeze lets it draw once, then
// pauses it), so it does not redraw on polls in the background. A first tap then
// only shows it.
//
// Only tabs the navigator registers can mount: a role that does not see a tab
// (staff: Schedule, Insights) never has it, preloaded or not. Not React
// Navigation's `navigation.preload`: a preloaded route is NOT frozen until it is
// visited, so it would redraw (and Insights would re-read its revenue) on every
// overview poll.
// ---------------------------------------------------------------------------

/** How long Swift must be quiet before the next hidden tab mounts. */
export const WARM_TAB_QUIET_MS = 400;

const NONE: ReadonlySet<string> = new Set();

/**
 * The tabs (of `names`, in order) that may mount while hidden: none at first,
 * then one more each time the query cache has been quiet for WARM_TAB_QUIET_MS.
 * Pass the result to each tab's `lazy` option (`lazy: !warm.has(name)`).
 */
export function useWarmTabs(names: readonly string[]): ReadonlySet<string> {
  const client = useQueryClient();
  const [warm, setWarm] = useState<ReadonlySet<string>>(NONE);
  const next = names.find((name) => !warm.has(name));
  useEffect(() => {
    if (next === undefined) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const fire = () => {
      timer = undefined;
      // A read still on its way: the cache event when it lands starts the wait again.
      if (!live || client.isFetching() > 0) return;
      live = false;
      startTransition(() => setWarm((prev) => (prev.has(next) ? prev : new Set(prev).add(next))));
    };
    const arm = () => {
      if (!live) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, WARM_TAB_QUIET_MS);
    };
    const unsubscribe = client.getQueryCache().subscribe(arm);
    arm();
    return () => {
      live = false;
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, next]);
  return warm;
}
