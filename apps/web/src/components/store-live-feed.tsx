'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';
import { storeKey } from '@/lib/store-scope';
import { openStoreFeed, setStoreFeedLive, storeFeedUrl } from '@/lib/store-live-feed';

/**
 * [PERF row 8] The selected store's live feed, mounted once by the dashboard
 * shell for a store the server listed for this account. An event re-reads only
 * what it names, through the dashboard's normal requests: the orders list and
 * that order (every event), and the overview (a new order or a status change,
 * the only events that move its figures). After a gap, one full re-read.
 */
export function StoreLiveFeed({ storeId }: { storeId: string }): null {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof WebSocket === 'undefined') return;
    const reread = (orderId: string | undefined, overview: boolean) => {
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'orders') });
      void queryClient.invalidateQueries({ queryKey: orderId ? storeKey(storeId, 'order', orderId) : storeKey(storeId, 'order') });
      if (overview) void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'overview') });
    };
    return openStoreFeed({
      url: storeFeedUrl(BROWSER_API_ORIGIN),
      storeId,
      onLive: (live) => setStoreFeedLive(storeId, live),
      onEvent: (event, { orderId }) => reread(orderId, event === 'order:new' || event === 'order:status_changed'),
      onResync: () => reread(undefined, true),
    });
  }, [storeId, queryClient]);
  return null;
}
