import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { detectOffPlatformContact, OFF_PLATFORM_WARNING } from './off-platform';
import { digitRun, mediaUrlCarriesSecret, redactOrderSecrets, SECRET_REDACTED_WARNING } from './secret-guard';
import {
  assertRoomAccess, chatMediaFolder, isServerIssuedMediaId, reconcileParticipants, resolveRoomAuthority, rotateLeakedRidePin,
  serializeChatMessage, serializeChatMessages,
} from './chat-authority';
import { NotificationService } from '../notification/notification.service';
import { assertUsersMayContact } from '../moderation/user-block.service';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { ALLOWED_IMAGE_TYPES, looksLikeImage } from '../../utils/images';
import { chatGuardCounter } from '../../plugins/observability';
import { AppError, NotFoundError, ForbiddenError } from '../../utils/errors';

/** How far back the split-code check looks. Bounded on BOTH axes on purpose:
 *  an unbounded scan of a long conversation would put an O(history) query on
 *  the send path, which is a denial-of-service surface reachable by anyone who
 *  can chat. Twelve messages inside ten minutes covers a code typed in pieces
 *  without covering a day of ordinary conversation. */
const SPLIT_CODE_LOOKBACK = 12;
const SPLIT_CODE_WINDOW_MS = 10 * 60 * 1000;

/** The digits this sender has recently put into this room, oldest first, so a
 *  code delivered across several messages reads the way the RECIPIENT reads
 *  it: in order, as one string. */
async function recentSenderDigits(app: FastifyInstance, roomId: string, senderId: string): Promise<string> {
  const since = new Date(Date.now() - SPLIT_CODE_WINDOW_MS);
  const rows = await app.prisma.chatMessage.findMany({
    where: { chatRoomId: roomId, senderId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: SPLIT_CODE_LOOKBACK,
    select: { message: true },
  });
  return rows.reverse().map((r: { message: string }) => digitRun(r.message)).join('');
}

const createRoomSchema = z.object({
  orderId: z.string().min(1),
});

const sendMessageSchema = z.object({
  message: z.string().min(1).max(2000),
  messageType: z.string().min(1).max(30).default('text'),
  /** [R048-004] A media object id minted by this room's upload route — never an arbitrary URL. */
  mediaId: z.string().max(256).optional(),
  /** Legacy field, refused: a client-supplied URL is not stored (see `mediaId`). */
  mediaUrl: z.string().max(2048).optional(),
});

const messagesQuerySchema = z.object({
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------------------
// [R048-004] Every boundary of a room — create, media upload, send, history,
// read, list, and the socket door in plugins/socket.ts — passes
// `assertRoomAccess`: the order's CURRENT people inside the order's tenant, a
// closed room read-only. Every message leaves through the ONE serializer in
// chat-authority.ts. There is no default tenant anywhere in this file.
// ---------------------------------------------------------------------------

export async function chatRoutes(app: FastifyInstance) {
  const notifications = new NotificationService(app.prisma, app.io);

  // Get or create chat room for an order
  app.post('/rooms', { preHandler: [app.authenticate] }, async (request) => {
    const { orderId } = createRoomSchema.parse(request.body);

    // Verify user is part of this order
    const order = await app.prisma.order.findUnique({
      where: { id: orderId },
      select: { tenantId: true, customerId: true, riderId: true, driverId: true, rider: { select: { userId: true } }, driver: { select: { userId: true } } },
    });

    // UG-CRAFT-02: chat previously hand-rolled 200-with-success:false error
    // envelopes — axios clients RESOLVED them as success and rendered broken
    // empties. Thrown AppErrors ride the platform taxonomy like every other
    // module (real status codes, standard client error handling).
    if (!order) throw new NotFoundError('Order', orderId);
    // [R048-004] the order lives in one tenant; a caller bound to another does not see it
    if (request.tenantId && request.tenantId !== order.tenantId) {
      chatGuardCounter.labels('create', 'tenant_mismatch').inc();
      throw new NotFoundError('Order', orderId);
    }

    const participantUserIds = [order.customerId];
    if (order.rider?.userId) participantUserIds.push(order.rider.userId);
    if (order.driver?.userId) participantUserIds.push(order.driver.userId);

    if (!participantUserIds.includes(request.user.userId)) {
      throw new ForbiddenError('You are not part of this order');
    }

    // [STORE-002] A block stops contact in BOTH directions. Checked before the
    // room is created rather than only on send, so a blocked party never gets
    // an open room they can watch.
    // [R048-004] The tenant is the ORDER's — never a default the caller did not earn.
    const tenantId = order.tenantId;
    for (const other of participantUserIds.filter((uid) => uid !== request.user.userId)) {
      await assertUsersMayContact(app.prisma, tenantId, request.user.userId, other);
    }

    // Find existing room
    let room = await app.prisma.chatRoom.findFirst({
      where: { orderId },
      include: {
        participants: { include: { user: { select: { id: true, firstName: true, avatar: true } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });

    if (!room) {
      room = await app.prisma.chatRoom.create({
        data: {
          orderId,
          participants: {
            create: participantUserIds.map((uid) => ({
              userId: uid,
              role: uid === order.customerId ? 'customer' : 'rider',
            })),
          },
        },
        include: {
          participants: { include: { user: { select: { id: true, firstName: true, avatar: true } } } },
          messages: { orderBy: { createdAt: 'desc' }, take: 50 },
        },
      });
    }

    // [R048-004] The participant rows are a cache of the order's CURRENT people — reconciled on
    // every open — and the create response is an egress like any other: its messages pass
    // through the ONE serializer.
    const authority = await resolveRoomAuthority(app.prisma, room.id);
    if (authority) {
      const changed = await reconcileParticipants(app.prisma, authority);
      if (changed.added || changed.removed) {
        room = (await app.prisma.chatRoom.findUnique({
          where: { id: room.id },
          include: {
            participants: { include: { user: { select: { id: true, firstName: true, avatar: true } } } },
            messages: { orderBy: { createdAt: 'desc' }, take: 50 },
          },
        })) ?? room;
      }
    }
    const messages = authority ? await serializeChatMessages(room.messages, authority, 'create') : [];
    return { success: true, data: { ...room, messages } };
  });

  /**
   * [R048-004] Chat media is SERVER-ISSUED: the only way to attach an image is
   * to upload it here, inside the room, as a current participant, while the
   * room is open. The returned id is the object key under the room's own
   * folder; a message carrying anything else is refused.
   */
  app.post('/rooms/:roomId/media', { preHandler: [app.authenticate] }, async (request) => {
    const { roomId } = request.params as { roomId: string };
    await assertRoomAccess(app.prisma, roomId, request.user.userId, { write: true, tenantId: request.tenantId });
    const file = await request.file();
    if (!file) throw new AppError(400, 'NO_FILE', 'Attach an image');
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      chatGuardCounter.labels('media', 'media_rejected').inc();
      throw new AppError(400, 'BAD_IMAGE_TYPE', 'Only JPEG, PNG, or WebP images are accepted');
    }
    const buffer = await file.toBuffer();
    if (!looksLikeImage(buffer)) {
      chatGuardCounter.labels('media', 'media_rejected').inc();
      throw new AppError(400, 'BAD_IMAGE', 'File content does not match an image format');
    }
    const { url } = await getStorageProvider().upload({ buffer, filename: file.filename, mimeType: file.mimetype, folder: chatMediaFolder(roomId) });
    if (!isServerIssuedMediaId(url, roomId)) throw new AppError(500, 'MEDIA_ID_UNEXPECTED', 'The storage provider returned an id outside the room folder');
    return { success: true, data: { mediaId: url } };
  });

  // Send a message
  app.post('/rooms/:roomId/messages', { preHandler: [app.authenticate] }, async (request) => {
    const { roomId } = request.params as { roomId: string };
    const { message, messageType, mediaId, mediaUrl } = sendMessageSchema.parse(request.body);

    // [R048-004] Authority is the order's CURRENT people, inside the order's tenant, and the room must be open.
    const access = await assertRoomAccess(app.prisma, roomId, request.user.userId, { write: true, tenantId: request.tenantId });

    // [R048-004] A client-supplied media URL is not stored — not scrubbed, not stored: refused.
    if (mediaUrl !== undefined) {
      chatGuardCounter.labels('send', 'media_rejected').inc();
      throw new AppError(400, 'MEDIA_URL_NOT_ACCEPTED', 'Attach media by uploading it to this conversation first; a URL is not accepted.');
    }
    if (mediaId !== undefined && !isServerIssuedMediaId(mediaId, roomId)) {
      chatGuardCounter.labels('send', 'media_rejected').inc();
      throw new AppError(400, 'MEDIA_ID_INVALID', 'That attachment does not belong to this conversation.');
    }

    // [STORE-002] Someone can be blocked mid-conversation — which is exactly
    // when a person reaches for it. Refuse the SEND, in both directions, and
    // say so plainly: a message silently swallowed leaves the sender believing
    // it arrived, and that is its own kind of harm.
    //
    // Reading is deliberately still allowed. The transcript already written is
    // how a customer finds "I left it inside your gate" after they have blocked
    // the person who wrote it; deleting or hiding it would destroy the record
    // at the moment it matters most.
    const otherUserIds = [...access.participants.keys()].filter((uid) => uid !== request.user.userId);
    for (const other of otherUserIds) {
      await assertUsersMayContact(app.prisma, access.tenantId, request.user.userId, other);
    }

    // Off-platform contact detection (spec §2): the message still delivers —
    // the sender gets a soft nudge and the flag feeds risk signals. Detection,
    // never censorship.
    const offPlatform = detectOffPlatformContact(message);

    // [F-027-12] ...with exactly one exception. The order's pickup/ride code is
    // not content to moderate, it is the proof that the driver physically met
    // the customer. Chat puts the driver in the room and copies message text
    // verbatim into the other participants' PUSH bodies, so an unguarded room
    // both defeats the control and lands the secret on a lock screen. Strip it
    // BEFORE the row is written, the socket fires, or a push is built — a
    // stored original is its own disclosure channel.
    const secrets = access.orderId ? access.secrets : null;

    // [F-028-02] A code split across messages — "481" then "902" — arrives
    // whole in the ordered transcript while each part looks innocent. Judge
    // this message against the digits THIS sender has already put in THIS
    // room recently, so the pieces are read the way the reader reads them.
    // Bounded by count and by time: a guard that walks an entire conversation
    // is a denial-of-service surface on the send path.
    const priorDigits = secrets
      ? await recentSenderDigits(app, roomId, request.user.userId)
      : '';
    const guarded = redactOrderSecrets(message, secrets ?? {}, priorDigits);
    const body = guarded.text;
    if (guarded.redacted) chatGuardCounter.labels('send', 'redacted').inc();

    // [R048-004] A server-issued id cannot name the code by construction (a random name under the
    // room's folder); the check stays as the invariant it is.
    const mediaBlocked = mediaId !== undefined && mediaUrlCarriesSecret(mediaId, secrets ?? {});
    const safeMediaId = mediaBlocked ? undefined : mediaId;

    const msg = await app.prisma.chatMessage.create({
      data: {
        chatRoomId: roomId,
        senderId: request.user.userId,
        message: body,
        messageType,
        mediaUrl: safeMediaId,
        offPlatformFlag: offPlatform,
      },
    });

    // [R048-004] A live ride PIN typed into chat is in someone's hands now: re-issue it.
    if (guarded.redacted && access.orderId) await rotateLeakedRidePin(app.prisma, access.orderId, message, secrets ?? {});

    // ONE serializer for every egress: the socket payload, the push body and the response are the same view.
    const view = await serializeChatMessage(msg, access, 'socket');

    // Broadcast via Socket.IO
    app.io.to(`chat:${roomId}`).emit('chat:message', {
      id: view.id,
      roomId,
      senderId: request.user.userId,
      message: view.message,
      messageType: view.messageType,
      mediaUrl: view.mediaUrl,
      createdAt: view.createdAt,
    });

    // Notify other participants — the order's CURRENT people, not the cached rows
    const sender = await app.prisma.user.findUnique({ where: { id: request.user.userId }, select: { firstName: true } });
    // SWIFT-101: route through NotificationService — the ONE notification path
    // (rule #17) — so a chat message is delivered as a PUSH (when the provider
    // is live), respects the recipient's prefs, and lands in the failure
    // metrics. The old code wrote a row + a socket emit only, so a backgrounded
    // app never learned about the message.
    for (const userId of otherUserIds) {
      await notifications.send({
        userId,
        type: 'CHAT_MESSAGE',
        title: `Message from ${sender?.firstName || 'Someone'}`,
        body: view.message.substring(0, 100),
        data: { roomId, messageId: msg.id },
      });
    }

    return {
      success: true,
      data: view,
      // [F-027-12] The redaction warning wins: silently mangling someone's
      // text is worse than the nudge it would have replaced, and this is the
      // one they need to read.
      // A dropped attachment needs the same explanation as a redacted line —
      // an image that silently fails to send reads as a broken app, and the
      // sender never learns why [F-028-02].
      ...(guarded.redacted || mediaBlocked
        ? { warning: SECRET_REDACTED_WARNING }
        : offPlatform ? { warning: OFF_PLATFORM_WARNING } : {}),
    };
  });

  // Get messages
  app.get('/rooms/:roomId/messages', { preHandler: [app.authenticate] }, async (request) => {
    const { roomId } = request.params as { roomId: string };
    const { before, limit } = messagesQuerySchema.parse(request.query);

    // [R048-004] reading is bound to the order's CURRENT people too — a reassigned rider does not keep the transcript
    const access = await assertRoomAccess(app.prisma, roomId, request.user.userId, { tenantId: request.tenantId });

    const messages = await app.prisma.chatMessage.findMany({
      where: {
        chatRoomId: roomId,
        ...(before && { createdAt: { lt: before } }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Mark as read
    await app.prisma.chatRoomParticipant.updateMany({
      where: { chatRoomId: roomId, userId: request.user.userId },
      data: { lastReadAt: new Date() },
    });

    // [F-028-02] Rows written BEFORE the guard existed — or before it learned a
    // vector — still hold the live code, and history is a disclosure channel
    // like any other: the driver just scrolls up. Re-redact on the way out, so
    // closing a hole closes it for the whole conversation and not only for
    // messages sent from now on. Stored rows are deliberately left alone: an
    // evidence trail that quietly rewrites itself is worse than one that
    // carries a secret nobody can act on once the code has been used.
    // [R048-004] ...through the ONE serializer: legacy raw text re-scrubbed, legacy raw media hidden.
    const visible = await serializeChatMessages(messages, access, 'history');
    return { success: true, data: visible.reverse() };
  });

  // Mark room as read
  app.put('/rooms/:roomId/read', { preHandler: [app.authenticate] }, async (request) => {
    const { roomId } = request.params as { roomId: string };
    await assertRoomAccess(app.prisma, roomId, request.user.userId, { tenantId: request.tenantId });
    await app.prisma.chatRoomParticipant.updateMany({
      where: { chatRoomId: roomId, userId: request.user.userId },
      data: { lastReadAt: new Date() },
    });
    return { success: true };
  });

  // Get user's active chat rooms
  app.get('/rooms', { preHandler: [app.authenticate] }, async (request) => {
    // Surfaces are role-scoped: the shopping app lists the rooms you're in AS
    // the customer; a mover's job chats live in the driver app (?as=rider).
    const { as, page, limit } = z
      .object({
        as: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);
    const roleFilter = as === 'customer' || as === 'rider' ? { role: as } : {};

    // UG-CRAFT-02: bounded — a long-lived account accumulates rooms without
    // limit. The response shape stays a plain array (existing clients read it
    // directly), newest first, with opt-in page/limit for deeper history.
    const rooms = await app.prisma.chatRoom.findMany({
      where: {
        isActive: true,
        participants: { some: { userId: request.user.userId, ...roleFilter } },
      },
      include: {
        participants: { include: { user: { select: { id: true, firstName: true, avatar: true } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    // [R048-004] The participant rows are the index; the ORDER is the authority. A room the caller
    // is no longer part of is dropped (and its cache reconciled); the preview leaves through the
    // serializer — never a stored row raw.
    const listed: Array<Record<string, unknown>> = [];
    for (const r of rooms) {
      const authority = await resolveRoomAuthority(app.prisma, r.id);
      if (!authority || !authority.participants.has(request.user.userId) || (request.tenantId && authority.tenantId !== request.tenantId)) {
        chatGuardCounter.labels('list', 'stale_participant_refused').inc();
        if (authority) await reconcileParticipants(app.prisma, authority).catch(() => undefined);
        continue;
      }
      const last = r.messages[0];
      listed.push({
        id: r.id,
        orderId: r.orderId,
        participants: r.participants.map((p) => ({
          userId: p.user.id,
          name: p.user.firstName,
          avatar: p.user.avatar,
          role: p.role,
        })),
        lastMessage: last ? await serializeChatMessage(last, authority, 'list') : null,
      });
    }
    return { success: true, data: listed };
  });
}
