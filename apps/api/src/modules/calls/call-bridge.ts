import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { isTerminalOrderStatus } from '../order/order-status';
import { publishedStorePhone } from '../../utils/vendor-public-phone';
import type { CallProvider, CallStep, ProviderWebhook } from '../../providers/voice/call-provider';
import { CALL_RING_SECONDS, CALL_TIME_LIMIT_SECONDS, type CallRelayConfig } from './call-relay-switch';
import type { NotificationAudience, NotificationPayload } from '../notification/notification.service';

// ---------------------------------------------------------------------------
// [O-1 · owner 22-24 Oct 2026] THE SWIFT CALL BRIDGE.
//
// A party to a live order taps "Call via Swift". Swift rings THEM first (leg 1)
// from Swift's own number; only when they press 1 does Swift ring the other
// party (leg 2), who hears "Swift call about your order. Press 1 to connect."
// and is connected only on their own 1. Neither side ever learns the other's
// number: both are read from the order's rows at the moment each leg is
// dialled and handed only to the voice provider; a call_sessions row never
// holds one.
//
// Owner rulings built in, each tested:
// - Press 1 on BOTH legs (24 Oct: on some Guyana routes the network itself
//   "answers" in 0.35 s and the phone never rings). A leg the provider calls
//   answered is not a person: CONNECTED only on the called party's own 1.
// - Swift pays: a hard 30-minute limit on every call and a per-order cap on
//   ATTEMPTS (connected or not), CALL_RELAY_MAX_ATTEMPTS_PER_ORDER. One live
//   call per order (a database rule, so two taps start one call).
// - The caller ID is Swift's number (CALL_RELAY_CALLER_ID), pinned on the
//   dial, never the number being called. Never recorded.
// - Just before each leg rings, that person gets a push: "Swift is calling
//   you about your order" with role words only (no names, no numbers).
// - Stores are in scope: a store's owner or staff can call the rider or the
//   customer of their store's live order, and be called by them.
// - Nothing here runs while CALL_RELAY is off (the routes refuse first).
// ---------------------------------------------------------------------------

export const CALL_TARGETS = ['customer', 'rider', 'driver', 'store', 'recipient'] as const;
export type CallTarget = (typeof CALL_TARGETS)[number];
export type CallerRole = Exclude<CallTarget, 'recipient'>;

export const CALL_STATUS = {
  DIALING_CALLER: 'DIALING_CALLER',
  CALLER_CONFIRMED: 'CALLER_CONFIRMED',
  CONNECTED: 'CONNECTED',
  NOT_CONNECTED: 'NOT_CONNECTED',
  FAILED: 'FAILED',
} as const;

/** The provider steps, in the order a call walks them. Each is a webhook path segment. */
export const CALL_STEPS = ['leg1', 'leg1-gather', 'screen', 'screen-gather', 'dial-done', 'status'] as const;
export type CallStepName = (typeof CALL_STEPS)[number];

/** What people HEAR (owner copy, 22 Oct; REVIEW-F). */
export const CALL_WORDS = {
  callerPrompt: 'Swift is connecting your call about your order. Press 1 to continue.',
  calleePrompt: 'Swift call about your order. Press 1 to connect.',
  noKey: 'No key was pressed. Goodbye.',
  connecting: 'Connecting you now.',
  notReached: "We couldn't reach them. Try again, or message them in chat.",
} as const;

/** A call that has been live this long is over, whatever the provider last said:
 *  the ring on both legs plus the 30-minute limit, with a minute to spare. */
export const CALL_STALE_AFTER_MS = (CALL_TIME_LIMIT_SECONDS + 2 * CALL_RING_SECONDS + 60) * 1000;

const CALL_ID = /^c[a-z0-9]{20,32}$/;
const TERMINAL_CALL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

type Notifier = { send(payload: NotificationPayload): Promise<string> };

export interface CallBridgeDeps {
  prisma: PrismaClient;
  provider: CallProvider;
  config: CallRelayConfig;
  notifications: Notifier;
  now?: () => Date;
}

const ORDER_PARTIES = {
  id: true,
  orderNumber: true,
  orderType: true,
  status: true,
  customerId: true,
  courierRecipientPhone: true,
  customer: { select: { id: true, phone: true } },
  rider: { select: { userId: true, user: { select: { phone: true } } } },
  driver: { select: { userId: true, user: { select: { phone: true } } } },
  vendor: { select: { id: true, status: true, phone: true, publicPhone: true, owner: { select: { userId: true } } } },
} as const;
type PartyOrder = Prisma.OrderGetPayload<{ select: typeof ORDER_PARTIES }>;

const AUDIENCE: Record<CallerRole, NotificationAudience> = { customer: 'customer', rider: 'earner', driver: 'earner', store: 'business' };

/** "your rider", "the store" ... as the OTHER person on this order is to the listener. Role words only. */
export function roleWords(role: CallTarget, orderType: string): string {
  switch (role) {
    case 'customer': return orderType === 'TAXI' ? 'your passenger' : 'your customer';
    case 'rider': return 'your rider';
    case 'driver': return 'your driver';
    case 'store': return 'the store';
    case 'recipient': return 'the parcel recipient';
  }
}

async function isStoreStaff(prisma: PrismaClient, order: PartyOrder, userId: string): Promise<boolean> {
  if (!order.vendor) return false;
  if (order.vendor.owner?.userId === userId) return true;
  const seat = await prisma.vendorStaff.findFirst({ where: { vendorId: order.vendor.id, userId }, select: { id: true } });
  return !!seat;
}

/** Everything `userId` is on this order (one person can be, say, the customer and a store's staff). */
async function callerRolesOn(prisma: PrismaClient, order: PartyOrder, userId: string): Promise<CallerRole[]> {
  const roles: CallerRole[] = [];
  if (order.rider?.userId === userId) roles.push('rider');
  if (order.driver?.userId === userId) roles.push('driver');
  if (await isStoreStaff(prisma, order, userId)) roles.push('store');
  if (order.customerId === userId) roles.push('customer');
  return roles;
}

/** May a `caller` on this order ask Swift to call `target`? (Who exists on the order is checked separately.) */
export function pairAllowed(caller: CallerRole, target: CallTarget, orderType: string): boolean {
  if (caller === target) return false;
  if (target === 'recipient') return caller === 'rider' && orderType === 'COURIER';
  if (orderType === 'TAXI') return (caller === 'customer' && target === 'driver') || (caller === 'driver' && target === 'customer');
  if (caller === 'driver' || target === 'driver') return false;
  return true; // customer, rider and store reach each other on a store or courier order
}

/** The number Swift dials for a party, read from the order's own rows. Null when there is none. */
export function numberFor(order: PartyOrder, role: CallTarget): string | null {
  switch (role) {
    case 'customer': return order.customer?.phone ?? null;
    case 'rider': return order.rider?.user?.phone ?? null;
    case 'driver': return order.driver?.user?.phone ?? null;
    case 'store': return order.vendor ? publishedStorePhone(order.vendor) ?? order.vendor.phone ?? null : null;
    case 'recipient': return order.orderType === 'COURIER' ? order.courierRecipientPhone ?? null : null;
  }
}

/** The account behind a party being called, to tell them the call is coming. None for the parcel recipient. */
function peopleFor(order: PartyOrder, role: CallTarget): string[] {
  switch (role) {
    case 'customer': return order.customerId ? [order.customerId] : [];
    case 'rider': return order.rider?.userId ? [order.rider.userId] : [];
    case 'driver': return order.driver?.userId ? [order.driver.userId] : [];
    case 'store': {
      if (!order.vendor) return [];
      // The owner: the store's account line is the owner's, and staff each have their own phone.
      return order.vendor.owner?.userId ? [order.vendor.owner.userId] : [];
    }
    case 'recipient': return [];
  }
}

const webhookUrl = (config: CallRelayConfig, step: CallStepName, callId: string) =>
  `${config.webhookBase}/${step}?s=${encodeURIComponent(callId)}`;

async function loadOrder(prisma: PrismaClient, orderId: string): Promise<PartyOrder | null> {
  return prisma.order.findUnique({ where: { id: orderId }, select: ORDER_PARTIES });
}

/**
 * "Swift is calling you about your order" — just before a person's phone rings. Best effort (send never throws).
 * Leg 1 tells the person who tapped Call (their own phone rings first); leg 2 tells the account behind the
 * party being called. The parcel recipient has no account here and gets no push.
 */
async function warnOfCall(
  deps: CallBridgeDeps,
  order: PartyOrder,
  listeners: string[],
  listenerRole: CallTarget,
  otherRole: CallTarget,
  callId: string,
  leg: 1 | 2,
): Promise<void> {
  if (listenerRole === 'recipient') return;
  const audience = AUDIENCE[listenerRole];
  const about = roleWords(otherRole, order.orderType);
  for (const userId of listeners) {
    await deps.notifications.send({
      userId,
      type: 'ORDER_UPDATE',
      audience,
      title: 'Swift is calling you',
      body: leg === 1
        ? `Swift is calling you now about your order ${order.orderNumber}, to connect you with ${about}. Answer, then press 1.`
        : `Swift is calling you about your order ${order.orderNumber}: ${about}. Answer, then press 1 to connect.`,
      // callOrderId, never orderId: an older app opens itself, not a screen that cannot show this order.
      data: { kind: 'call_incoming', callOrderId: order.id, orderType: order.orderType, from: otherRole, leg },
      dedupeKey: `call:${callId}:${leg}`,
    });
  }
}

export interface StartCallInput {
  orderId: string;
  userId: string;
  target: CallTarget;
}

/**
 * Start a bridged call: check the party, the order, the cap; record the attempt;
 * warn the caller; ring the caller. Never returns or logs a number.
 */
export async function startBridgeCall(deps: CallBridgeDeps, input: StartCallInput): Promise<{ callId: string; status: string }> {
  const now = deps.now?.() ?? new Date();
  const order = await loadOrder(deps.prisma, input.orderId);
  // Not a party is answered exactly like no order: no oracle.
  const roles = order ? await callerRolesOn(deps.prisma, order, input.userId) : [];
  if (!order || roles.length === 0) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  if (isTerminalOrderStatus(order.status)) {
    throw new AppError(409, 'CALL_ORDER_NOT_LIVE', 'This order is finished, so Swift can no longer connect a call. Message them in chat or ask support.');
  }
  const callerRole = roles.find((r) => pairAllowed(r, input.target, order.orderType));
  if (!callerRole) {
    throw new AppError(400, 'CALL_TARGET_INVALID', 'Swift cannot connect that call on this order.');
  }
  const caller = await deps.prisma.user.findUnique({ where: { id: input.userId }, select: { phone: true } });
  if (!caller?.phone || !numberFor(order, input.target)) {
    throw new AppError(409, 'CALL_NO_NUMBER', 'Swift has no number to call for this. Message them in chat, or ask support.');
  }

  let callId: string;
  try {
    callId = await deps.prisma.$transaction(async (tx) => {
      // [REVIEW-M S4-2] One start at a time per order: the count below and the insert see the same rows,
      // so the attempt cap is exact even when a first attempt failed at once and two taps race.
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${order.id} FOR UPDATE`;
      // A call the provider never reported finished cannot hold the order's one live slot for ever.
      const stale = new Date(now.getTime() - CALL_STALE_AFTER_MS);
      await tx.callSession.updateMany({
        where: { orderId: order.id, endedAt: null, createdAt: { lt: stale }, status: CALL_STATUS.CONNECTED },
        data: { endedAt: now },
      });
      await tx.callSession.updateMany({
        where: { orderId: order.id, endedAt: null, createdAt: { lt: stale } },
        data: { endedAt: now, status: CALL_STATUS.NOT_CONNECTED },
      });
      const attempts = await tx.callSession.count({ where: { orderId: order.id } });
      if (attempts >= deps.config.maxAttemptsPerOrder) {
        throw new AppError(429, 'CALL_LIMIT_REACHED', 'Swift has connected as many calls as it can for this order. Message them in chat, or ask support.');
      }
      const row = await tx.callSession.create({
        data: { orderId: order.id, callerUserId: input.userId, callerRole, calleeRole: input.target, provider: deps.provider.name },
        select: { id: true },
      });
      return row.id;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, 'CALL_IN_PROGRESS', 'A Swift call on this order is already ringing. Answer it, or try again in a minute.');
    }
    throw err;
  }

  await warnOfCall(deps, order, [input.userId], callerRole, input.target, callId, 1);
  try {
    const placed = await deps.provider.placeCall({
      to: caller.phone,
      callerId: deps.config.callerId,
      answerUrl: webhookUrl(deps.config, 'leg1', callId),
      statusUrl: webhookUrl(deps.config, 'status', callId),
      ringSeconds: CALL_RING_SECONDS,
      limitSeconds: CALL_TIME_LIMIT_SECONDS,
    });
    await deps.prisma.callSession.update({ where: { id: callId }, data: { providerCallId: placed.providerCallId } });
  } catch {
    await deps.prisma.callSession.update({ where: { id: callId }, data: { status: CALL_STATUS.FAILED, endedAt: deps.now?.() ?? new Date() } });
    throw new AppError(502, 'CALL_PROVIDER_FAILED', 'Swift could not place the call right now. Try again, or message them in chat.');
  }
  return { callId, status: CALL_STATUS.DIALING_CALLER };
}

export interface VoiceStepResult {
  /** The document to answer the provider with; null = an empty acknowledgement (status callbacks). */
  step: CallStep | null;
}

const hangup = (say?: string): VoiceStepResult => ({ step: say ? { verb: 'hangup', say } : { verb: 'hangup' } });

/**
 * One provider webhook. The caller of this has ALREADY verified the provider's
 * signature over the exact URL. Unknown or finished sessions just hang up.
 */
export async function handleVoiceStep(
  deps: CallBridgeDeps,
  step: CallStepName,
  callId: string,
  hook: Pick<ProviderWebhook, 'fields'>,
  relayOn: boolean,
): Promise<VoiceStepResult> {
  const now = deps.now?.() ?? new Date();
  const event = deps.provider.read(hook.fields);
  const session = CALL_ID.test(callId)
    ? await deps.prisma.callSession.findUnique({ where: { id: callId } })
    : null;
  if (!session) return step === 'status' ? { step: null } : hangup();
  const ended = session.endedAt !== null;
  const notConnected = { status: CALL_STATUS.NOT_CONNECTED, endedAt: now, durationSeconds: 0 };

  switch (step) {
    case 'leg1': {
      if (ended || session.status !== CALL_STATUS.DIALING_CALLER || !relayOn) return hangup();
      return { step: { verb: 'confirm', prompt: CALL_WORDS.callerPrompt, next: webhookUrl(deps.config, 'leg1-gather', session.id), noInput: CALL_WORDS.noKey } };
    }
    case 'leg1-gather': {
      if (ended || session.status !== CALL_STATUS.DIALING_CALLER) return hangup();
      if (event.digits !== '1' || !relayOn) {
        await deps.prisma.callSession.updateMany({ where: { id: session.id, endedAt: null }, data: notConnected });
        return hangup(CALL_WORDS.noKey);
      }
      // Re-read at the moment of dialling: the order may have finished, the party changed, a number gone.
      const order = await loadOrder(deps.prisma, session.orderId);
      const to = order && !isTerminalOrderStatus(order.status) ? numberFor(order, session.calleeRole as CallTarget) : null;
      if (!order || !to) {
        await deps.prisma.callSession.updateMany({ where: { id: session.id, endedAt: null }, data: notConnected });
        return hangup(CALL_WORDS.notReached);
      }
      const moved = await deps.prisma.callSession.updateMany({
        where: { id: session.id, status: CALL_STATUS.DIALING_CALLER, endedAt: null },
        data: { status: CALL_STATUS.CALLER_CONFIRMED, callerConfirmedAt: now },
      });
      if (moved.count !== 1) return hangup();
      const callee = session.calleeRole as CallTarget;
      await warnOfCall(deps, order, peopleFor(order, callee), callee, session.callerRole as CallTarget, session.id, 2);
      return {
        step: {
          verb: 'dial',
          say: CALL_WORDS.connecting,
          to,
          callerId: deps.config.callerId,
          screen: webhookUrl(deps.config, 'screen', session.id),
          done: webhookUrl(deps.config, 'dial-done', session.id),
          ringSeconds: CALL_RING_SECONDS,
          limitSeconds: CALL_TIME_LIMIT_SECONDS,
        },
      };
    }
    case 'screen': {
      if (ended || session.status !== CALL_STATUS.CALLER_CONFIRMED) return hangup();
      return { step: { verb: 'confirm', prompt: CALL_WORDS.calleePrompt, next: webhookUrl(deps.config, 'screen-gather', session.id), noInput: CALL_WORDS.noKey } };
    }
    case 'screen-gather': {
      if (ended || session.status !== CALL_STATUS.CALLER_CONFIRMED || event.digits !== '1') return hangup();
      const moved = await deps.prisma.callSession.updateMany({
        where: { id: session.id, status: CALL_STATUS.CALLER_CONFIRMED, endedAt: null },
        data: { status: CALL_STATUS.CONNECTED, connectedAt: now },
      });
      return moved.count === 1 ? { step: { verb: 'connect' } } : hangup();
    }
    case 'dial-done': {
      if (session.status === CALL_STATUS.CONNECTED) {
        await deps.prisma.callSession.updateMany({
          where: { id: session.id, endedAt: null },
          data: { endedAt: now, durationSeconds: event.durationSeconds ?? 0 },
        });
        return hangup();
      }
      await deps.prisma.callSession.updateMany({ where: { id: session.id, endedAt: null }, data: notConnected });
      return hangup(CALL_WORDS.notReached);
    }
    case 'status': {
      if (!ended && event.callStatus && TERMINAL_CALL_STATUSES.has(event.callStatus)) {
        // The status is in each WHERE (REVIEW-M S4-3): a callee's 1 that lands while this runs is never
        // overwritten as NOT_CONNECTED; a connected call is only ended.
        await deps.prisma.callSession.updateMany({
          where: { id: session.id, endedAt: null, status: { not: CALL_STATUS.CONNECTED } },
          data: notConnected,
        });
        await deps.prisma.callSession.updateMany({
          where: { id: session.id, endedAt: null, status: CALL_STATUS.CONNECTED },
          data: { endedAt: now },
        });
      }
      return { step: null };
    }
  }
}
