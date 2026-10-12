type FeedSocket = {
  emit: (event: string, payload: { vendorId: string }) => unknown;
  on: (event: string, callback: (payload?: any) => void) => unknown;
  off: (event: string, callback: (payload?: any) => void) => unknown;
};

export interface VendorOrderFeedHandlers {
  onNew: (payload?: { orderId?: string; orderNumber?: string }) => void;
  refresh: () => unknown;
  refreshBookings: () => unknown;
}

/** Stores whose live order feed is bound right now (the store-room listeners
 * are installed). Order polls may slow only while one is. */
const liveStores = new Map<string, number>();
export function vendorOrderFeedLive(): boolean { return liveStores.size > 0; }

/** Join the store's socket room and refresh the order queries on every order
 * event that room carries (server emit sites: order.service, picking.service,
 * dispatch.service, jobs/queue, booking.service). Rooms are per connection,
 * so it re-joins after reconnects, and only while `mayJoin()` holds. */
export function bindVendorOrderFeed(socket: FeedSocket, vendorId: string, mayJoin: () => boolean, handlers: VendorOrderFeedHandlers): () => void {
  const join = () => { if (mayJoin()) socket.emit('vendor:subscribe', { vendorId }); };
  const refresh = () => { handlers.refresh(); };
  const refreshBookings = () => { handlers.refreshBookings(); };
  join();
  socket.on('connect', join);
  socket.on('order:new', handlers.onNew);
  socket.on('order:status_changed', refresh);
  socket.on('order:prep_update', refresh);
  socket.on('order:pick_state', refresh);
  socket.on('bookings:changed', refreshBookings);
  liveStores.set(vendorId, (liveStores.get(vendorId) ?? 0) + 1);
  let bound = true;
  return () => {
    if (!bound) return;
    bound = false;
    socket.off('connect', join);
    socket.off('order:new', handlers.onNew);
    socket.off('order:status_changed', refresh);
    socket.off('order:prep_update', refresh);
    socket.off('order:pick_state', refresh);
    socket.off('bookings:changed', refreshBookings);
    const left = (liveStores.get(vendorId) ?? 1) - 1;
    if (left > 0) liveStores.set(vendorId, left); else liveStores.delete(vendorId);
  };
}
