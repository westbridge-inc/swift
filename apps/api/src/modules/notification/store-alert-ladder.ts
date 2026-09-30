import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { Server } from 'socket.io';
import { SmsNotSubmittedError, PushNotSubmittedError, type NotificationChannels, type SubmissionGuard } from '../../providers/notifications/channels';
import { PUSH_DEVICE_SELECT, pushToDevices } from '../../providers/notifications/device-push';
import { checkStoreAlertSmsBudget } from '../../utils/sms-budget';
import { normalizePhone } from '../../utils/phone';
import { log } from '../../utils/logger';
import { notificationFailuresCounter, storeAlertRungsCounter } from '../../plugins/observability';
import { NotificationService, deactivateDeadTokens, notifyAdmins } from './notification.service';
import { storeAlertRecipients } from './store-alert-recipients';
import { storeAlertAuthorityInTx } from './store-alert-authority';
import { isAuthorityContention, lockStoreAlertOrders, withStoreAlertStop, type AlertPersistenceGuard } from './store-alert-order-authority';
import { vendorRespondBy, vendorResponseSlaMinutes } from '../order/response-sla';
import { holdWindowMs } from '../order/order.service';

// ---------------------------------------------------------------------------
// [Q10 loud alerts 2/4] THE STORE NEW-ORDER LADDER.
//
// When a store is shown a new order, nobody at the store may be left not
// knowing. "Shown" is the new-order alert: at checkout for an order with no
// hold, and at the end of the 5-minute free-cancel hold for a held one (the
// owner kept the hold on 09-24, so the ladder starts at release and never
// rings inside the window). Every rung is measured from that moment
// [coordinator ruling 09-24]:
//
//   +30 s   ring1  ring the team again: the owner and every active member of
//                  the store's staff who has the app (a push to each device)
//   +60 s   ring2  ring again
//   +90 s   sms    text the store phone, inside the ladder's own daily budget
//   +3 min  admin  tell the operators, naming the order and the store
//
// The auto-cancel at the response deadline (10 min by default) is separate
// and unchanged.
//
// Each rung is its own job and decides at SEND time, first and again as the
// last read before the provider call (DS276 F1): the ladder stops for good
// once the order no longer waits for the store (accepted, rejected,
// cancelled by anyone, auto-cancelled, gone) or once anyone on the team has
// seen or acknowledged the alert. Jobs already queued run into the same
// check, so nothing has to be dequeued. A booking rings only while its store
// is open [ruling 09-24]. A rung goes out at most once per order however
// often its job runs: a Redis claim per order and rung, taken just before
// sending, in two phases [AX291 F05]. "Sending" lives 2 minutes; only a send
// that finished turns it into "done" for a day. A worker that dies before handoff
// leaves a claim that expires. Before any handoff, a separate day-long marker
// records submission authority; a lost response then stays unknown and cannot
// become a fresh send merely because the short lease expired. Later rungs
// remain the fallback. A crash between marker and transport can lose this
// rung; provider delivery is not atomic with Redis.
//
// Every rung is logged and counted by outcome (swift_store_alert_rungs_total).
// A rung that reached nobody is its own outcome (DS276 F2), never a delivered
// one: a re-ring no device accepted is 'unsent', not 'realerted', and a
// response window that already closed is 'window_closed' and ends the ladder.
// ---------------------------------------------------------------------------

export type LadderRung = 'ring1' | 'ring2' | 'sms' | 'admin';

/** THE LADDER: each rung, and how long after the store was shown the order
 *  it is due. */
export const LADDER: ReadonlyArray<{ readonly rung: LadderRung; readonly afterMs: number }> = [
  { rung: 'ring1', afterMs: 30_000 },
  { rung: 'ring2', afterMs: 60_000 },
  { rung: 'sms', afterMs: 90_000 },
  { rung: 'admin', afterMs: 180_000 },
];

/** When the first rung runs, after the store is shown the order. */
export const FIRST_RUNG_DELAY_MS = LADDER[0]!.afterMs;

/** The job every rung runs as, on the NOTIFICATION queue. The name predates
 *  the ladder and stays: jobs and outbox rows written before this change must
 *  still run.
 *
 *  [Q12 · AX289 F5 · AX291] The ladder is armed in ONE way: its first rung is
 *  the order's durable outbox row (checkout-outbox.ts, kind
 *  'vendor-alert-escalate', `level: 0`, delay vendorAlertLadderDelayMs() =
 *  FIRST_RUNG_DELAY_MS), written by checkout for an order with no hold and by
 *  the release, inside its transaction, for a held one. The first rung
 *  schedules the rest under deterministic job ids. */
export const LADDER_JOB = 'vendor-alert-escalate';

export type RungOutcome =
  /** The order no longer waits for the store, or someone there saw it. */
  | 'stopped'
  /** Its response window has closed: the auto-cancel owns it now. */
  | 'window_closed'
  /** A booking while its store is closed: bookings ring only while open. */
  | 'store_closed'
  /** This rung already went out for this order. */
  | 'already_sent'
  /** Another attempt holds this rung's pre-handoff "sending" claim: the job tries again once that claim can have expired. */
  | 'in_progress'
  /** No handoff began; contention/churn can retry under the existing bounded policy. */
  | 'not_submitted'
  /** A prior handoff has no confirmed completion; never blindly resubmit. */
  | 'submission_unknown'
  /** At least one device accepted the re-ring. */
  | 'realerted'
  /** No device accepted the re-ring (none registered, all dead, dropped). */
  | 'unsent'
  | 'sms_sent'
  /** The provider PROVABLY did not take the text (it never left, or a 4xx
   *  refusal); nothing was billed, so the budget was given back. */
  | 'sms_unsent'
  /** The provider failed in a way that may still have sent and billed the
   *  text (a timeout, a 5xx, an unreadable reply): the budget keeps it
   *  [AX291 F06], and it is never reported as sent. */
  | 'sms_uncertain'
  /** The store phone has had its texts for the day. */
  | 'sms_over_budget'
  /** Neither the store phone nor the owner number can take a text. */
  | 'sms_no_phone'
  | 'admin_paged'
  /** Not one operator inbox took the page. */
  | 'admin_unreached';

/** Outcomes where a rung that was due reached nobody: warned, never counted
 *  as delivered. */
const MISSED: ReadonlySet<RungOutcome> = new Set<RungOutcome>([
  'submission_unknown', 'not_submitted', 'window_closed', 'unsent', 'sms_unsent', 'sms_uncertain', 'sms_over_budget', 'sms_no_phone', 'admin_unreached',
]);

export interface LadderDeps {
  prisma: PrismaClient;
  io: Server;
  redis: Redis;
  channels: NotificationChannels;
}

/** Where later rungs are scheduled: the NOTIFICATION queue. */
export interface LadderQueue {
  add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>): Promise<unknown>;
}

/** One BullMQ job id per order and rung, so scheduling a rung twice is a
 *  no-op while its job exists. (BullMQ refuses ":" in custom ids.) */
export function ladderJobId(orderId: string, rung: LadderRung): string {
  return `store-ladder-${orderId}-${rung}`;
}

/** The rung a job runs. New jobs name it; `level` is the shape jobs had
 *  before the ladder was rebuilt (the checkout's and the release's outbox
 *  rows still write it for the first rung): 0 or absent is ring1, 1 was the
 *  SMS fallback. */
export function rungOf(data: Record<string, unknown>): LadderRung | null {
  const rung = data['rung'];
  if (rung !== undefined) return LADDER.find((step) => step.rung === rung)?.rung ?? null;
  const level = data['level'] ?? 0;
  if (level === 0) return 'ring1';
  if (level === 1) return 'sms';
  return null;
}

const LADDER_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  tenantId: true,
  status: true,
  holdExpiresAt: true,
  vendorId: true,
  fulfillment: true,
  placedAt: true,
  createdAt: true,
  appointmentSlot: true,
  releasedToVendorAt: true,
  vendor: {
    select: { name: true, phone: true, isCurrentlyOpen: true, owner: { select: { user: { select: { phone: true, status: true, tenantId: true } } } } },
  },
} as const satisfies Prisma.OrderSelect;

type LadderOrderRow = Prisma.OrderGetPayload<{ select: typeof LADDER_ORDER_SELECT }>;
type WaitingOrder = Omit<LadderOrderRow, 'vendorId' | 'vendor'> & {
  vendorId: string;
  vendor: NonNullable<LadderOrderRow['vendor']>;
};

type Waiting = { order: WaitingOrder } | { stop: 'gone' | 'answered' | 'held' | 'seen' };

/** Anyone on the team saw or acknowledged the alert: a receipt stamped seen
 *  (alert-seen) or acknowledged (ack, accept, reject), or an alert row that
 *  somebody read. */
async function teamHasSeen(prisma: PrismaClient | Prisma.TransactionClient, orderId: string, vendorId: string): Promise<boolean> {
  const eligible = await storeAlertRecipients(prisma, vendorId);
  if (eligible.length === 0) return false;
  const receipt = await prisma.alertDelivery.findFirst({
    where: {
      kind: 'VENDOR_ORDER',
      subjectId: orderId,
      recipientId: { in: eligible },
      OR: [{ seenAt: { not: null } }, { acknowledgedAt: { not: null } }],
    },
    select: { id: true },
  });
  if (receipt) return true;
  const read = await prisma.notification.findFirst({
    where: {
      isRead: true,
      userId: { in: eligible },
      AND: [
        { data: { path: ['kind'], equals: 'vendor_order_alert' } },
        { data: { path: ['orderId'], equals: orderId } },
      ],
    },
    select: { id: true },
  });
  return read !== null;
}

/** The order, only while the store still owes it an answer. Read fresh
 *  every time it matters: only the order row knows whether anyone ended the
 *  wait. */
async function readWaitingOrder(prisma: PrismaClient | Prisma.TransactionClient, orderId: string): Promise<Waiting> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: LADDER_ORDER_SELECT });
  if (!order || !order.vendorId || !order.vendor) return { stop: 'gone' };
  if (order.status !== 'PENDING') return { stop: 'answered' };
  // Still inside the free-cancel hold, or not yet released from it: the store
  // has not been shown this order, so there is nothing to escalate. Release
  // clears holdExpiresAt and writes the ladder's first rung itself.
  if (order.holdExpiresAt !== null) return { stop: 'held' };
  if (await teamHasSeen(prisma, orderId, order.vendorId)) return { stop: 'seen' };
  return { order: { ...order, vendorId: order.vendorId, vendor: order.vendor } };
}

/** DS276 F1: the last read before a provider call. */
async function stillWaiting(prisma: PrismaClient, orderId: string): Promise<boolean> {
  return 'order' in (await readWaitingOrder(prisma, orderId));
}

/** When the store was shown the order: its release from the hold, or its
 *  placement when it had none. */
function shownAt(order: WaitingOrder): Date {
  return order.releasedToVendorAt ?? order.placedAt;
}

type AlertRow = { id: string; userId: string; body: string; data: Prisma.JsonValue };

/** The new-order alert rows the team got (newOrderForStore), oldest first. */
async function alertRowsFor(prisma: PrismaClient, orderId: string): Promise<AlertRow[]> {
  return prisma.notification.findMany({
    where: {
      AND: [
        { data: { path: ['kind'], equals: 'vendor_order_alert' } },
        { data: { path: ['orderId'], equals: orderId } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, userId: true, body: true, data: true },
  });
}

/** Durable auto-cancel timing survives optional inbox persistence and config changes.
 * The drainer schedules createdAt + delayMs; hold/appointment policy is already
 * included in that immutable delay. Legacy rows use the existing policy. */
async function authoritativeRespondBy(prisma: PrismaClient, order: WaitingOrder, rows: AlertRow[]): Promise<string> {
  const cancel = await prisma.orderOutbox.findFirst({
    where: { orderId: order.id, tenantId: order.tenantId, kind: 'auto-cancel', queue: 'order' },
    select: { createdAt: true, delayMs: true },
  });
  const earlier = rows.flatMap((row) => {
    const data = row.data;
    const value = data && typeof data === 'object' && !Array.isArray(data) ? data['respondBy'] : undefined;
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? [time] : [];
  });
  // Without an outbox, a valid server-written inbox cutoff is the legacy
  // immutable timing evidence. Current config must not truncate that snapshot.
  const cutoff = cancel
    ? cancel.createdAt.getTime() + cancel.delayMs
    : earlier.length > 0 ? Math.min(...earlier)
      : vendorRespondBy(order, { slaMinutes: await vendorResponseSlaMinutes(prisma), holdMs: holdWindowMs() ?? 0 })!.getTime();
  return new Date(Math.min(cutoff, ...earlier)).toISOString();
}

/** A push needs a whole second of life left to be sent at all (channels.ts
 *  pushWindow), and a rung is held to the same window. */
const MIN_WINDOW_MS = 1_000;

function windowClosed(respondBy: string | undefined, now: number): boolean {
  if (!respondBy) return false;
  const deadline = Date.parse(respondBy);
  return Number.isFinite(deadline) && deadline - now < MIN_WINDOW_MS;
}

/** [AX291 F05] How long a "sending" claim lives. Longer than any one send
 *  takes (the push adapter gives up after its retries within seconds, the
 *  text after 8 s), short enough that a rung whose worker died is retried
 *  well inside the response window. */
export const RUNG_SENDING_TTL_MS = 2 * 60_000;
const RUNG_DONE_TTL_SECONDS = 24 * 60 * 60;
/** How many times a job waits out another attempt's "sending" claim. */
const MAX_IN_PROGRESS_RETRIES = 3;
export const rungClaimKey = (orderId: string, rung: LadderRung) => `store_ladder:${orderId}:${rung}`;

type RungClaim = { token: string } | { held: 'done' } | { held: 'submitted' } | { held: 'sending'; retryInMs: number };

/** Phase 1: take this rung's short "sending" claim, or say who holds it. */
async function claimRung(redis: Redis, orderId: string, rung: LadderRung): Promise<RungClaim> {
  const key = rungClaimKey(orderId, rung);
  const token = `sending:${randomUUID()}`;
  if (await redis.get(`${key}:submitted`)) {
    return (await redis.get(key))?.startsWith('done:') ? { held: 'done' } : { held: 'submitted' };
  }
  if ((await redis.set(key, token, 'PX', RUNG_SENDING_TTL_MS, 'NX')) === 'OK') return { token };
  const [value, pttl] = await Promise.all([redis.get(key), redis.pttl(key)]);
  if (value !== null && !value.startsWith('sending:')) return { held: 'done' };
  // Held by another attempt (or it expired a moment ago): try after it lapses.
  return { held: 'sending', retryInMs: Math.max(0, pttl) + 1_000 };
}

/** Phase 2: the send finished (whatever it reached), so the rung is done for
 *  the day. */
async function finishRung(redis: Redis, orderId: string, rung: LadderRung, token: string, outcome: RungOutcome): Promise<void> {
  await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) end return 0",
    1, rungClaimKey(orderId, rung), token, `done:${outcome}`, RUNG_DONE_TTL_SECONDS);
}

class SmsDestinationChanged extends Error {}

interface RungAuthority {
  current(): boolean;
  submit: SubmissionGuard;
  recipient(userId: string): SubmissionGuard;
  sms(phone: string): SubmissionGuard;
  persist: AlertPersistenceGuard;
  stopped(): RungOutcome;
  unknown(): void;
  retry(): void;
  canRetry(): boolean;
}

function rungAuthority(deps: LadderDeps, orderId: string, rung: LadderRung, token: string, respondBy: string): RungAuthority {
  const key = rungClaimKey(orderId, rung);
  let uncertain = false;
  let retryable = false;
  let handoffs = 0;
  let leaseReadAt = performance.now();
  const current = () => !windowClosed(respondBy, Date.now()) && performance.now() - leaseReadAt < RUNG_SENDING_TTL_MS;
  const ready = async () => {
    if (uncertain || !(await stillWaiting(deps.prisma, orderId)) || windowClosed(respondBy, Date.now())) return false;
    leaseReadAt = performance.now();
    // Retain the conservative marker-before-transport crash boundary.
    const owned = await deps.redis.eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      local submitted = redis.call('GET', KEYS[2])
      if submitted and submitted ~= ARGV[1] then return 0 end
      redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[3])
      redis.call('PEXPIRE', KEYS[1], ARGV[2])
      return 1`, 2, key, `${key}:submitted`, token, RUNG_SENDING_TTL_MS, RUNG_DONE_TTL_SECONDS);
    return owned === 1 && current();
  };
  type Authorize = (tx: Prisma.TransactionClient, order: WaitingOrder) => Promise<boolean>;
  const locked = async <T>(work: (tx: Prisma.TransactionClient, fresh: () => boolean) => Promise<T>, authorize?: Authorize): Promise<T | undefined> => {
    if (!(await ready()) || !current()) return undefined;
    try {
      return await deps.prisma.$transaction(async (tx) => {
        const started = performance.now();
        const fresh = () => current() && performance.now() - started < 4_000;
        await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
        if (!(await lockStoreAlertOrders(tx, [orderId], 'read')) || !fresh()) return undefined;
        const waiting = await readWaitingOrder(tx, orderId);
        if (!('order' in waiting) || !fresh()) return undefined;
        if (authorize && !(await authorize(tx, waiting.order))) return undefined;
        if (!fresh()) return undefined;
        return work(tx, fresh);
      }, { maxWait: 2_000, timeout: 5_000 });
    } catch (error) {
      if (isAuthorityContention(error)) { retryable = true; return undefined; }
      throw error;
    }
  };
  const guard = (authorize?: Authorize): SubmissionGuard => async <T>(start: () => Promise<T>) => {
    let pending: Promise<{ value: T } | { error: unknown }> | undefined;
    let attempted = false;
    try {
      await locked(async (_tx, fresh) => {
        if (!fresh()) return;
        // Actual transport begins synchronously under Order + recipient locks.
        handoffs++; attempted = true;
        pending = start().then((value) => ({ value }), (error: unknown) => ({ error }));
      }, authorize);
    } catch (error) { if (attempted && !(error instanceof PushNotSubmittedError) && !(error instanceof SmsNotSubmittedError)) uncertain = true; throw error; }
    const result = await pending; // no DB lock spans provider completion
    if (!result) return undefined;
    if ('error' in result) {
      if (!(result.error instanceof PushNotSubmittedError) && !(result.error instanceof SmsNotSubmittedError)) uncertain = true;
      throw result.error;
    }
    return result.value;
  };
  const persist: AlertPersistenceGuard = async (write) => {
    let attempted = false;
    try {
      return await locked(async (tx) => {
        handoffs++; attempted = true;
        return write(tx); // durable inbox insert commits with the Order authority
      });
    } catch (error) { if (attempted) uncertain = true; throw error; }
  };
  return {
    current, submit: guard(), persist,
    recipient: (userId) => guard((tx, order) => storeAlertAuthorityInTx(tx, order.vendorId, userId, true)),
    sms: (phone) => guard(async (tx, order) => {
      const stores = await tx.$queryRaw<Array<{ phone: string | null; ownerPhone: string; status: string }>>`
        SELECT v.phone, u.phone AS "ownerPhone", u.status FROM "vendors" v
        JOIN "vendor_owners" o ON o.id = v."ownerId" JOIN "users" u ON u.id = o."userId"
        WHERE v.id = ${order.vendorId} AND v."tenantId" = ${order.tenantId} AND u."tenantId" = v."tenantId"
        FOR SHARE OF v, o, u NOWAIT
      `;
      const store = stores[0];
      const destination = store ? storeSmsNumber(store.phone, store.status === 'ACTIVE' ? store.ownerPhone : null) : null;
      if (destination !== phone) throw new SmsDestinationChanged();
      return true;
    }),
    unknown: () => { uncertain = true; }, retry: () => { retryable = true; },
    canRetry: () => retryable && handoffs === 0 && !uncertain,
    stopped: () => uncertain ? 'submission_unknown' : windowClosed(respondBy, Date.now()) ? 'window_closed' : 'stopped',
  };
}

/** Only this unsubmitted attempt may relinquish its own claim and marker. */
async function releaseNotSubmitted(redis: Redis, orderId: string, rung: LadderRung, token: string): Promise<void> {
  const key = rungClaimKey(orderId, rung);
  await redis.eval(`
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
    local submitted = redis.call('GET', KEYS[2])
    if submitted and submitted ~= ARGV[1] then return 0 end
    redis.call('DEL', KEYS[1])
    if submitted == ARGV[1] then redis.call('DEL', KEYS[2]) end
    return 1`, 2, key, `${key}:submitted`, token);
}

/** A send that threw is retried by the queue: free the claim, if still ours. */
async function releaseRung(redis: Redis, orderId: string, rung: LadderRung, token: string): Promise<void> {
  await redis.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
    1,
    rungClaimKey(orderId, rung),
    token,
  );
}

function settle(rung: LadderRung, outcome: RungOutcome, orderId: string, reason?: string): RungOutcome {
  storeAlertRungsCounter.inc({ rung, outcome });
  const entry = { orderId, rung, outcome, ...(reason ? { reason } : {}) };
  if (MISSED.has(outcome)) log().warn(entry, 'store ladder: a rung that was due reached nobody');
  else log().info(entry, 'store ladder rung');
  return outcome;
}

/**
 * Run ONE rung for one order, deciding everything at send time. `beforeSend`
 * runs once the order is known to still wait inside its response window,
 * before this rung sends (the first rung schedules the rest there).
 */
export async function runLadderRung(
  deps: LadderDeps,
  orderId: string,
  rung: LadderRung,
  beforeSend?: (order: WaitingOrder) => Promise<void>,
): Promise<RungOutcome> {
  return (await runRung(deps, orderId, rung, beforeSend)).outcome;
}

async function runRung(
  deps: LadderDeps,
  orderId: string,
  rung: LadderRung,
  beforeSend?: (order: WaitingOrder) => Promise<void>,
): Promise<{ outcome: RungOutcome; retryInMs?: number }> {
  const waiting = await readWaitingOrder(deps.prisma, orderId);
  if (!('order' in waiting)) return { outcome: settle(rung, 'stopped', orderId, waiting.stop) };
  const { order } = waiting;
  const rows = await alertRowsFor(deps.prisma, orderId);
  const respondBy = await authoritativeRespondBy(deps.prisma, order, rows);
  if (windowClosed(respondBy, Date.now())) return { outcome: settle(rung, 'window_closed', orderId) };
  await beforeSend?.(order);
  // Bookings ring only while the store is open [ruling 09-24]. Any other
  // order still needs its answer when the store closes behind it.
  if (order.fulfillment === 'APPOINTMENT' && !order.vendor.isCurrentlyOpen) {
    return { outcome: settle(rung, 'store_closed', orderId) };
  }
  const claim = await claimRung(deps.redis, orderId, rung);
  if (!('token' in claim)) {
    if (claim.held === 'submitted') return { outcome: settle(rung, 'submission_unknown', orderId) };
    return claim.held === 'done'
      ? { outcome: settle(rung, 'already_sent', orderId) }
      : { outcome: settle(rung, 'in_progress', orderId), retryInMs: claim.retryInMs };
  }
  const authority = rungAuthority(deps, orderId, rung, claim.token, respondBy);
  let outcome: RungOutcome;
  try {
    outcome = rung === 'sms'
      ? await textTheStore(deps, order, authority)
      : rung === 'admin'
        ? await tellTheOperators(deps, order, authority)
        : await ringAgain(deps, order, rows, respondBy, authority);
  } catch (err) {
    // A rung that threw is retried by the queue: free its claim so the retry
    // can send it. (An operator already paged is not paged twice: the page
    // carries a dedupe key.)
    await releaseRung(deps.redis, orderId, rung, claim.token).catch(() => {});
    throw err;
  }
  if (authority.canRetry()) {
    await releaseNotSubmitted(deps.redis, orderId, rung, claim.token);
    return { outcome: settle(rung, 'not_submitted', orderId), retryInMs: 1_000 };
  }
  await finishRung(deps.redis, orderId, rung, claim.token, outcome);
  return { outcome: settle(rung, outcome, orderId) };
}

/** ring1 and ring2: push "still waiting" to every device of the team as it
 *  is NOW, so a member removed since the alert went out is not rung. */
async function ringAgain(deps: LadderDeps, order: WaitingOrder, rows: AlertRow[], respondBy: string | undefined, authority: RungAuthority): Promise<RungOutcome> {
  const recipients = await storeAlertRecipients(deps.prisma, order.vendorId);
  const devices = recipients.length > 0
    ? await deps.prisma.deviceToken.findMany({
      where: { userId: { in: recipients }, isActive: true },
      select: { ...PUSH_DEVICE_SELECT, userId: true },
    })
    : [];
  // What the tap-router needs to open THIS order on the store order desk
  // (VendorOrderDetail); respondBy rides along so the push dies with the
  // response window, like the first alert.
  const payload: Record<string, unknown> = {
    kind: 'vendor_order_alert',
    orderId: order.id,
    orderNumber: order.orderNumber,
    audience: 'business',
    ...(respondBy ? { respondBy } : {}),
  };
  const body = rows[0]?.body ?? `Order ${order.orderNumber} is waiting for your answer.`;
  const wanted = async () => (await stillWaiting(deps.prisma, order.id)) && !windowClosed(respondBy, Date.now());
  const rowOf = new Map(rows.map((row) => [row.userId, row.id]));
  let sent = 0;
  let withdrawn = false;
  for (const userId of recipients) {
    const locked = authority.recipient(userId);
    const recipient: SubmissionGuard = async (start) => {
      try { return await locked(start); } catch (error) { if (!(error instanceof PushNotSubmittedError)) authority.unknown(); throw error; }
    };
    // The combined guard holds Order and recipient authority at actual handoff.
    const handed = await recipient(async () => {
      deps.io.to(`user:${userId}`).emit('vendor:order_alert', {
        ...(rowOf.has(userId) ? { notificationId: rowOf.get(userId) } : {}),
        orderId: order.id, orderNumber: order.orderNumber, persistent: true, reAlert: true,
      });
      return true;
    });
    if (!handed) { withdrawn = true; continue; }
    try {
      const delivered = await pushToDevices(deps.channels.push, devices.filter((device) => device.userId === userId), 'Order still waiting!', body, payload, { stillWanted: wanted, submit: recipient });
      await deactivateDeadTokens(deps.prisma, delivered.invalidTokens);
      sent += delivered.sent;
      withdrawn ||= delivered.withdrawn;
    } catch (err) {
      log().warn({ err, orderId: order.id }, 'store ladder: the re-ring push failed after retries');
      notificationFailuresCounter.inc({ channel: 'push', stage: 'escalation' });
    }
  }
  if (authority.stopped() === 'submission_unknown') return 'submission_unknown';
  if (sent > 0) return 'realerted';
  return withdrawn ? authority.stopped() : 'unsent';
}

/** E.164: what the SMS provider can dial. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * The number the SMS rung texts: the store phone (Vendor.phone, the contact
 * given at onboarding) when it is a dialable international number, else the
 * owner's own verified login number, the one the ladder texted before it
 * knew about the store phone. Null when neither can take a text.
 */
export function storeSmsNumber(storePhone: string | null | undefined, ownerPhone: string | null | undefined): string | null {
  const store = storePhone ? normalizePhone(storePhone) : '';
  if (E164.test(store)) return store;
  return ownerPhone && E164.test(ownerPhone) ? ownerPhone : null;
}

/** sms: text the store, inside the ladder's own daily budget (never the OTP
 *  budget: see checkStoreAlertSmsBudget). Only this rung sends it. */
async function textTheStore(deps: LadderDeps, order: WaitingOrder, authority: RungAuthority): Promise<RungOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const waiting = await readWaitingOrder(deps.prisma, order.id);
    if (!('order' in waiting)) return authority.stopped();
    const store = waiting.order.vendor;
    const phone = storeSmsNumber(store.phone, store.owner.user.status === 'ACTIVE' && store.owner.user.tenantId === order.tenantId ? store.owner.user.phone : null);
    if (!phone) return 'sms_no_phone';
    const budget = await checkStoreAlertSmsBudget(deps.redis, phone);
    if (!budget.allowed) return 'sms_over_budget';
    const refund = async () => { await budget.refund?.().catch(() => {}); };
    let handedOff = false;
    try {
      const submitted = await authority.sms(phone)(() => { handedOff = true; return deps.channels.sms.sendSms(phone, `Swift: order ${order.orderNumber} is still waiting for your response. Open your dashboard now.`); });
      if (!submitted) { await refund(); return authority.stopped(); }
      return 'sms_sent';
    } catch (err) {
      if (err instanceof SmsDestinationChanged && !handedOff) {
        await refund();
        if (attempt === 0) continue;
        authority.retry();
        return 'sms_unsent';
      }
      notificationFailuresCounter.inc({ channel: 'sms', stage: 'escalation' });
      if (!handedOff || err instanceof SmsNotSubmittedError) {
        await refund();
        log().warn({ err, orderId: order.id }, 'store ladder: the text to the store was not submitted');
        return 'sms_unsent';
      }
      authority.unknown();
      log().warn({ err, orderId: order.id }, 'store ladder: the text to the store may or may not have gone out');
      return 'sms_uncertain';
    }
  }
  return 'sms_unsent';
}

/** admin: tell the operators, naming the order and the store. notifyAdmins
 *  pages the admins of the order's own tenant and the platform operators
 *  (SUPER_ADMIN), and nobody else: never the store, never the customer. */
async function tellTheOperators(deps: LadderDeps, order: WaitingOrder, authority: RungAuthority): Promise<RungOutcome> {
  if (!(await stillWaiting(deps.prisma, order.id))) return 'stopped';
  const waitedMin = Math.max(1, Math.round((Date.now() - shownAt(order).getTime()) / 60_000));
  const reached = await notifyAdmins(deps.prisma, new NotificationService(deps.prisma, deps.io, deps.channels), {
    tenantId: order.tenantId,
    title: 'A store is not answering an order',
    body: `${order.vendor.name} has not answered order ${order.orderNumber} in ${waitedMin} min. Call the store: the order cancels itself if nobody answers.`,
    data: { kind: 'ops_order_unanswered', orderId: order.id, orderNumber: order.orderNumber, vendorId: order.vendorId },
    dedupeKey: `order-unanswered:${order.id}`,
    submit: authority.submit,
    persist: authority.persist,
  });
  if (authority.stopped() === 'submission_unknown') return 'submission_unknown';
  return reached > 0 ? 'admin_paged' : authority.current() ? 'admin_unreached' : authority.stopped();
}

/** Schedule ring2, sms and admin, each due at its offset from the moment the
 *  store was shown the order (at once when that moment has passed). */
async function scheduleLaterRungs(queue: LadderQueue, order: WaitingOrder): Promise<void> {
  const start = shownAt(order).getTime();
  const now = Date.now();
  for (const step of LADDER) {
    if (step.rung === 'ring1') continue;
    await queue.add(LADDER_JOB, { orderId: order.id, rung: step.rung }, {
      jobId: ladderJobId(order.id, step.rung),
      delay: Math.max(0, start + step.afterMs - now),
      removeOnComplete: 100,
      removeOnFail: 50,
    });
  }
}

/**
 * The NOTIFICATION worker's ladder job (jobs/queue.ts), and what tests drive:
 * run the rung the job names. The first rung also schedules the rest once it
 * knows the order still waits inside its window, before it sends, so a crash
 * while sending cannot strand the later rungs.
 */
export async function runLadderJob(deps: LadderDeps & { queue: LadderQueue }, data: Record<string, unknown>): Promise<RungOutcome> {
  const orderId = typeof data['orderId'] === 'string' ? data['orderId'] : '';
  const rung = rungOf(data);
  if (!orderId || !rung) {
    log().warn({ orderId, rung: data['rung'], level: data['level'] }, 'store ladder: a job with no order or no known rung was dropped');
    return 'stopped';
  }
  const { outcome, retryInMs } = await runRung(deps, orderId, rung, rung === 'ring1' ? (order) => scheduleLaterRungs(deps.queue, order) : undefined);
  if ((outcome === 'in_progress' || outcome === 'not_submitted') && retryInMs !== undefined) {
    // [AX291 F05] Another attempt holds this rung's "sending" claim, perhaps
    // a worker that died mid-send. Try again once that claim can have lapsed:
    // if the other attempt finished, the rung is done; if it died, this sends.
    const retry = typeof data['retry'] === 'number' ? data['retry'] : 0;
    if (retry < MAX_IN_PROGRESS_RETRIES) {
      await deps.queue.add(LADDER_JOB, { orderId, rung, retry: retry + 1 }, {
        jobId: `${ladderJobId(orderId, rung)}-retry-${retry + 1}`,
        delay: retryInMs,
        removeOnComplete: 100,
        removeOnFail: 50,
      });
    } else {
      log().warn({ orderId, rung, retry }, 'store ladder: a rung stayed claimed through every retry and was given up');
    }
  }
  return outcome;
}

/** The receipt a team member gets when they saw an alert they were never
 *  sent: derived from (order, person), so repeating the call lands on it. */
function seenReceiptId(orderId: string, userId: string): string {
  return `seen_${createHash('sha256').update(`${orderId}:${userId}`).digest('hex').slice(0, 24)}`;
}

/**
 * [Q10 loud alerts 2/4] One person at the store SAW this order's alert (the
 * app showed the takeover, or they opened the push). Stamps their receipt,
 * which ends the ladder for THIS order (teamHasSeen): no more rings, no text,
 * no operator page. Seen is not answered; the order still waits for accept or
 * reject, and still auto-cancels. The caller must already have proven the
 * order is their store's (resolveOwnedOrder): this writes nothing else.
 * Idempotent: their first sighting is the one kept.
 */
export async function markStoreAlertSeen(prisma: PrismaClient, orderId: string, userId: string, now = new Date()): Promise<void> {
  await withStoreAlertStop(prisma, [orderId], async (tx) => {
    const stamped = await tx.alertDelivery.updateMany({
      where: { kind: 'VENDOR_ORDER', subjectId: orderId, recipientId: userId, seenAt: null },
      data: { seenAt: now },
    });
    if (stamped.count > 0) return;
    const receipt = await tx.alertDelivery.findFirst({
      where: { kind: 'VENDOR_ORDER', subjectId: orderId, recipientId: userId },
      select: { id: true },
    });
    if (receipt) return; // seen before: the first sighting stands
    // No receipt at all (added to the team after the alert went out, or a
    // receipt write that failed): the sighting still counts, on one of theirs.
    await tx.alertDelivery.createMany({
      data: [{ id: seenReceiptId(orderId, userId), kind: 'VENDOR_ORDER', subjectId: orderId, recipientId: userId, sentAt: now, seenAt: now }],
      skipDuplicates: true,
    });
  });
}
