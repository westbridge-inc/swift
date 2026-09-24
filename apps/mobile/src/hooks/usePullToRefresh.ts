import { useMemo, useRef, useState } from 'react';
import { createPullToRefresh } from '../lib/pullToRefresh';

/**
 * `refreshing` for a RefreshControl that is true only while the person's own
 * pull is in flight — never during a focus, foreground or invalidation
 * refetch over content already on screen (lib/pullToRefresh).
 *
 * `refetch` is read through a ref so the latest query is always the one
 * pulled, while the handler identity stays stable for the native control.
 */
export function usePullToRefresh(refetch: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(refetch);
  latest.current = refetch;
  const onRefresh = useMemo(() => createPullToRefresh(() => latest.current(), setRefreshing), []);
  return { refreshing, onRefresh };
}
