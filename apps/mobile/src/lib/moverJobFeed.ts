type JobFeedSocket = {
  emit: (event: string, payload: { orderId: string }) => unknown;
  on: (event: string, callback: (payload?: any) => void) => unknown;
  off: (event: string, callback: (payload?: any) => void) => unknown;
};

/** Order-room events that change what a driver's or rider's live job shows:
 * a status change (the passenger or customer cancels, the store marks the
 * order ready, an admin moves it) or a store prep signal. */
export const MOVER_JOB_EVENTS = ['order:status_changed', 'order:prep_update'] as const;

/**
 * [PERF partner #1] Hear a live job change the moment the server says so.
 *
 * The server already sends every order change to the order's room and lets
 * that order's own driver or rider join it (plugins/socket.ts
 * `order:subscribe`). The partner app never joined, so a cancelled pickup or
 * a ready order reached the job screen only on the next poll (12 s, 30 s on a
 * slow network). Now the app joins the room of each live job and re-reads the
 * job on an event for one of them. The poll stays as the safety net, unchanged.
 *
 * Rooms belong to one connection, so it re-joins after every reconnect. It
 * never leaves a room: other screens may hold the same order room, and the
 * server drops a socket from an order it no longer belongs to.
 */
export function bindMoverJobFeed(
  socket: JobFeedSocket,
  orderIds: readonly string[],
  refresh: () => unknown,
): () => void {
  const ids = new Set(orderIds.filter((id) => typeof id === 'string' && id.length > 0));
  if (ids.size === 0) return () => {};
  const join = () => { for (const orderId of ids) socket.emit('order:subscribe', { orderId }); };
  const onEvent = (payload?: { orderId?: unknown }) => {
    if (typeof payload?.orderId === 'string' && ids.has(payload.orderId)) refresh();
  };
  join();
  socket.on('connect', join);
  for (const event of MOVER_JOB_EVENTS) socket.on(event, onEvent);
  let bound = true;
  return () => {
    if (!bound) return;
    bound = false;
    socket.off('connect', join);
    for (const event of MOVER_JOB_EVENTS) socket.off(event, onEvent);
  };
}
