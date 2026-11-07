import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { isTerminalOrderStatus, TERMINAL_ORDER_STATUSES } from '../order/order-status';
import type { CallProvider, CallStep } from '../../providers/voice/call-provider';
import { CALL_RING_SECONDS, type CallRelayConfig } from './call-relay-switch';
import {
  CALL_DAILY_CAP_LOCK,
  CALL_STALE_AFTER_MS,
  CALL_STATUS,
  CALL_WORDS,
  PARTNER_ROLES,
  callerRolesOn,
  dialFor,
  loadOrder,
  pairAllowed,
  roleWords,
  warnOfCall,
  webhookUrl,
  withinLedgerWait,
  type CallerRole,
  type CallTarget,
  type PartyOrder,
  type ServiceDayLedger,
} from './call-bridge';
import {
  INAPP_MAX_CLIENTS,
  INAPP_RING_SECONDS,
  INAPP_TOKEN_TTL_SECONDS,
  INAPP_UNTAKEN_AFTER_MS,
  inAppIdentity,
  mintVoiceAccessToken,
  type InAppCallsConfig,
  type InAppPlatform,
} from './inapp-calls-switch';
import type { NotificationPayload } from '../notification/notification.service';

// ---------------------------------------------------------------------------
// [INAPP-CALLS · owner 6 Nov 2026, "B"] IN-APP CALLING.
//
// The caller's phone asks Swift to start a call on a live order (the same
// party, pair, live-order and per-order attempt rules as the phone bridge, and
// the same call_sessions row with no number in it). Swift answers with a short
// Twilio access token; the phone connects to Swift's TwiML App with the call's
// id; Twilio asks Swift what to do, and Swift rings the OTHER person's Swift
// app (their opaque client identity) with one line for their call screen:
// "Swift: your rider is calling about your order".
//
// Not answered in the app (old build, no data, no answer) and the phone bridge
// on: Swift rings their PHONE from Swift's number in the same call, with the
// bridge's own "Press 1" screen. Declined in the app: no phone call after it.
//
// Never: a phone number in a token, a parameter, a log or the row; a recording;
// a call to someone who is not on the order; a call while INAPP_CALLS is off.
// ---------------------------------------------------------------------------

/** The in-app row's states, beside the bridge's (status is a text column; no schema change). */
export const INAPP_STATUS = {
  /** Started by the caller's phone; ringing (or about to ring) the other app. */
  RINGING_APP: 'RINGING_APP',
} as const;

export const INAPP_PROVIDER = 'twilio-app';

/** The provider steps of an in-app call (webhook path segments under /calls/voice). */
export const INAPP_STEPS = ['app', 'app-answered', 'app-dial-done', 'app-status'] as const;
export type InAppStepName = (typeof INAPP_STEPS)[number];

/** What people read and hear (plain words; role words only). */
export const INAPP_WORDS = {
  notReached: CALL_WORDS.notReached,
  tryingPhone: 'They are not answering in the app. Swift is calling their phone now.',
} as const;

/** The one line the other person's call screen shows. Role words only: never a name, never a number. */
export function callScreenLine(callerRole: CallerRole, orderType: string): string {
  return `Swift: ${roleWords(callerRole, orderType)} is calling about your order`;
}

const CALL_ID = /^c[a-z0-9]{20,32}$/;
const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
const TERMINAL_CALL_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
/** Dial outcomes after which the person is tried on their phone: never reached in the app. Not "busy" (they declined). */
const FALLBACK_DIAL_STATUSES = new Set(['no-answer', 'failed']);

type Notifier = { send(payload: NotificationPayload): Promise<string> };

export interface InAppDeps {
  prisma: PrismaClient;
  config: InAppCallsConfig;
  /** The phone bridge's settings and provider while CALL_RELAY is on (the fallback); null while it is off. */
  relay: { config: CallRelayConfig; provider: CallProvider } | null;
  notifications: Notifier;
  /** [owner 6 Nov · REVIEW-M17 S2-1] The bridge's service day list: required to START a call (refused without it). */
  ledger?: ServiceDayLedger;
  /** [REVIEW-G23 S3-2] Tells the platform operators the shared daily cap tripped (best effort, once a day). */
  alertDailyCap?: (maxCallsPerDay: number) => Promise<void>;
  /** [native review S2] Which phones said they can be rung in the app (registered with the microphone granted).
   *  Missing or failing: nobody counts as registered, so the call goes to the phone bridge. */
  registry?: InAppRegistry;
  now?: () => Date;
}

/**
 * [native review S2 · server review 8] The phones that registered to be rung in the app: identity -> when.
 * A phone asks for a register token only once the microphone is granted (Android 11+ silently drops a ring
 * without it), and asks for an unregister token when it is not, or at sign-out. Kept outside the database
 * (identities and times only, self-expiring): a signed-out phone's identity is dead anyway (per session).
 */
export interface InAppRegistry {
  mark(identity: string, atMs: number): Promise<void>;
  clear(identity: string): Promise<void>;
  /** When each identity last registered, or null (same order as asked). */
  registeredAt(identities: string[]): Promise<Array<number | null>>;
}

const DAY_MS = 86_400_000;

const first = (fields: Record<string, string[]>, name: string) => fields[name]?.[0] ?? null;

/** The Swift accounts behind a party, for ringing their app. A store rings its owner and staff seats together. */
export async function appPeopleFor(prisma: PrismaClient, order: PartyOrder, role: CallTarget): Promise<string[]> {
  switch (role) {
    case 'customer': return order.customerId ? [order.customerId] : [];
    case 'rider': return order.rider?.userId ? [order.rider.userId] : [];
    case 'driver': return order.driver?.userId ? [order.driver.userId] : [];
    case 'store': {
      if (!order.vendor) return [];
      const seats = await prisma.vendorStaff.findMany({ where: { vendorId: order.vendor.id }, select: { userId: true }, orderBy: { createdAt: 'asc' }, take: INAPP_MAX_CLIENTS });
      const ids = [order.vendor.owner?.userId, ...seats.map((s) => s.userId)].filter((x): x is string => !!x);
      return [...new Set(ids)].slice(0, INAPP_MAX_CLIENTS);
    }
    case 'recipient': return [];
  }
}

/** Is this person on at least one live order (customer, rider, driver, store owner or staff)? */
export async function onALiveOrder(prisma: PrismaClient, userId: string): Promise<boolean> {
  const live = { status: { notIn: TERMINAL_ORDER_STATUSES } };
  const found = await prisma.order.findFirst({
    where: {
      ...live,
      OR: [
        { customerId: userId },
        { rider: { userId } },
        { driver: { userId } },
        { vendor: { owner: { userId } } },
        { vendor: { staff: { some: { userId } } } },
      ],
    },
    select: { id: true },
  });
  return !!found;
}

/**
 * [SECURITY REVIEW, MEDIUM] The identity of the session making THIS request, and only it: the session must be
 * the caller's own and current. A token is never minted for any other identity (another session, a signed-out one).
 */
export async function sessionIdentity(prisma: PrismaClient, config: InAppCallsConfig, userId: string, sessionId: string | null | undefined, now: Date): Promise<string> {
  const refused = () => new AppError(401, 'INAPP_SESSION', 'Please sign in again to use in-app calls.');
  if (!sessionId) throw refused();
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true, deviceId: true, expiresAt: true } });
  if (!session || session.userId !== userId || session.expiresAt <= now) throw refused();
  return inAppIdentity(config.identitySecret, userId, sessionId, session.deviceId);
}

/** The most current sessions of one person read at once (a person rarely has more than a few). */
const SESSIONS_READ = 50;

/**
 * Every identity of these people's CURRENT sessions (signed in, not expired), newest session first.
 * A signed-out phone has no session, so its identity is never here.
 */
export async function currentIdentities(prisma: PrismaClient, config: InAppCallsConfig, userIds: string[], now: Date): Promise<string[]> {
  if (userIds.length === 0) return [];
  const sessions = await prisma.session.findMany({
    where: { userId: { in: userIds }, expiresAt: { gt: now } },
    select: { id: true, userId: true, deviceId: true },
    orderBy: { createdAt: 'desc' },
    take: SESSIONS_READ * userIds.length,
  });
  return [...new Set(sessions.map((s) => inAppIdentity(config.identitySecret, s.userId, s.id, s.deviceId)))];
}

/**
 * [native review S2 · server review 8] The identities to RING: current sessions whose phone registered to be
 * rung in the app (so web and never-registered sessions never take a slot), most recently registered first,
 * at most INAPP_MAX_CLIENTS. No registry, or it fails: none (the phone bridge takes the call).
 */
export async function ringableIdentities(deps: Pick<InAppDeps, 'prisma' | 'config' | 'registry'>, userIds: string[], now: Date): Promise<string[]> {
  const identities = await currentIdentities(deps.prisma, deps.config, userIds, now);
  if (identities.length === 0 || !deps.registry) return [];
  const at = await deps.registry.registeredAt(identities).catch(() => identities.map(() => null));
  return identities
    .map((identity, i) => ({ identity, at: at[i] ?? null }))
    .filter((x): x is { identity: string; at: number } => typeof x.at === 'number')
    .sort((a, b) => b.at - a.at)
    .slice(0, INAPP_MAX_CLIENTS)
    .map((x) => x.identity);
}

/** [server review 6] Only the connect token may place a call: register / unregister tokens carry no outgoing grant. */
function tokenFor(config: InAppCallsConfig, identity: string, platform: InAppPlatform, now: Date, canCall: boolean): { token: string; identity: string; ttlSeconds: number } {
  const token = mintVoiceAccessToken({
    accountSid: config.twilio.accountSid,
    apiKeySid: config.twilio.apiKeySid,
    apiKeySecret: config.twilio.apiKeySecret,
    identity,
    twimlAppSid: canCall ? config.twimlAppSid : null,
    pushCredentialSid: config.pushCredential[platform],
    ttlSeconds: INAPP_TOKEN_TTL_SECONDS,
    now,
  });
  return { token, identity, ttlSeconds: INAPP_TOKEN_TTL_SECONDS };
}

/**
 * A token for THIS session's identity only.
 * - `register`: so this phone can be rung in the app. Only for a person on a live order (anyone else has no
 *   one to be called by).
 * - `unregister`: the app's sign-out / account switch removes this phone's binding before the session ends.
 *   No live order needed: it can only ever name the session asking.
 */
export async function issueSessionToken(
  deps: InAppDeps,
  input: { userId: string; sessionId: string | null | undefined; platform: InAppPlatform; purpose: 'register' | 'unregister' },
): Promise<{ token: string; identity: string; ttlSeconds: number }> {
  const now = deps.now?.() ?? new Date();
  const identity = await sessionIdentity(deps.prisma, deps.config, input.userId, input.sessionId, now);
  if (input.purpose === 'register' && !(await onALiveOrder(deps.prisma, input.userId))) {
    throw new AppError(403, 'INAPP_NO_LIVE_ORDER', 'In-app calls are for the people on a live order.');
  }
  // [native review S2] The phone asks to register only with the microphone granted; until it does (or after
  // it unregisters) Swift rings its phone through the bridge instead. Best effort: a registry failure only
  // means the bridge takes their calls.
  if (deps.registry) {
    await (input.purpose === 'register' ? deps.registry.mark(identity, now.getTime()) : deps.registry.clear(identity)).catch(() => undefined);
  }
  return tokenFor(deps.config, identity, input.platform, now, false);
}

export interface StartInAppInput {
  orderId: string;
  userId: string;
  /** The caller's own session: the connect token names this session's identity and no other. */
  sessionId: string | null | undefined;
  target: CallTarget;
  platform: InAppPlatform;
}

/**
 * Start an in-app call: the bridge's checks (party, live order, pair, cap, one live call per order),
 * then a row (no number) and a token for the caller's phone to connect with.
 */
export async function startInAppCall(deps: InAppDeps, input: StartInAppInput): Promise<{ callId: string; token: string; ttlSeconds: number }> {
  const now = deps.now?.() ?? new Date();
  const callerIdentity = await sessionIdentity(deps.prisma, deps.config, input.userId, input.sessionId, now);
  const order = await loadOrder(deps.prisma, input.orderId);
  // Not a party is answered exactly like no order: no oracle.
  const roles = order ? await callerRolesOn(deps.prisma, order, input.userId) : [];
  if (!order || roles.length === 0) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  if (isTerminalOrderStatus(order.status)) {
    throw new AppError(409, 'CALL_ORDER_NOT_LIVE', 'This order is finished, so Swift can no longer connect a call. Message them in chat or ask support.');
  }
  if (input.target === 'recipient') {
    // The parcel recipient has no Swift account: only the phone bridge can reach them.
    throw new AppError(400, 'INAPP_NOT_FOR_TARGET', 'The recipient does not have the Swift app. Use Call via Swift instead.');
  }
  const callerRole = roles.find((r) => pairAllowed(r, input.target, order.orderType));
  if (!callerRole) throw new AppError(400, 'CALL_TARGET_INVALID', 'Swift cannot connect that call on this order.');
  if ((await appPeopleFor(deps.prisma, order, input.target)).filter((id) => id !== input.userId).length === 0) {
    throw new AppError(409, 'INAPP_NO_ONE', 'There is no one to call in the app for this. Message them in chat, or ask support.');
  }
  const ledger = deps.ledger;
  const ledgerDown = () => new AppError(503, 'CALL_PROVIDER_FAILED', 'Swift could not place the call right now. Try again, or message them in chat.');
  if (!ledger) throw ledgerDown();
  // [owner 6 Nov] The person's daily cap by their role ON THIS ORDER, exactly as the bridge counts it.
  const asPartner = (PARTNER_ROLES as readonly string[]).includes(callerRole);
  const personCap = asPartner ? deps.config.maxCallsPerPartnerPerDay : deps.config.maxCallsPerCustomerPerDay;

  let callId: string;
  try {
    callId = await deps.prisma.$transaction(async (tx) => {
      // One start at a time per order (the bridge's rule): the count and the insert see the same rows.
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${order.id} FOR UPDATE`;
      // An in-app start Twilio never took (the phone could not connect) does not hold the order's one live slot.
      await tx.callSession.updateMany({
        where: { orderId: order.id, endedAt: null, status: INAPP_STATUS.RINGING_APP, providerCallId: null, createdAt: { lt: new Date(now.getTime() - INAPP_UNTAKEN_AFTER_MS) } },
        data: { endedAt: now, status: CALL_STATUS.NOT_CONNECTED, durationSeconds: 0 },
      });
      // A call the provider never reported finished cannot hold the slot for ever (the bridge's rule).
      const stale = new Date(now.getTime() - CALL_STALE_AFTER_MS);
      await tx.callSession.updateMany({ where: { orderId: order.id, endedAt: null, createdAt: { lt: stale }, status: CALL_STATUS.CONNECTED }, data: { endedAt: now } });
      await tx.callSession.updateMany({ where: { orderId: order.id, endedAt: null, createdAt: { lt: stale } }, data: { endedAt: now, status: CALL_STATUS.NOT_CONNECTED } });
      // The cap counts every attempt on the order, in the app or through the bridge: one budget.
      const attempts = await tx.callSession.count({ where: { orderId: order.id } });
      if (attempts >= deps.config.maxAttemptsPerOrder) {
        throw new AppError(429, 'CALL_LIMIT_REACHED', 'Swift has connected as many calls as it can for this order. Message them in chat, or ask support.');
      }
      // [owner 6 Nov · CALL-RELAY-ON] The bridge's daily rules, under the bridge's own lock, over the same rows:
      // one live call per person, the person's day (customer 5 / partner 20), then the shared day (100), so an
      // in-app call and a bridged call spend one budget. Mirrors startBridgeCall; keep the two in step.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CALL_DAILY_CAP_LOCK}))`;
      await tx.callSession.updateMany({
        where: { callerUserId: input.userId, endedAt: null, createdAt: { lt: new Date(now.getTime() - INAPP_UNTAKEN_AFTER_MS) }, status: INAPP_STATUS.RINGING_APP, providerCallId: null },
        data: { endedAt: now, status: CALL_STATUS.NOT_CONNECTED, durationSeconds: 0 },
      });
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
      const mine = await tx.callSession.count({
        where: { ...inWindow, callerUserId: input.userId, callerRole: asPartner ? { in: [...PARTNER_ROLES] } : 'customer' },
      });
      if (mine >= personCap) {
        throw new AppError(429, 'CALL_USER_DAILY_LIMIT_REACHED', 'You have used your Swift calls for today. Message them in chat, or ask support.');
      }
      const today = Math.max(
        await tx.callSession.count({ where: inWindow }),
        await withinLedgerWait(ledger.count(now.getTime() - DAY_MS)).catch(() => { throw ledgerDown(); }),
      );
      if (today >= deps.config.maxCallsPerDay) {
        log().warn({ maxCallsPerDay: deps.config.maxCallsPerDay }, '[INAPP-CALLS] daily call cap reached: Call in app refused until a slot frees');
        throw new AppError(429, 'CALL_DAILY_LIMIT_REACHED', 'Swift calls are busy right now. Message them in chat, or ask support.');
      }
      const row = await tx.callSession.create({
        data: { orderId: order.id, callerUserId: input.userId, callerRole, calleeRole: input.target, provider: INAPP_PROVIDER, status: INAPP_STATUS.RINGING_APP },
        select: { id: true },
      });
      await withinLedgerWait(ledger.add(row.id, now.getTime())).catch(() => { throw ledgerDown(); });
      return row.id;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, 'CALL_IN_PROGRESS', 'A Swift call on this order is already ringing. Answer it, or try again in a minute.');
    }
    if (err instanceof AppError && err.code === 'CALL_DAILY_LIMIT_REACHED' && deps.alertDailyCap) {
      await deps.alertDailyCap(deps.config.maxCallsPerDay).catch(() => undefined);
    }
    throw err;
  }
  const { token, ttlSeconds } = tokenFor(deps.config, callerIdentity, input.platform, now, true);
  return { callId, token, ttlSeconds };
}

/** The caller's phone could not connect: end the row Twilio never took, so the order is free again at once. */
export async function cancelUntakenCall(deps: InAppDeps, userId: string, callId: string): Promise<void> {
  if (!CALL_ID.test(callId)) throw new AppError(404, 'NOT_FOUND', 'Call not found');
  const now = deps.now?.() ?? new Date();
  const ended = await deps.prisma.callSession.updateMany({
    where: { id: callId, callerUserId: userId, provider: INAPP_PROVIDER, status: INAPP_STATUS.RINGING_APP, providerCallId: null, endedAt: null },
    data: { status: CALL_STATUS.NOT_CONNECTED, endedAt: now, durationSeconds: 0 },
  });
  if (ended.count !== 1) throw new AppError(404, 'NOT_FOUND', 'Call not found');
}

/** The URL of one of Swift's own in-app steps (the bridge's steps keep the bridge's webhookUrl). */
const appStepUrl = (config: Pick<InAppCallsConfig, 'webhookBase'>, step: InAppStepName, callId: string) =>
  `${config.webhookBase}/${step}?s=${encodeURIComponent(callId)}`;

const hangup = (say?: string): { step: CallStep } => ({ step: say ? { verb: 'hangup', say } : { verb: 'hangup' } });

/**
 * One in-app provider webhook. The caller of this has ALREADY verified Twilio's signature over the exact URL.
 * `callId` comes from the URL (?s=) for the steps Swift wrote, or from the caller's connect parameters for `app`.
 */
export async function handleInAppStep(
  deps: InAppDeps,
  step: InAppStepName,
  callId: string,
  fields: Record<string, string[]>,
  enabled: boolean,
): Promise<{ step: CallStep | null }> {
  const now = deps.now?.() ?? new Date();
  if (step === 'app-status') {
    const sid = first(fields, 'CallSid');
    const status = first(fields, 'CallStatus')?.toLowerCase() ?? null;
    if (!sid || !CALL_SID.test(sid) || !status || !TERMINAL_CALL_STATUSES.has(status)) return { step: null };
    const session = await deps.prisma.callSession.findUnique({ where: { providerCallId: sid } });
    if (!session || session.provider !== INAPP_PROVIDER || session.endedAt) return { step: null };
    await deps.prisma.callSession.updateMany({ where: { id: session.id, endedAt: null, status: { not: CALL_STATUS.CONNECTED } }, data: { status: CALL_STATUS.NOT_CONNECTED, endedAt: now, durationSeconds: 0 } });
    await deps.prisma.callSession.updateMany({ where: { id: session.id, endedAt: null, status: CALL_STATUS.CONNECTED }, data: { endedAt: now } });
    return { step: null };
  }

  const session = CALL_ID.test(callId) ? await deps.prisma.callSession.findUnique({ where: { id: callId } }) : null;
  if (!session || session.provider !== INAPP_PROVIDER) return hangup();
  const notConnected = { status: CALL_STATUS.NOT_CONNECTED, endedAt: now, durationSeconds: 0 };

  switch (step) {
    case 'app': {
      // The caller's phone connected. It must be THIS row's caller, the row untaken and ringing, the switch on.
      const sid = first(fields, 'CallSid');
      const from = first(fields, 'From');
      // The From must be a CURRENT session of this row's caller (a signed-out phone's identity is dead).
      const callerIdentities = await currentIdentities(deps.prisma, deps.config, [session.callerUserId], now);
      if (!enabled || session.endedAt || session.status !== INAPP_STATUS.RINGING_APP || session.providerCallId
        || !sid || !CALL_SID.test(sid) || !from || !callerIdentities.some((identity) => from === `client:${identity}`)) {
        return hangup();
      }
      const order = await loadOrder(deps.prisma, session.orderId);
      const people = order && !isTerminalOrderStatus(order.status)
        ? (await appPeopleFor(deps.prisma, order, session.calleeRole as CallTarget)).filter((id) => id !== session.callerUserId)
        : [];
      const clients = await ringableIdentities(deps, people, now);
      // Single use: the first connect takes the row; a replay of the same call id is hung up.
      const taken = await deps.prisma.callSession.updateMany({
        where: { id: session.id, providerCallId: null, endedAt: null, status: INAPP_STATUS.RINGING_APP },
        // The caller is on the line (their own app connected): the row's "caller confirmed" moment.
        data: { providerCallId: sid, callerConfirmedAt: now },
      });
      if (taken.count !== 1) return hangup();
      if (order && clients.length === 0) {
        // Nobody signed in on build 13 and registered (microphone granted) for them: straight to their phone
        // (bridge on), never a silent ring.
        const fallback = await phoneFallback(deps, session, 'failed', enabled);
        if (fallback) return fallback;
      }
      if (!order || clients.length === 0) {
        await deps.prisma.callSession.updateMany({ where: { id: session.id, endedAt: null }, data: notConnected });
        return hangup(INAPP_WORDS.notReached);
      }
      return {
        step: {
          verb: 'dialApp',
          clients,
          callerId: 'client:Swift',
          params: { swiftLine: callScreenLine(session.callerRole as CallerRole, order.orderType), swiftCallId: session.id },
          answered: appStepUrl(deps.config, 'app-answered', session.id),
          done: appStepUrl(deps.config, 'app-dial-done', session.id),
          ringSeconds: INAPP_RING_SECONDS,
          limitSeconds: deps.config.maxCallSeconds,
        },
      };
    }
    case 'app-answered': {
      // Runs on the other person's leg after they tapped Answer: an app is a person, no Press 1 needed.
      // [server review 9] The switch went off while it rang: nothing connects.
      if (!enabled) {
        await deps.prisma.callSession.updateMany({ where: { id: session.id, status: INAPP_STATUS.RINGING_APP, endedAt: null }, data: notConnected });
        return hangup();
      }
      const moved = await deps.prisma.callSession.updateMany({
        where: { id: session.id, status: INAPP_STATUS.RINGING_APP, endedAt: null },
        data: { status: CALL_STATUS.CONNECTED, connectedAt: now },
      });
      return moved.count === 1 ? { step: { verb: 'connect' } } : hangup();
    }
    case 'app-dial-done': {
      if (session.status === CALL_STATUS.CONNECTED) {
        const seconds = first(fields, 'DialCallDuration');
        await deps.prisma.callSession.updateMany({
          where: { id: session.id, endedAt: null },
          data: { endedAt: now, durationSeconds: seconds && /^\d{1,6}$/.test(seconds) ? Number(seconds) : 0 },
        });
        return hangup();
      }
      if (session.endedAt || session.status !== INAPP_STATUS.RINGING_APP) return hangup();
      const dialStatus = first(fields, 'DialCallStatus')?.toLowerCase() ?? '';
      const fallback = await phoneFallback(deps, session, dialStatus, enabled);
      if (fallback) return fallback;
      await deps.prisma.callSession.updateMany({ where: { id: session.id, endedAt: null }, data: notConnected });
      return hangup(INAPP_WORDS.notReached);
    }
  }
}

/**
 * Not reached in the app: ring their phone from Swift's number in the same call (one phone leg), with the
 * bridge's Press-1 screen. Only while CALL_RELAY is on, never after a decline, and only if the order is still
 * live and has a number for them. The row becomes a bridge row at CALLER_CONFIRMED (the caller is on the line),
 * so the bridge's own screen / screen-gather / dial-done steps finish it.
 */
async function phoneFallback(
  deps: InAppDeps,
  session: { id: string; orderId: string; callerRole: string; calleeRole: string },
  dialStatus: string,
  enabled: boolean,
): Promise<{ step: CallStep } | null> {
  if (!deps.relay || !enabled || !FALLBACK_DIAL_STATUSES.has(dialStatus)) return null;
  const order = await loadOrder(deps.prisma, session.orderId);
  // [REVIEW-M17 S1-1] The bridge's one dial guard: a complete Guyana line, never Swift's own number, an ACTIVE store.
  const to = order && !isTerminalOrderStatus(order.status) ? dialFor(order, session.calleeRole as CallTarget, deps.relay.config.callerId) : null;
  if (!order || !to) return null;
  const moved = await deps.prisma.callSession.updateMany({
    where: { id: session.id, status: INAPP_STATUS.RINGING_APP, endedAt: null },
    data: { status: CALL_STATUS.CALLER_CONFIRMED },
  });
  if (moved.count !== 1) return null;
  const callee = session.calleeRole as CallTarget;
  const bridgeDeps = { prisma: deps.prisma, provider: deps.relay.provider, config: deps.relay.config, notifications: deps.notifications };
  const listeners = callee === 'store'
    ? (order.vendor?.owner?.userId ? [order.vendor.owner.userId] : [])
    : await appPeopleFor(deps.prisma, order, callee);
  await warnOfCall(bridgeDeps, order, listeners, callee, session.callerRole as CallTarget, session.id, 2);
  return {
    step: {
      verb: 'dial',
      say: INAPP_WORDS.tryingPhone,
      to,
      callerId: deps.relay.config.callerId,
      screen: webhookUrl(deps.relay.config, 'screen', session.id),
      done: webhookUrl(deps.relay.config, 'dial-done', session.id),
      ringSeconds: CALL_RING_SECONDS,
      limitSeconds: deps.relay.config.maxCallSeconds,
    },
  };
}
