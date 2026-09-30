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
import { storeAlertSubmission } from './store-alert-authority';

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
  'submission_unknown', 'window_closed', 'unsent', 'sms_unsent', 'sms_uncertain', 'sms_over_budget', 'sms_no_phone', 'admin_unreached',
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
  releasedToVendorAt: true,
  vendor: {
    select: { name: true, phone: true, isCurrentlyOpen: true, owner: { select: { user: { select: { phone: true } } } } },
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
async function teamHasSeen(prisma: PrismaClient, orderId: string): Promise<boolean> {
  const receipt = await prisma.alertDelivery.findFirst({
    where: {
      kind: 'VENDOR_ORDER',
      subjectId: orderId,
      OR: [{ seenAt: { not: null } }, { acknowledgedAt: { not: null } }],
    },
    select: { id: true },
  });
  if (receipt) return true;
  const read = await prisma.notification.findFirst({
    where: {
      isRead: true,
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
async function readWaitingOrder(prisma: PrismaClient, orderId: string): Promise<Waiting> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: LADDER_ORDER_SELECT });
  if (!order || !order.vendorId || !order.vendor) return { stop: 'gone' };
  if (order.status !== 'PENDING') return { stop: 'answered' };
  // Still inside the free-cancel hold, or not yet released from it: the store
  // has not been shown this order, so there is nothing to escalate. Release
  // clears holdExpiresAt and writes the ladder's first rung itself.
  if (order.holdExpiresAt !== null) return { stop: 'held' };
  if (await teamHasSeen(prisma, orderId)) return { stop: 'seen' };
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

/** The response deadline the alert went out with (vendorRespondBy). */
function respondByOf(rows: AlertRow[]): string | undefined {
  const data = rows[0]?.data;
  const respondBy = data && typeof data === 'object' && !Array.isArray(data) ? data['respondBy'] : undefined;
  return typeof respondBy === 'string' ? respondBy : undefined;
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

interface RungAuthority {
  ready(): Promise<boolean>;
  current(): boolean;
  submit: SubmissionGuard;
  stopped(): RungOutcome;
  unknown(): void;
}

function rungAuthority(deps: LadderDeps, orderId: string, rung: LadderRung, token: string, respondBy: string | undefined): RungAuthority {
  const key = rungClaimKey(orderId, rung);
  let uncertain = false;
  let leaseReadAt = performance.now();
  const current = () => !windowClosed(respondBy, Date.now()) && performance.now() - leaseReadAt < RUNG_SENDING_TTL_MS;
  const ready = async () => {
    if (uncertain || !(await stillWaiting(deps.prisma, orderId)) || windowClosed(respondBy, Date.now())) return false;
    leaseReadAt = performance.now();
    // The durable marker is written BEFORE the handoff. If the response or
    // worker is lost, another worker cannot infer that nothing was submitted.
    const owned = await deps.redis.eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      local submitted = redis.call('GET', KEYS[2])
      if submitted and submitted ~= ARGV[1] then return 0 end
      redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[3])
      redis.call('PEXPIRE', KEYS[1], ARGV[2])
      return 1`, 2, key, `${key}:submitted`, token, RUNG_SENDING_TTL_MS, RUNG_DONE_TTL_SECONDS);
    return owned === 1 && current();
  };
  const submit: SubmissionGuard = async (start) => {
    if (!(await ready()) || !current()) return undefined;
    try { return await start(); } catch (error) { uncertain = true; throw error; }
  };
  return { ready, current, submit, unknown: () => { uncertain = true; }, stopped: () => windowClosed(respondBy, Date.now()) ? 'window_closed' : 'stopped' };
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
  const respondBy = respondByOf(rows);
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
    const locked = storeAlertSubmission(deps.prisma, order.vendorId, userId, authority.ready, authority.current);
    const recipient: SubmissionGuard = async (start) => {
      try { return await locked(start); } catch (error) { if (!(error instanceof PushNotSubmittedError)) authority.unknown(); throw error; }
    };
    // Authority.ready has already fenced the rung under the membership lock.
    // The actual adapter start must be synchronous here, so do not nest the
    // asynchronous rung guard between the locked decision and its handoff.
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
  const phone = storeSmsNumber(order.vendor.phone, order.vendor.owner.user.phone);
  if (!phone) return 'sms_no_phone';
  const budget = await checkStoreAlertSmsBudget(deps.redis, phone);
  if (!budget.allowed) return 'sms_over_budget';
  const refund = async () => { await budget.refund?.().catch(() => {}); };
  let handedOff = false;
  try {
    const submitted = await authority.submit(() => { handedOff = true; return deps.channels.sms.sendSms(phone, `Swift: order ${order.orderNumber} is still waiting for your response. Open your dashboard now.`); });
    if (!submitted) { await refund(); return authority.stopped(); }
    return 'sms_sent';
  } catch (err) {
    // The last rung that reaches the store itself failed: never silent
    // [SWIFT-100]. The number and the text are never logged.
    notificationFailuresCounter.inc({ channel: 'sms', stage: 'escalation' });
    // [AX291 F06] Only a text the provider PROVABLY never took gives its
    // budget back. A timeout or an unreadable reply may still have been sent
    // and billed, so it keeps its place in the day's count: the cap can
    // never be passed by texts that went out while their replies were lost.
    if (!handedOff || err instanceof SmsNotSubmittedError) {
      await refund();
      log().warn({ err, orderId: order.id }, 'store ladder: the text to the store was not submitted');
      return 'sms_unsent';
    }
    log().warn({ err, orderId: order.id }, 'store ladder: the text to the store may or may not have gone out');
    return 'sms_uncertain';
  }
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
  });
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
  if (outcome === 'in_progress' && retryInMs !== undefined) {
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
  const stamped = await prisma.alertDelivery.updateMany({
    where: { kind: 'VENDOR_ORDER', subjectId: orderId, recipientId: userId, seenAt: null },
    data: { seenAt: now },
  });
  if (stamped.count > 0) return;
  const receipt = await prisma.alertDelivery.findFirst({
    where: { kind: 'VENDOR_ORDER', subjectId: orderId, recipientId: userId },
    select: { id: true },
  });
  if (receipt) return; // seen before: the first sighting stands
  // No receipt at all (added to the team after the alert went out, or a
  // receipt write that failed): the sighting still counts, on one of theirs.
  await prisma.alertDelivery.createMany({
    data: [{ id: seenReceiptId(orderId, userId), kind: 'VENDOR_ORDER', subjectId: orderId, recipientId: userId, sentAt: now, seenAt: now }],
    skipDuplicates: true,
  });
}
