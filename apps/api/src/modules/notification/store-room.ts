import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { withTimeout } from '../../utils/async-lifecycle';

// ---------------------------------------------------------------------------
// [Q10 loud alerts 2/4 · AX291/AX308/AX317 F03] A store's live room
// (`vendor:<id>`: every new order and status change) against a removal.
//
// A subscription reads the database ("is this person on the team?") and then
// joins. A removal deletes the team row and then takes the person's sockets
// out of the room. Three things keep a removed member out:
//
// 1. THE REVOCATION EPOCH (a removal racing a subscription on this process).
//    A revocation is applied on a process in ONE synchronous step: the epoch
//    of every subscription in flight for that (store, person) moves, then
//    every local socket of the person leaves the room. A subscription reads
//    the epoch before its database read, and after the read compares it and
//    joins in the same tick, with nothing awaited in between. A subscription
//    whose epoch moved reads the database ONCE more with a fresh epoch
//    (AX317 R2-01), whatever its first answer was, yes or no (AX368 R3-02):
//    a member removed and re-added meanwhile is admitted, a removed one is
//    refused. An answer is also valid for a bounded time only (AX368 R3-01):
//    one that comes later than the read timeout after its read started, or
//    after a convergence pass ran while it was pending (3.), is void and
//    read once more the same way. Epochs live only while a subscription is in
//    flight for the pair (AX317 R2-02): the entry is created by the first
//    subscription and dropped when the last one ends, so nothing accumulates
//    and no entry is ever reset under a subscription that holds it.
//
// 2. THE EVENT STREAM (a removal made on another API instance). Each process
//    applies the revocation from ONE server-side event carrying both steps.
//    That event can be lost: Redis Pub/Sub keeps nothing for a subscriber
//    that is not connected. So the stream is trusted only while it is known
//    to be whole. The moment the adapter's subscriber connection drops, this
//    process stops relying on it and fails closed: every socket leaves its
//    store room (remembered), every subscription in flight is refused its
//    join, and new ones are only remembered. When the subscriber is back and
//    its subscriptions are acknowledged, every remembered membership is read
//    again from the database; members are put back, anyone removed in the
//    gap is not. Only then is the stream trusted again.
//
// 3. CONVERGENCE (anything else: an event lost without the connection
//    dropping, a membership ended by a path that sent no revocation). Every
//    interval the socket plugin re-reads the membership of every socket in a
//    store room on this process and evicts every one that is no longer a
//    member. A read that fails is failed closed: those sockets leave their
//    rooms until a read succeeds. A pass's snapshot includes the
//    subscriptions still waiting for their read, which then read once more
//    (AX368 R3-01): whoever joins after a pass began was admitted by a read
//    that began after it. So a member whose revocation never arrived is out
//    within one interval plus one read timeout of the removal's commit, and
//    the two together are never above 60 s (storeRoomTiming).
// ---------------------------------------------------------------------------

/** The server-side event that carries a revocation to the other instances. */
export const STORE_ROOM_REVOKED = 'store-room:revoked';

/** [AX368 R3-01] The most time, from a removal's commit, a member whose
 *  revocation never arrived can stay in a store room: strict. */
export const STORE_ROOM_EVICTION_BOUND_MS = 60_000;

export interface StoreRoomTiming {
  /** How often every store-room membership on the process is read again. */
  intervalMs: number;
  /** How long one membership read, a pass's or a subscription's, may take;
   *  an answer that comes later is never acted on. */
  readTimeoutMs: number;
}

/**
 * [AX368 R3-01] The store-room timing from the configured interval and read
 * timeout. A member whose revocation never arrived leaves the room within
 * intervalMs + readTimeoutMs of the removal's commit: a pass starts within one
 * interval of it, and that pass's read began after the commit and answers, or
 * fails closed, within the read timeout. The read timeout is never longer than
 * the interval, so a pass that began before the commit (and whose read cannot
 * speak for it) ends in time for the next one to keep that bound. Both are
 * clamped so the bound never exceeds STORE_ROOM_EVICTION_BOUND_MS.
 */
export function storeRoomTiming(configuredIntervalMs: number, configuredReadTimeoutMs: number): StoreRoomTiming {
  const read = Math.min(configuredReadTimeoutMs, STORE_ROOM_EVICTION_BOUND_MS / 2);
  const intervalMs = Math.min(configuredIntervalMs, STORE_ROOM_EVICTION_BOUND_MS - read);
  return { intervalMs, readTimeoutMs: Math.min(read, intervalMs) };
}

const ROOM_PREFIX = 'vendor:';
/** A phone is on one or two teams; anything past this is not remembered. */
const MAX_REMEMBERED_STORES_PER_SOCKET = 8;

/** Who may hear a store room: the store, the person, and the tenant the
 *  person's socket was authenticated in. */
export interface StoreRoomPair { vendorId: string; userId: string; tenantId: string }

/** One unambiguous key per (tenant, store, person) membership verdict. */
export function storeRoomMemberKey(pair: StoreRoomPair): string {
  return JSON.stringify([pair.tenantId, pair.vendorId, pair.userId]);
}

/** Reads which of these pairs are members now (keys from storeRoomMemberKey). */
export type ReadStoreRoomMembers = (pairs: StoreRoomPair[]) => Promise<Set<string>>;

/** The adapter's subscriber connection, as far as the store rooms need it. */
export interface StoreRoomStream {
  readonly status: string;
  on(event: 'close' | 'end' | 'ready', listener: () => void): unknown;
  off(event: 'close' | 'end' | 'ready', listener: () => void): unknown;
  ping(): Promise<unknown>;
}

export interface StoreRoomConvergeOptions {
  readMembers: ReadStoreRoomMembers;
  /** Bounds the stream barrier and the membership read, each. */
  timeoutMs: number;
  log?: {
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

export type StoreRoomConvergeOutcome =
  | 'converged' // re-validated; evicted whoever is no longer a member
  | 'restored' // the stream is whole again and every membership re-validated
  | 'idle' // nobody in a store room here
  | 'stream_down' // the subscriber is not back yet: stay closed
  | 'interrupted' // the stream dropped (again) during the pass: stay closed
  | 'read_failed' // the database could not say: failed closed
  | 'closed'; // the server is shutting down

export interface StoreRoomConvergence {
  outcome: StoreRoomConvergeOutcome;
  checked: number;
  evicted: number;
  readmitted: number;
  /** Subscriptions whose read was pending at the snapshot: each reads again. */
  superseded: number;
}

interface PairState { epoch: number; inflight: number }
interface Ticket {
  key: string;
  epoch: number;
  generation: number;
  /** [AX368 R3-01] When the read began (performance.now()). */
  startedAt: number;
  /** [AX368 R3-01] A convergence pass took its snapshot while this
   *  subscription's read was pending: its answer is older than that pass. */
  superseded: boolean;
  ended: boolean;
}

interface StoreRoomState {
  /** (store, person) pairs with a subscription in flight: nothing else. */
  pairs: Map<string, PairState>;
  /** [AX368 R3-01] The subscriptions whose membership read is pending. */
  pending: Set<Ticket>;
  clustered: boolean;
  stream: { trusted: boolean; generation: number; client?: StoreRoomStream };
  /** Sockets out of a room until their membership is read again. */
  remembered: Map<string, Set<string>>;
  /** When each socket last joined each store room (to never undo a fresher admission). */
  joins: WeakMap<Socket, Map<string, number>>;
  joinSeq: number;
  converging?: Promise<StoreRoomConvergence>;
  convergeAgain: boolean;
  closed: boolean;
}

const servers = new WeakMap<Server, StoreRoomState>();

function stateOf(io: Server): StoreRoomState {
  let state = servers.get(io);
  if (!state) {
    state = {
      pairs: new Map(),
      pending: new Set(),
      clustered: false,
      stream: { trusted: true, generation: 0 },
      remembered: new Map(),
      joins: new WeakMap(),
      joinSeq: 0,
      convergeAgain: false,
      closed: false,
    };
    servers.set(io, state);
  }
  return state;
}

const pairKey = (vendorId: string, userId: string) => JSON.stringify([vendorId, userId]);

function beginTicket(state: StoreRoomState, vendorId: string, userId: string, subscription: boolean): Ticket {
  const key = pairKey(vendorId, userId);
  let pair = state.pairs.get(key);
  if (!pair) {
    pair = { epoch: 0, inflight: 0 };
    state.pairs.set(key, pair);
  }
  pair.inflight += 1;
  const ticket: Ticket = {
    key, epoch: pair.epoch, generation: state.stream.generation, startedAt: performance.now(), superseded: false, ended: false,
  };
  if (subscription) state.pending.add(ticket);
  return ticket;
}

/** Nothing was revoked for the pair, the stream did not drop, and no
 *  convergence pass took its snapshot, since the ticket was taken. */
function ticketHolds(state: StoreRoomState, ticket: Ticket): boolean {
  return !ticket.superseded && state.pairs.get(ticket.key)?.epoch === ticket.epoch && state.stream.generation === ticket.generation;
}

function endTicket(state: StoreRoomState, ticket: Ticket): void {
  if (ticket.ended) return;
  ticket.ended = true;
  state.pending.delete(ticket);
  const pair = state.pairs.get(ticket.key);
  if (!pair) return;
  pair.inflight -= 1;
  // [AX317 R2-02] The last subscription for the pair is done: no one holds
  // its epoch, so the entry goes. A later subscription starts a fresh entry
  // and reads the database after any revocation already applied.
  if (pair.inflight <= 0) state.pairs.delete(ticket.key);
}

function bumpEpoch(state: StoreRoomState, vendorId: string, userId: string): void {
  const pair = state.pairs.get(pairKey(vendorId, userId));
  if (pair) pair.epoch += 1;
}

function markJoined(state: StoreRoomState, socket: Socket, vendorId: string): void {
  state.joinSeq += 1;
  let joins = state.joins.get(socket);
  if (!joins) {
    joins = new Map();
    state.joins.set(socket, joins);
  }
  joins.set(vendorId, state.joinSeq);
}

function joinedAtOrBefore(state: StoreRoomState, socket: Socket, vendorId: string, seq: number): boolean {
  return (state.joins.get(socket)?.get(vendorId) ?? 0) <= seq;
}

function remember(state: StoreRoomState, socketId: string, vendorId: string): void {
  let stores = state.remembered.get(socketId);
  if (!stores) {
    stores = new Set();
    state.remembered.set(socketId, stores);
  }
  if (stores.size < MAX_REMEMBERED_STORES_PER_SOCKET) stores.add(vendorId);
}

function storeRoomsOf(socket: Socket): string[] {
  return [...socket.rooms].filter((room) => room.startsWith(ROOM_PREFIX)).map((room) => room.slice(ROOM_PREFIX.length));
}

function pairOf(socket: Socket, vendorId: string): StoreRoomPair | null {
  const { userId, tenantId } = socket.data as { userId?: unknown; tenantId?: unknown };
  if (typeof userId !== 'string' || typeof tenantId !== 'string') return null;
  return { vendorId, userId, tenantId };
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

/** Apply a revocation on THIS process, in one synchronous step: every
 *  subscription in flight for the pair loses its epoch, then every local
 *  socket of the person leaves the room. */
function applyStoreRoomRevocation(io: Server, vendorId: string, userId: string): void {
  bumpEpoch(stateOf(io), vendorId, userId);
  io.local.in(`user:${userId}`).socketsLeave(`${ROOM_PREFIX}${vendorId}`);
}

/**
 * Revoke a person's place in a store's live room, everywhere: on this
 * process now, and on every other instance through one server-side event
 * each. Call it AFTER the removal is committed and with nothing awaited in
 * between, so a subscription that reads the database after any process
 * applied it sees the removal.
 */
export function revokeStoreRoom(io: Server, vendorId: string, userId: string): void {
  applyStoreRoomRevocation(io, vendorId, userId);
  if (stateOf(io).clustered) io.serverSideEmit(STORE_ROOM_REVOKED, { vendorId, userId });
}

const revocationEvent = z.object({ vendorId: z.string().min(1).max(64), userId: z.string().min(1).max(64) });

/** Apply the revocations other instances send; the payload is validated like
 *  any wire input. Only instances on the cross-instance adapter receive any. */
export function listenForStoreRoomRevocations(io: Server): void {
  io.on(STORE_ROOM_REVOKED, (raw: unknown) => {
    const parsed = revocationEvent.safeParse(raw);
    if (parsed.success) applyStoreRoomRevocation(io, parsed.data.vendorId, parsed.data.userId);
  });
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/** [AX368 R3-01] One membership read, waited for at most readTimeoutMs:
 *  `undefined` when it has not answered by then (whatever it says later is
 *  never heard). A read that fails answers no: the socket simply does not
 *  join. */
function answerWithin(isMember: () => Promise<boolean>, readTimeoutMs: number): Promise<boolean | undefined> {
  let answer: Promise<boolean>;
  try {
    answer = Promise.resolve(isMember()).catch(() => false);
  } catch {
    answer = Promise.resolve(false);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), readTimeoutMs);
    timer.unref?.();
  });
  return Promise.race([answer, late]).finally(() => clearTimeout(timer));
}

/**
 * Admit a socket to a store room if its person may hear it: read, compare,
 * join. Returns whether it joined. At most two reads (AX317 R2-01), each
 * answered within `readTimeoutMs` or void. While the event stream is not known
 * to be whole the join is refused and the request remembered: it is admitted
 * once the stream is back and the membership was read again.
 */
export async function subscribeToStoreRoom(
  io: Server,
  socket: Socket,
  vendorId: string,
  isMember: () => Promise<boolean>,
  readTimeoutMs: number,
): Promise<boolean> {
  const state = stateOf(io);
  const pair = pairOf(socket, vendorId);
  if (!pair) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (state.closed) return false;
    if (!state.stream.trusted) {
      remember(state, socket.id, vendorId);
      return false;
    }
    const ticket = beginTicket(state, vendorId, pair.userId, true);
    try {
      const member = await answerWithin(isMember, readTimeoutMs);
      if (!socket.connected) return false;
      // [AX368 R3-01/R3-02] An answer, yes or no, is accepted only once it is
      // known to still hold: it came within the read timeout of when its read
      // began, and nothing happened while it was pending (a revocation for
      // this pair, a drop of the stream, a convergence pass). Compare and
      // join in the same tick: nothing awaited in between.
      const inTime = member !== undefined && performance.now() - ticket.startedAt <= readTimeoutMs;
      if (inTime && state.stream.trusted && ticketHolds(state, ticket)) {
        if (!member) return false;
        void socket.join(`${ROOM_PREFIX}${vendorId}`);
        markJoined(state, socket, vendorId);
        return true;
      }
      // The stream dropped during the read: the request waits for the
      // re-validation that restores it (whatever attempt this was).
      if (!state.stream.trusted && !state.closed) {
        remember(state, socket.id, vendorId);
        return false;
      }
      // The answer is void: late, or older than a revocation for this pair, a
      // drop and a recovery of the stream, or a convergence pass. It may
      // predate a removal, or a removal and a re-add: read ONCE more, fresh.
    } finally {
      endTicket(state, ticket);
    }
  }
  return false;
}

const subscribeEvent = z.object({ vendorId: z.string().min(1).max(64) });

/**
 * The `vendor:subscribe` handler for one socket: validate the payload, admit
 * through subscribeToStoreRoom, and answer an optional ack with the outcome.
 * `isMember` is the store-room rule for this socket's person and tenant.
 */
export function storeRoomSubscribeHandler(
  io: Server,
  socket: Socket,
  isMember: (vendorId: string) => Promise<boolean>,
  readTimeoutMs: number,
): (raw: unknown, ack?: unknown) => Promise<void> {
  return async (raw: unknown, ack?: unknown) => {
    const reply = (joined: boolean) => {
      if (typeof ack === 'function') (ack as (result: { joined: boolean }) => void)({ joined });
    };
    const parsed = subscribeEvent.safeParse(raw);
    if (!parsed.success) return reply(false);
    const { vendorId } = parsed.data;
    reply(await subscribeToStoreRoom(io, socket, vendorId, () => isMember(vendorId), readTimeoutMs));
  };
}

/** A socket is gone: forget what was remembered for it. */
export function forgetStoreRoomSocket(io: Server, socketId: string): void {
  stateOf(io).remembered.delete(socketId);
}

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------

/** On a single process there is no stream to lose; the socket plugin turns
 *  this on only once the cross-instance adapter's subscriptions are verified. */
export function setStoreRoomCluster(io: Server, on: boolean): void {
  stateOf(io).clustered = on;
}

/**
 * The stream may have lost events: stop relying on it, fail closed. Every
 * socket leaves its store room (remembered, to be read again), and every
 * subscription in flight is refused its join (the generation moved).
 */
function interruptStoreRoomStream(io: Server): void {
  const state = stateOf(io);
  state.stream.generation += 1;
  state.stream.trusted = false;
  for (const socket of io.of('/').sockets.values()) {
    for (const vendorId of storeRoomsOf(socket)) {
      remember(state, socket.id, vendorId);
      void socket.leave(`${ROOM_PREFIX}${vendorId}`);
    }
  }
}

/**
 * Join the store rooms to the cross-instance adapter: revocations are now
 * sent to the other instances, and the subscriber connection is watched. A
 * drop fails closed (interruptStoreRoomStream); a reconnect runs `converge`,
 * which restores the stream only after re-reading every membership. Returns
 * the detach for shutdown.
 */
export function joinStoreRoomCluster(io: Server, stream: StoreRoomStream, converge: () => Promise<unknown>): () => void {
  const state = stateOf(io);
  state.clustered = true;
  state.stream.client = stream;
  const interrupted = () => interruptStoreRoomStream(io);
  // On a reconnect ioredis (5.x readyHandler) marks the client ready, writes
  // the re-subscriptions, and emits `ready` a tick later. The pass does not
  // rely on that order: it waits a turn and puts a PING behind whatever the
  // client has written, so the reply proves the subscriptions were processed
  // (convergeStoreRooms). A pass never rejects into this listener; a crash
  // is the caller's to log.
  const ready = () => {
    setImmediate(() => {
      converge().catch(() => { /* logged by the caller's converge */ });
    });
  };
  stream.on('close', interrupted);
  stream.on('end', interrupted);
  stream.on('ready', ready);
  return () => {
    stream.off('close', interrupted);
    stream.off('end', interrupted);
    stream.off('ready', ready);
  };
}

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

/**
 * Re-validate every store-room membership on this process against the
 * database: evict whoever is no longer a member, put back whoever was
 * remembered and still is. When the stream is not trusted, first make sure it
 * is whole again (the subscriber is ready and a PING sent behind its
 * re-subscriptions has come back), and trust it only after the re-validation.
 * One pass at a time per server; a pass asked for while one runs runs after
 * it.
 */
export function convergeStoreRooms(io: Server, opts: StoreRoomConvergeOptions): Promise<StoreRoomConvergence> {
  const state = stateOf(io);
  if (state.converging) {
    state.convergeAgain = true;
    return state.converging;
  }
  const run = async (): Promise<StoreRoomConvergence> => {
    let result: StoreRoomConvergence;
    do {
      state.convergeAgain = false;
      result = await convergeOnce(io, state, opts);
    } while (state.convergeAgain && !state.closed);
    return result;
  };
  state.converging = run().finally(() => { state.converging = undefined; });
  return state.converging;
}

async function convergeOnce(io: Server, state: StoreRoomState, opts: StoreRoomConvergeOptions): Promise<StoreRoomConvergence> {
  const none = (outcome: StoreRoomConvergeOutcome, superseded = 0): StoreRoomConvergence => ({ outcome, checked: 0, evicted: 0, readmitted: 0, superseded });
  if (state.closed) return none('closed');
  const generation = state.stream.generation;
  const restoring = !state.stream.trusted;
  if (restoring) {
    const client = state.stream.client;
    if (!client || client.status !== 'ready') return none('stream_down');
    try {
      await withTimeout(client.ping(), opts.timeoutMs, 'Store-room stream barrier');
    } catch (error) {
      opts.log?.warn({ err: error }, '[AX317 F03] store-room stream not confirmed yet; store rooms stay closed');
      return none('stream_down');
    }
    if (state.stream.generation !== generation) return none('interrupted');
  }

  // [AX368 R3-01] The snapshot includes every subscription whose membership
  // read is still pending. Its answer began before this pass's read, so it is
  // never acted on: it reads once more, after this point. So whoever joins
  // after the snapshot was admitted by a read that began after it, and a
  // member removed before this pass is evicted by it or never admitted.
  let superseded = 0;
  for (const ticket of state.pending) {
    ticket.superseded = true;
    superseded += 1;
  }

  const sockets = io.of('/').sockets;
  const snapshotSeq = state.joinSeq;
  const inRoom: Array<{ socket: Socket; pair: StoreRoomPair | null; vendorId: string }> = [];
  for (const socket of sockets.values()) {
    for (const vendorId of storeRoomsOf(socket)) inRoom.push({ socket, pair: pairOf(socket, vendorId), vendorId });
  }
  const held: Array<{ socket: Socket; pair: StoreRoomPair | null; vendorId: string }> = [];
  for (const [socketId, stores] of state.remembered) {
    const socket = sockets.get(socketId);
    if (!socket?.connected) {
      state.remembered.delete(socketId);
      continue;
    }
    for (const vendorId of stores) held.push({ socket, pair: pairOf(socket, vendorId), vendorId });
  }
  if (inRoom.length === 0 && held.length === 0) {
    if (restoring) state.stream.trusted = true;
    return none(restoring ? 'restored' : 'idle', superseded);
  }

  const pairs = new Map<string, StoreRoomPair>();
  for (const { pair } of [...inRoom, ...held]) if (pair) pairs.set(storeRoomMemberKey(pair), pair);
  // Tickets before the read: a revocation applied while it runs is seen by
  // the comparison below, exactly as for a subscription.
  const tickets = new Map<string, Ticket>();
  for (const pair of pairs.values()) {
    const key = pairKey(pair.vendorId, pair.userId);
    if (!tickets.has(key)) tickets.set(key, beginTicket(state, pair.vendorId, pair.userId, false));
  }
  try {
    let members: Set<string>;
    try {
      members = pairs.size > 0
        ? await withTimeout(opts.readMembers([...pairs.values()]), opts.timeoutMs, 'Store-room membership re-validation')
        : new Set();
    } catch (error) {
      // Fail closed: whoever this pass could not vouch for leaves the room
      // until a read succeeds (a fresher admission is left alone).
      let closed = 0;
      if (state.stream.generation === generation) {
        for (const { socket, vendorId } of inRoom) {
          if (!socket.rooms.has(`${ROOM_PREFIX}${vendorId}`) || !joinedAtOrBefore(state, socket, vendorId, snapshotSeq)) continue;
          remember(state, socket.id, vendorId);
          void socket.leave(`${ROOM_PREFIX}${vendorId}`);
          closed += 1;
        }
      }
      opts.log?.error({ err: error, sockets: closed }, '[AX317 F03] store-room membership unreadable; those sockets leave their rooms until it is');
      return { outcome: 'read_failed', checked: pairs.size, evicted: closed, readmitted: 0, superseded };
    }
    // From here to the end of the pass nothing is awaited.
    if (state.stream.generation !== generation) return { outcome: 'interrupted', checked: pairs.size, evicted: 0, readmitted: 0, superseded };

    let evicted = 0;
    for (const { socket, pair, vendorId } of inRoom) {
      if (pair && members.has(storeRoomMemberKey(pair))) continue;
      const room = `${ROOM_PREFIX}${vendorId}`;
      if (!socket.rooms.has(room)) continue;
      // A join after this pass began was admitted by a fresher read: one that
      // began after the snapshot (AX368 R3-01).
      if (!joinedAtOrBefore(state, socket, vendorId, snapshotSeq)) continue;
      void socket.leave(room);
      if (pair) bumpEpoch(state, vendorId, pair.userId);
      evicted += 1;
    }
    let readmitted = 0;
    for (const { socket, pair, vendorId } of held) {
      const stores = state.remembered.get(socket.id);
      if (!stores?.has(vendorId)) continue;
      if (!pair || !members.has(storeRoomMemberKey(pair))) {
        stores.delete(vendorId); // not a member: never put back
        continue;
      }
      const ticket = tickets.get(pairKey(vendorId, pair.userId));
      // Revoked while this pass read: keep it remembered for the next one.
      if (!ticket || !ticketHolds(state, ticket) || !socket.connected) continue;
      void socket.join(`${ROOM_PREFIX}${vendorId}`);
      markJoined(state, socket, vendorId);
      stores.delete(vendorId);
      readmitted += 1;
    }
    for (const [socketId, stores] of state.remembered) if (stores.size === 0) state.remembered.delete(socketId);
    if (evicted > 0) opts.log?.warn({ evicted }, '[AX317 F03] store-room re-validation evicted sockets that are no longer members');
    if (restoring) state.stream.trusted = true;
    return { outcome: restoring ? 'restored' : 'converged', checked: pairs.size, evicted, readmitted, superseded };
  } finally {
    for (const ticket of tickets.values()) endTicket(state, ticket);
  }
}

/** Shutdown: no new pass starts; resolves when the one running ends. */
export async function closeStoreRooms(io: Server): Promise<void> {
  const state = stateOf(io);
  state.closed = true;
  await state.converging;
}

// ---------------------------------------------------------------------------
// Inspection (tests and diagnostics)
// ---------------------------------------------------------------------------

/** The epoch in-flight subscriptions of a pair are measured against, or
 *  null when none is in flight. */
export function storeRoomEpoch(io: Server, vendorId: string, userId: string): number | null {
  return stateOf(io).pairs.get(pairKey(vendorId, userId))?.epoch ?? null;
}
