import type { PrismaClient } from '@prisma/client';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { freshRidePinReset } from '../rides/ride-pin';
import { chatGuardCounter } from '../../plugins/observability';
import { AppError, ForbiddenError, NotFoundError } from '../../utils/errors';
import { mediaUrlCarriesSecret, redactOrderSecrets, type OrderSecrets } from './secret-guard';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';

// ---------------------------------------------------------------------------
// [R048-004] CHAT AUTHORITY AND THE ONE EGRESS SERIALIZER.
//
// The chat had a deliberate secret scrubber and four ways around it: the room
// list's `lastMessage` and the room-create response returned stored rows raw;
// a media URL was an arbitrary client string stored and re-emitted; a room
// stayed writable after `isActive = false`; and the participant rows written
// when the room was created were never reconciled, so a rider reassigned off
// an order kept reading and writing it. Two default-tenant fallbacks sat in
// the send and create paths.
//
// Now:
//   - ROOM AUTHORITY IS DYNAMIC. Who may read or write a room is computed on
//     every request from the order (customer, its CURRENT rider or driver) or
//     the service job (customer, provider) behind the room, inside that
//     order's tenant — never from the participant rows alone, which are a
//     cache reconciled from the same answer.
//   - ONE SERIALIZER for every egress: the send response, the socket payload,
//     the history page, the room list preview, the create response and the
//     moderation preview all pass through `serializeChatMessage`, which scrubs
//     the text against the order's live codes and emits media only as a
//     signed URL for a server-issued object id.
//   - MEDIA IS SERVER-ISSUED. A message may carry a media object id minted by
//     the room's own upload route (`chat/<roomId>/<random>.<ext>`); any other
//     string is refused at ingress and hidden at egress.
//   - A CLOSED ROOM IS READ-ONLY, and closing is a compare-and-set.
//   - A LIVE CODE TYPED INTO CHAT IS ROTATED. Redaction stops the copy; the
//     secret itself is still known to whoever typed it, so the order's ride
//     PIN is re-issued at once and the old one can no longer close the trip.
// ---------------------------------------------------------------------------

export type ChatSurface = 'send' | 'socket' | 'push' | 'history' | 'list' | 'create' | 'preview' | 'evidence';

/** Order states in which the conversation is over: the room is read-only. */
// [R048-004] The terminal set has ONE owner (modules/order/order-status);
// re-declaring it here is what order-status-single-source.test.ts forbids,
// and how a status added there would silently keep a closed room writable.
const TERMINAL_ORDERS = new Set<string>(TERMINAL_ORDER_STATUSES);
const TERMINAL_JOB_STATUSES = new Set(['COMPLETED', 'CANCELLED']);

export interface RoomAuthority {
  roomId: string;
  tenantId: string;
  orderId: string | null;
  serviceJobId: string | null;
  /** The people the order or job says are in this conversation RIGHT NOW. */
  participants: Map<string, 'customer' | 'rider' | 'driver' | 'provider'>;
  /** The room is open for writing: `isActive`, and the order or job is not over. */
  writable: boolean;
  isActive: boolean;
  secrets: OrderSecrets;
}

/** Resolve a room's authority from the order or job behind it. A room whose
 *  order and job have both vanished has no authority and is not found. */
export async function resolveRoomAuthority(prisma: PrismaClient, roomId: string): Promise<RoomAuthority | null> {
  const room = await prisma.chatRoom.findUnique({ where: { id: roomId }, select: { id: true, orderId: true, serviceJobId: true, isActive: true } });
  if (!room) return null;
  const participants = new Map<string, 'customer' | 'rider' | 'driver' | 'provider'>();
  if (room.orderId) {
    const order = await prisma.order.findUnique({
      where: { id: room.orderId },
      select: { tenantId: true, customerId: true, status: true, ridePin: true, pickupCode: true, rider: { select: { userId: true } }, driver: { select: { userId: true } } },
    });
    if (!order) return null;
    participants.set(order.customerId, 'customer');
    if (order.rider?.userId) participants.set(order.rider.userId, 'rider');
    if (order.driver?.userId) participants.set(order.driver.userId, 'driver');
    return {
      roomId: room.id, tenantId: order.tenantId, orderId: room.orderId, serviceJobId: null, participants,
      isActive: room.isActive, writable: room.isActive && !TERMINAL_ORDERS.has(order.status),
      secrets: { ridePin: order.ridePin, pickupCode: order.pickupCode },
    };
  }
  if (room.serviceJobId) {
    const job = await prisma.serviceJob.findUnique({
      where: { id: room.serviceJobId },
      select: { tenantId: true, customerId: true, status: true, provider: { select: { userId: true } } },
    });
    if (!job) return null;
    participants.set(job.customerId, 'customer');
    participants.set(job.provider.userId, 'provider');
    return {
      roomId: room.id, tenantId: job.tenantId, orderId: null, serviceJobId: room.serviceJobId, participants,
      isActive: room.isActive, writable: room.isActive && !TERMINAL_JOB_STATUSES.has(job.status), secrets: {},
    };
  }
  return null;
}

export type RoomAccess = RoomAuthority & { role: 'customer' | 'rider' | 'driver' | 'provider' };

/**
 * The gate every room request passes. `write` additionally requires the room
 * to be open. A caller the order no longer names — a reassigned rider, a
 * stranger — is refused and counted; the participant cache is reconciled so
 * the socket door (which reads the cache) closes in the same moment.
 */
export async function assertRoomAccess(prisma: PrismaClient, roomId: string, userId: string, opts: { write?: boolean; tenantId?: string | null } = {}): Promise<RoomAccess> {
  const authority = await resolveRoomAuthority(prisma, roomId);
  if (!authority) throw new NotFoundError('Chat room', roomId);
  if (opts.tenantId && opts.tenantId !== authority.tenantId) {
    chatGuardCounter.labels('access', 'tenant_mismatch').inc();
    throw new NotFoundError('Chat room', roomId);
  }
  const role = authority.participants.get(userId);
  if (!role) {
    chatGuardCounter.labels('access', 'stale_participant_refused').inc();
    await reconcileParticipants(prisma, authority).catch(() => undefined);
    throw new ForbiddenError('You are not part of this conversation');
  }
  if (opts.write && !authority.writable) {
    chatGuardCounter.labels('access', 'inactive_room_write_refused').inc();
    throw new AppError(409, 'ROOM_CLOSED', 'This conversation is closed.');
  }
  return { ...authority, role };
}

/** Bring the participant rows in line with the authority: current people are
 *  present, nobody else is. Idempotent; returns what changed. */
export async function reconcileParticipants(prisma: PrismaClient, authority: RoomAuthority): Promise<{ added: number; removed: number }> {
  const rows = await prisma.chatRoomParticipant.findMany({ where: { chatRoomId: authority.roomId }, select: { id: true, userId: true } });
  const present = new Set(rows.map((r) => r.userId));
  const stale = rows.filter((r) => !authority.participants.has(r.userId));
  const missing = [...authority.participants.entries()].filter(([userId]) => !present.has(userId));
  if (stale.length) await prisma.chatRoomParticipant.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
  if (missing.length) await prisma.chatRoomParticipant.createMany({ data: missing.map(([userId, role]) => ({ chatRoomId: authority.roomId, userId, role })), skipDuplicates: true });
  if (stale.length) chatGuardCounter.labels('reconcile', 'stale_participant_removed').inc(stale.length);
  return { added: missing.length, removed: stale.length };
}

/** Close a room exactly once: a compare-and-set on `isActive`. */
export async function deactivateRoom(prisma: PrismaClient, roomId: string): Promise<boolean> {
  const r = await prisma.chatRoom.updateMany({ where: { id: roomId, isActive: true }, data: { isActive: false } });
  return r.count === 1;
}

// ---------------------------------------------------------------------------
// Media: server-issued object ids only
// ---------------------------------------------------------------------------

/** `chat/<roomId>/<random>.<ext>` (the S3/R2 key) or `/uploads/chat/<roomId>/<random>.<ext>` (the local provider). */
const MEDIA_ID = /^(?:\/uploads\/)?chat\/([A-Za-z0-9_-]{1,64})\/[A-Za-z0-9_-]{8,64}\.[a-z0-9]{1,8}$/;

export function isServerIssuedMediaId(value: string | null | undefined, roomId: string): boolean {
  if (!value) return false;
  const m = MEDIA_ID.exec(value);
  return !!m && m[1] === roomId;
}

/** The folder the room's upload route writes into — the id's provenance. */
export const chatMediaFolder = (roomId: string): string => `chat/${roomId}`;

// ---------------------------------------------------------------------------
// The one serializer
// ---------------------------------------------------------------------------

export interface StoredChatMessage {
  id: string;
  chatRoomId: string;
  senderId: string;
  message: string;
  messageType: string;
  mediaUrl: string | null;
  createdAt: Date;
  offPlatformFlag?: boolean;
  isRead?: boolean;
}

export interface ChatMessageView {
  id: string;
  roomId: string;
  senderId: string;
  message: string;
  messageType: string;
  /** A signed, time-limited URL for a server-issued object id — or null. Never the stored string. */
  mediaUrl: string | null;
  createdAt: Date;
  offPlatformFlag: boolean;
  isRead: boolean;
  /** True when this surface removed a live code or hid an attachment. */
  redacted: boolean;
}

/**
 * Every message leaves through here. The text is scrubbed against the order's
 * live codes (a legacy row written before the guard learned a vector is
 * re-scrubbed on the way out); media is emitted only as a signed URL for a
 * server-issued id that carries no secret — a legacy raw URL is hidden.
 * Redactions are counted by surface, never logged as text.
 */
export async function serializeChatMessage(row: StoredChatMessage, authority: Pick<RoomAuthority, 'roomId' | 'secrets'>, surface: ChatSurface): Promise<ChatMessageView> {
  const scrubbed = redactOrderSecrets(row.message, authority.secrets);
  let mediaUrl: string | null = null;
  let mediaHidden = false;
  if (row.mediaUrl) {
    if (isServerIssuedMediaId(row.mediaUrl, authority.roomId) && !mediaUrlCarriesSecret(row.mediaUrl, authority.secrets)) {
      mediaUrl = await signMedia(row.mediaUrl);
    } else {
      mediaHidden = true;
      chatGuardCounter.labels(surface, 'legacy_media_hidden').inc();
    }
  }
  if (scrubbed.redacted) chatGuardCounter.labels(surface, 'redacted').inc();
  return {
    id: row.id, roomId: row.chatRoomId, senderId: row.senderId, message: scrubbed.text, messageType: row.messageType, mediaUrl,
    createdAt: row.createdAt, offPlatformFlag: row.offPlatformFlag ?? false, isRead: row.isRead ?? false, redacted: scrubbed.redacted || mediaHidden,
  };
}

export async function serializeChatMessages(rows: StoredChatMessage[], authority: Pick<RoomAuthority, 'roomId' | 'secrets'>, surface: ChatSurface): Promise<ChatMessageView[]> {
  return Promise.all(rows.map((r) => serializeChatMessage(r, authority, surface)));
}

async function signMedia(mediaId: string): Promise<string | null> {
  try {
    // the local provider stores `/uploads/<key>`; the object key is what gets signed
    const key = mediaId.startsWith('/uploads/') ? mediaId.slice('/uploads/'.length) : mediaId;
    return await getStorageProvider().getSignedUrl(key, 3600);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// A leaked ride PIN is rotated
// ---------------------------------------------------------------------------

/** When the send-path guard removed a live RIDE PIN from a message, the PIN
 *  is already in someone's hands: re-issue it. The pickup code is a
 *  handover proof held by the vendor side and is not rotated here. Returns
 *  true when a rotation happened. */
export async function rotateLeakedRidePin(prisma: PrismaClient, orderId: string, leakedText: string, secrets: OrderSecrets): Promise<boolean> {
  if (!secrets.ridePin) return false;
  // the PIN must have been what was redacted — a pickup-code redaction alone does not rotate the ride PIN
  const pinOnly = redactOrderSecrets(leakedText, { ridePin: secrets.ridePin });
  if (!pinOnly.redacted) return false;
  const r = await prisma.order.updateMany({ where: { id: orderId, ridePin: secrets.ridePin }, data: freshRidePinReset() });
  if (r.count === 1) chatGuardCounter.labels('send', 'ride_pin_rotated').inc();
  return r.count === 1;
}
