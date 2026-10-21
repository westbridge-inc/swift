type FeedSocket = {
  emit: (event: string, payload: { vendorId: string }) => unknown;
  on: (event: string, callback: (payload?: any) => void) => unknown;
  off: (event: string, callback: (payload?: any) => void) => unknown;
};

export interface VendorOrderFeedHandlers {
  onNew: (payload?: { orderId?: string; orderNumber?: string }) => void;
  refresh: () => unknown;
  refreshBookings: () => unknown;
  /** [PERF partner #6] The store overview (today's numbers): it changes only when orders do,
   *  so it refreshes on a new order or a status change, and catches up whenever the feed
   *  reconnects or drops (a drop also puts its poll back to full speed at once). */
  refreshOverview?: () => unknown;
}

/** [#1932 S4-1] The shortest gap between two overview refreshes caused by order events (the old poll's pace). */
export const OVERVIEW_EVENT_GAP_MS = 30_000;

/** Stores whose live order feed is bound right now (the store-room listeners
 * are installed). Order polls may slow only while one is. */
const liveStores = new Map<string, number>();
export function vendorOrderFeedLive(): boolean { return liveStores.size > 0; }

/** Join the store's socket room and refresh the order queries on every order
 * event that room carries (server emit sites: order.service, picking.service,
 * dispatch.service, jobs/queue, booking.service). Rooms are per connection,
 * so it re-joins after reconnects, and only while `mayJoin()` holds. */
export function bindVendorOrderFeed(
  socket: FeedSocket,
  vendorId: string,
  mayJoin: () => boolean,
  handlers: VendorOrderFeedHandlers,
  { serverAdmits }: { serverAdmits: boolean },
): () => void {
  const join = () => { if (mayJoin()) socket.emit('vendor:subscribe', { vendorId }); };
  const refresh = () => { handlers.refresh(); };
  const refreshBookings = () => { handlers.refreshBookings(); };
  const refreshOverview = () => { handlers.refreshOverview?.(); };
  // [#1932 S4-1] Order events refresh the overview at most once per OVERVIEW_EVENT_GAP_MS: the first
  // at once, the last of a burst when the gap ends. A busy store (several events a minute) so never
  // reads it more often than the old 30 s poll did. A drop and its reconnect still refresh at once.
  let lastEventRefresh = -Infinity;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const refreshOverviewForEvent = () => {
    if (trailing) return;
    const wait = lastEventRefresh + OVERVIEW_EVENT_GAP_MS - Date.now();
    if (wait <= 0) { lastEventRefresh = Date.now(); refreshOverview(); return; }
    trailing = setTimeout(() => { trailing = null; lastEventRefresh = Date.now(); refreshOverview(); }, wait);
  };
  const onNew = (payload?: { orderId?: string; orderNumber?: string }) => { handlers.onNew(payload); refreshOverviewForEvent(); };
  const onStatus = () => { refresh(); refreshOverviewForEvent(); };
  // A drop refreshes the overview at once (its poll is back to full speed from then on);
  // the reconnect after a drop catches up on what the room said while it was down.
  let dropped = false;
  const onDrop = () => { dropped = true; refreshOverview(); };
  const onBack = () => { if (!dropped) return; dropped = false; refreshOverview(); };
  join();
  socket.on('connect', join);
  socket.on('connect', onBack);
  socket.on('disconnect', onDrop);
  socket.on('order:new', onNew);
  socket.on('order:status_changed', onStatus);
  socket.on('order:prep_update', refresh);
  socket.on('order:pick_state', refresh);
  socket.on('bookings:changed', refreshBookings);
  // The server joins only the store OWNER to vendor:<id> (plugins/socket.ts
  // vendor:subscribe); other roles get no events, so they never count as live.
  if (serverAdmits) liveStores.set(vendorId, (liveStores.get(vendorId) ?? 0) + 1);
  let bound = true;
  return () => {
    if (!bound) return;
    bound = false;
    if (trailing) { clearTimeout(trailing); trailing = null; }
    socket.off('connect', join);
    socket.off('connect', onBack);
    socket.off('disconnect', onDrop);
    socket.off('order:new', onNew);
    socket.off('order:status_changed', onStatus);
    socket.off('order:prep_update', refresh);
    socket.off('order:pick_state', refresh);
    socket.off('bookings:changed', refreshBookings);
    if (!serverAdmits) return;
    const left = (liveStores.get(vendorId) ?? 1) - 1;
    if (left > 0) liveStores.set(vendorId, left); else liveStores.delete(vendorId);
  };
}
