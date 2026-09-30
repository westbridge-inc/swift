import type { Server } from 'socket.io';

// ---------------------------------------------------------------------------
// [Q10 loud alerts 2/4 · AX291/AX308 F03] A store's live room (`vendor:<id>`,
// every new order and status change) against a removal that races a
// subscription.
//
// A subscription reads the database ("is this person on the team?") and then
// joins. A removal deletes the team row and then takes the person's sockets
// out of the room. If the removal lands between the read and the join, the
// eviction finds nothing to remove and the join that follows would let a
// removed member hear the store's orders. Joining first and checking again
// afterwards only shortens that window: broadcasts published while the
// second check is in flight still reach the socket, and leaving cannot
// un-deliver them.
//
// So the join is gated by a REVOCATION EPOCH, per process and per (store,
// person):
//  - a revocation is applied on a process in ONE synchronous step: the epoch
//    moves, then every local socket of that person leaves the room;
//  - a subscription reads the epoch before its database read, and after the
//    read compares it and joins in the same tick, with nothing awaited in
//    between.
// A join therefore never happens on a process that has already applied the
// revocation. A socket that joined before this process applied it is removed
// when it does. The one window left is the revocation travelling to a
// process, the same for a member who joined an hour ago. A stale
// subscription never extends it.
//
// Across API instances each process applies the revocation from ONE message
// (a server-side event carrying both steps), never from two separate
// messages that could arrive out of order.
// ---------------------------------------------------------------------------

/** The server-side event that carries a revocation to the other instances. */
export const STORE_ROOM_REVOKED = 'store-room:revoked';

const epochs = new Map<string, number>();
const epochKey = (vendorId: string, userId: string) => `${vendorId}:${userId}`;

/** How many revocations THIS process has applied for (store, person). */
export function storeRoomEpoch(vendorId: string, userId: string): number {
  return epochs.get(epochKey(vendorId, userId)) ?? 0;
}

/** Apply a revocation on THIS process, in one synchronous step: the epoch
 *  moves first, then every local socket of the person leaves the room. */
export function applyStoreRoomRevocation(io: Server, vendorId: string, userId: string): void {
  const key = epochKey(vendorId, userId);
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
  io.local.in(`user:${userId}`).socketsLeave(`vendor:${vendorId}`);
}

let clustered = false;

/** Set by the socket plugin when it joins this process to the cross-instance
 *  adapter; server-side events exist only there. */
export function setStoreRoomCluster(on: boolean): void {
  clustered = on;
}

/**
 * Revoke a person's place in a store's live room, everywhere: on this
 * process now, and on every other instance through one server-side event
 * each (the socket plugin applies the same step when it arrives). Call it
 * AFTER the removal is committed, so a subscription that reads the database
 * after any process applied it sees the removal.
 */
export function revokeStoreRoom(io: Server, vendorId: string, userId: string): void {
  applyStoreRoomRevocation(io, vendorId, userId);
  if (clustered) io.serverSideEmit(STORE_ROOM_REVOKED, { vendorId, userId });
}
