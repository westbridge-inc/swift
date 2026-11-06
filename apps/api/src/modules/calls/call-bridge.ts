import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { isTerminalOrderStatus } from '../order/order-status';
import { publishedStorePhone } from '../../utils/vendor-public-phone';
import type { CallProvider, CallStep, ProviderWebhook } from '../../providers/voice/call-provider';
import { CALL_RING_SECONDS, CALL_TIME_LIMIT_SECONDS, type CallRelayConfig } from './call-relay-switch';
import { dialableNumber } from '../../providers/voice/dialable';
import { hashSignal, normalizePhone as phoneDigits } from '../integrity/normalize';
import type { NotificationAudience, NotificationPayload } from '../notification/notification.service';

// ---------------------------------------------------------------------------
// [O-1 · owner 22-24 Oct 2026] THE SWIFT CALL BRIDGE.
//
// A party to a live order taps "Call via Swift". Swift rings THEM first (leg 1)
// from Swift's own number; only when they press 1 does Swift ring the other
// party (leg 2), who hears "Swift call about your order. Press 1 to connect."
// (a parcel recipient: "about a delivery for you") and is connected only on
// their own 1. Neither side ever learns the other's
// number: both are read from the order's rows at the moment each leg is
// dialled and handed only to the voice provider; a call_sessions row never
// holds one.
//
// Owner rulings built in, each tested:
// - Press 1 on BOTH legs (24 Oct: on some Guyana routes the network itself
//   "answers" in 0.35 s and the phone never rings). A leg the provider calls
//   answered is not a person: CONNECTED only on the called party's own 1.
// - Swift pays: a time limit on every call (CALL_RELAY_MAX_CALL_MINUTES, default
//   10 minutes, owner 6 Nov; never more than 30, owner 22 Oct) and a per-order cap on
//   ATTEMPTS (connected or not), CALL_RELAY_MAX_ATTEMPTS_PER_ORDER. One live
//   call per order (a database rule, so two taps start one call).
// - [CALL-RELAY-ON · 6 Nov] And daily caps, counted under one lock so two
//   starts can never both take the last slot: each person's own
//   CALL_RELAY_MAX_CALLS_PER_USER_PER_DAY (default 10) first, then the shared
//   CALL_RELAY_MAX_CALLS_PER_DAY over every order (default 100), in any 24 hours.
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
  // [REVIEW-F S4-1] The parcel recipient did not place the order: a delivery for them is what is true.
  recipientPrompt: 'Swift call about a delivery for you. Press 1 to connect.',
  noKey: 'No key was pressed. Goodbye.',
  connecting: 'Connecting you now.',
  notReached: "We couldn't reach them. Try again, or message them in chat.",
  // [REVIEW-F #2133 S4-1] The parcel recipient has no Swift account or chat; the rider can message the sender.
  recipientNotReached: "We couldn't reach the recipient. Try again, or message the sender in chat.",
} as const;

/** A call that has been live this long is over, whatever the provider last said:
 *  the ring on both legs plus the longest limit the setting allows (30 minutes), with a minute to spare. */
export const CALL_STALE_AFTER_MS = (CALL_TIME_LIMIT_SECONDS + 2 * CALL_RING_SECONDS + 60) * 1000;

/**
 * [REVIEW-M17 S2-1] The day's calls, also kept OUTSIDE the call rows. Account erasure deletes a person's call rows
 * (the Privacy Policy says so), which on its own would give their calls back to the day. So every start is also
 * written to two self-expiring lists (25 hours) that erasure never touches:
 * - the whole service's day (call ids and times, nothing about a person);
 * - the caller's PHONE (a keyed hash, hashSignal; never the number), so a delete and a new sign-up with the same
 *   SIM starts no fresh day.
 * Each cap counts the larger of the rows and its list.
 */
export interface CallerDayLedger {
  count(key: string, sinceMs: number): Promise<number>;
  add(key: string, member: string, atMs: number): Promise<void>;
  remove(key: string, member: string): Promise<void>;
}
export const CALL_DAY_PREFIX = 'swift:call-day:';
export const SERVICE_DAY_KEY = `${CALL_DAY_PREFIX}all`;
export const callerDayKey = (phone: string): string => `${CALL_DAY_PREFIX}phone:${hashSignal(phoneDigits(phone))}`;

/** [CALL-RELAY-ON] The one lock every start takes before it counts the day's calls. */
export const CALL_DAILY_CAP_LOCK = 'swift:call-relay-daily-cap';
const DAY_MS = 86_400_000;

const CALL_ID = /^c[a-z0-9]{20,32}$/;
const TERMINAL_CALL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

type Notifier = { send(payload: NotificationPayload): Promise<string> };

export interface CallBridgeDeps {
  prisma: PrismaClient;
  provider: CallProvider;
  config: CallRelayConfig;
  notifications: Notifier;
  /** [REVIEW-M17 S2-1] Required to START a call (a start without it is refused); the webhooks do not use it. */
  ledger?: CallerDayLedger;
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
    // [REVIEW-M17 S1-1] Only a store that is ACTIVE has a number at all: a suspended, not-yet-approved or closed
    // store is never rung, by its published number or its typed account line.
    case 'store': return order.vendor?.status === 'ACTIVE' ? publishedStorePhone(order.vendor) ?? order.vendor.phone ?? null : null;
    case 'recipient': return order.orderType === 'COURIER' ? order.courierRecipientPhone ?? null : null;
  }
}

/** [REVIEW-M17 S1-1] The number Swift may actually ring for a party: numberFor, through the one dial guard
 *  (a complete Guyana line, never Swift's own caller ID). Null = nobody is rung. */
export function dialFor(order: PartyOrder, role: CallTarget, callerId: string): string | null {
  return dialableNumber(numberFor(order, role), callerId);
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
        // [REVIEW-F S4-2 · owner copy 22 Oct] "Your rider/customer/store is calling you through Swift".
        : `${about.charAt(0).toUpperCase()}${about.slice(1)} is calling you through Swift about your order ${order.orderNumber}. Answer, then press 1 to connect.`,
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
  // [REVIEW-M17 S1-1] Both legs through the one dial guard: Swift rings only complete Guyana lines.
  const callerNumber = dialableNumber(caller?.phone, deps.config.callerId);
  if (!callerNumber || !dialFor(order, input.target, deps.config.callerId)) {
    throw new AppError(409, 'CALL_NO_NUMBER', 'Swift has no number to call for this. Message them in chat, or ask support.');
  }
  const ledger = deps.ledger;
  if (!ledger) throw new AppError(503, 'CALL_PROVIDER_FAILED', 'Swift could not place the call right now. Try again, or message them in chat.');
  const dayKey = callerDayKey(callerNumber);
  const ledgerDown = () => new AppError(503, 'CALL_PROVIDER_FAILED', 'Swift could not place the call right now. Try again, or message them in chat.');

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
      // [CALL-RELAY-ON] The daily caps: one lock (taken after the order row, in the same order by every start), then
      // the calls started in the last 24 hours, connected or not. A start the provider refused (FAILED: nothing was
      // dialled or paid) uses no daily slot. [security review] The person's own cap first, so no one person can use
      // up the shared day and block everyone else; then the shared cap.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CALL_DAILY_CAP_LOCK}))`;
      // [REVIEW-M17 S3-1] One live call per PERSON: their own call on another order that is still live refuses this
      // one (a call the provider never reported finished stops counting once it is stale, like the order's slot).
      await tx.callSession.updateMany({
        where: { callerUserId: input.userId, endedAt: null, createdAt: { lt: stale }, status: CALL_STATUS.CONNECTED },
        data: { endedAt: now },
      });
      await tx.callSession.updateMany({
        where: { callerUserId: input.userId, endedAt: null, createdAt: { lt: stale } },
        data: { endedAt: now, status: CALL_STATUS.NOT_CONNECTED },
      });
      const myLive = await tx.callSession.count({ where: { callerUserId: input.userId, endedAt: null } });
      if (myLive > 0) {
        throw new AppError(409, 'CALL_CALLER_BUSY', 'You already have a Swift call ringing. Answer it, or try again in a minute.');
      }
      const inWindow = { createdAt: { gte: new Date(now.getTime() - DAY_MS) }, status: { not: CALL_STATUS.FAILED } };
      const since = now.getTime() - DAY_MS;
      // [REVIEW-M17 S2-1] The person's day is the larger of their account's rows and their phone's list.
      const byAccount = await tx.callSession.count({ where: { ...inWindow, callerUserId: input.userId } });
      const byPhone = await ledger.count(dayKey, since).catch(() => { throw ledgerDown(); });
      const mine = Math.max(byAccount, byPhone);
      if (mine >= deps.config.maxCallsPerUserPerDay) {
        throw new AppError(429, 'CALL_USER_DAILY_LIMIT_REACHED', 'You have used your Swift calls for today. Message them in chat, or ask support.');
      }
      // [REVIEW-M17 S2-1] The service's day: the larger of the rows and the service list (erasure deletes rows).
      const today = Math.max(
        await tx.callSession.count({ where: inWindow }),
        await ledger.count(SERVICE_DAY_KEY, since).catch(() => { throw ledgerDown(); }),
      );
      if (today >= deps.config.maxCallsPerDay) {
        log().warn({ maxCallsPerDay: deps.config.maxCallsPerDay }, '[CALL-RELAY-ON] daily call cap reached: Call via Swift refused until a slot frees');
        throw new AppError(429, 'CALL_DAILY_LIMIT_REACHED', 'Swift calls are busy right now. Message them in chat, or ask support.');
      }
      const row = await tx.callSession.create({
        data: { orderId: order.id, callerUserId: input.userId, callerRole, calleeRole: input.target, provider: deps.provider.name },
        select: { id: true },
      });
      // Recorded under the same lock; a start that fails after this takes it back below.
      await ledger.add(dayKey, row.id, now.getTime()).catch(() => { throw ledgerDown(); });
      await ledger.add(SERVICE_DAY_KEY, row.id, now.getTime()).catch(() => { throw ledgerDown(); });
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
      to: callerNumber,
      callerId: deps.config.callerId,
      answerUrl: webhookUrl(deps.config, 'leg1', callId),
      statusUrl: webhookUrl(deps.config, 'status', callId),
      ringSeconds: CALL_RING_SECONDS,
      limitSeconds: deps.config.maxCallSeconds,
    });
    await deps.prisma.callSession.update({ where: { id: callId }, data: { providerCallId: placed.providerCallId } });
  } catch {
    await deps.prisma.callSession.update({ where: { id: callId }, data: { status: CALL_STATUS.FAILED, endedAt: deps.now?.() ?? new Date() } });
    // Nothing was dialled or paid: the start uses no daily slot (the row is FAILED; both lists forget it).
    await ledger.remove(dayKey, callId).catch(() => undefined);
    await ledger.remove(SERVICE_DAY_KEY, callId).catch(() => undefined);
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
  /** What the caller hears when the other side was not reached (the recipient has no chat: the sender's). */
  const notReachedWords = session.calleeRole === 'recipient' ? CALL_WORDS.recipientNotReached : CALL_WORDS.notReached;

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
      // [REVIEW-M17 S1-1] The same dial guard at the moment of dialling leg 2.
      const to = order && !isTerminalOrderStatus(order.status) ? dialFor(order, session.calleeRole as CallTarget, deps.config.callerId) : null;
      if (!order || !to) {
        await deps.prisma.callSession.updateMany({ where: { id: session.id, endedAt: null }, data: notConnected });
        return hangup(notReachedWords);
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
          limitSeconds: deps.config.maxCallSeconds,
        },
      };
    }
    case 'screen': {
      if (ended || session.status !== CALL_STATUS.CALLER_CONFIRMED) return hangup();
      const prompt = session.calleeRole === 'recipient' ? CALL_WORDS.recipientPrompt : CALL_WORDS.calleePrompt;
      return { step: { verb: 'confirm', prompt, next: webhookUrl(deps.config, 'screen-gather', session.id), noInput: CALL_WORDS.noKey } };
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
      return hangup(notReachedWords);
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
