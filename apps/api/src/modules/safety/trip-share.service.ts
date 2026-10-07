import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { NotificationChannels } from '../../providers/notifications/channels';
import { AppError, NotFoundError } from '../../utils/errors';
import { checkOtpRateLimit } from '../../utils/otp';
import { checkSafetySmsBudget, smsDestinationAllowed, type SmsBudgetReason } from '../../utils/sms-budget';
import { log } from '../../utils/logger';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';
import { tripShareCounter, tripShareGauge } from '../../plugins/observability';
import { parseEmergencyPolicy } from '../country/emergency-policy';
import { runWithoutTenant } from '../../plugins/tenant-context';
import { bindTenantTransaction } from '../../plugins/prisma';
import type { NotificationService } from '../notification/notification.service';

// Trip Share (safety spec §6) — a tokenized PUBLIC live-trip page. The token
// is 128-bit CSPRNG and grants ONLY the public payload below, never API
// access. Location comes from the SAME persisted driver fix dispatch and the
// Guardian read (Driver.currentLat/Lng) — server truth, no interpolation; the
// page polls (Socket.IO channel-auth for anonymous share viewers is the
// spec's Centrifugo fiction reconciled to: poll the public read).
//
// Expiry doctrine: a hard mint-time ceiling (MINT_CEILING_HOURS) AND, once
// the trip ends, trip-end + SHARE_GRACE_MINUTES (default 60) — checked at
// read time against the order's REAL state, so a token can never outlive its
// trip by more than the grace even if the ceiling is generous.

const MINT_CEILING_HOURS = 12;

/** [M062] Live links one person may hold for one trip at a time. Minting is
 *  serialized per trip, so racing taps can never exceed it. */
export const MAX_LIVE_SHARES_PER_TRIP = 5;

/**
 * [S-16] The bearer secret is returned ONCE at mint and never stored: the
 * row holds only its sha-256 digest (and a 6-char prefix for support). A
 * database read cannot be replayed as the token; the lookup is by digest and
 * the match is verified in constant time. The public read is rate-limited
 * per token and per caller, invalid lookups from one caller are counted and
 * blocked (enumeration), and the rollback disables public lookup outright —
 * plaintext is never restored.
 */
export const tripShareDigest = (secret: string): string => createHash('sha256').update(secret).digest('hex');
export const tripSharePublicLookupKilled = (env: Record<string, string | undefined> = process.env) => env['TRIP_SHARE_PUBLIC_LOOKUP_KILL'] === '1';
const VIEWS_PER_MINUTE = Number(process.env['TRIP_SHARE_VIEWS_PER_MINUTE'] ?? 60);
const ENUMERATION_MISSES_PER_MINUTE = Number(process.env['TRIP_SHARE_ENUMERATION_MISSES_PER_MINUTE'] ?? 20);
const digestMatches = (secret: string, stored: string): boolean => {
  const a = Buffer.from(tripShareDigest(secret), 'hex'); const b = Buffer.from(stored, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
const SHARE_GRACE_MINUTES = Number(process.env['SHARE_GRACE_MINUTES'] ?? 60);
const TERMINAL: string[] = TERMINAL_ORDER_STATUSES; // ONE definition [order/order-status.ts]

/** [AUD-L4-008] Why a trip-link text was refused, in words the passenger can act on. */
function tripLinkTextRefused(reason: SmsBudgetReason | undefined): AppError {
  switch (reason) {
    case 'destination_country':
      return new AppError(400, 'COUNTRY_NOT_ACTIVE', 'Trip links can only be texted to Guyana (+592) numbers for now. Share the trip another way.');
    case 'recipient_daily':
      return new AppError(429, 'SMS_BUDGET_EXCEEDED', 'You have texted this number too many trip links today. Share the trip another way.');
    case 'sender_daily':
      return new AppError(429, 'SMS_BUDGET_EXCEEDED', 'You have sent too many text messages today. Share the trip another way.');
    case 'safety_daily':
      log().error('[sms-budget] daily safety-text ceiling reached — refusing safety texts until reset');
      return new AppError(429, 'SMS_BUDGET_EXCEEDED', 'Text messages are unavailable right now. Share the trip another way.');
    default:
      return new AppError(429, 'SMS_BUDGET_EXCEEDED', 'This number has received too many messages today.');
  }
}

// Human-worded statuses for the public page — no internal enum leakage.
const PUBLIC_STATUS: Record<string, string> = {
  PENDING: 'Finding a driver',
  ACCEPTED: 'Driver confirmed',
  DRIVER_ASSIGNED: 'Driver assigned',
  DRIVER_EN_ROUTE: 'Driver on the way to pickup',
  DRIVER_ARRIVED: 'Driver has arrived at pickup',
  RIDE_IN_PROGRESS: 'Trip in progress',
  DELIVERED: 'Trip completed',
  COMPLETED: 'Trip completed',
  CANCELLED: 'Trip cancelled',
  REFUNDED: 'Trip cancelled',
  FAILED: 'Trip ended',
};

export class TripShareService {
  constructor(private prisma: PrismaClient, private redis: Redis, private channels: NotificationChannels) {}

  /** Mint a share token for the caller's own ACTIVE taxi trip. Optional
   *  server-side SMS send (spec §6 — works for contacts without smartphones;
   *  the plate rides in the text so it survives an unopened link). The SMS is
   *  a cost/abuse vector, so it wears the same armour as the emergency-contact
   *  handshake: 1/min per target + the safety-text daily budget, and only to
   *  a launch-market number [AUD-L4-008]. */
  async mint(userId: string, orderId: string, opts: { sendToPhone?: string } = {}) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, tenantId: true, customerId: true, orderType: true, status: true,
        driver: { select: { licensePlate: true, vehicleColor: true, vehicleMake: true, vehicleModel: true } },
      },
    });
    // 404-by-absence: a stranger learns nothing about someone else's trip.
    if (!order || order.customerId !== userId) throw new NotFoundError('Trip', orderId);
    if (order.orderType !== 'TAXI') throw new AppError(400, 'NOT_A_TRIP', 'Trip share is for taxi trips.');
    if (TERMINAL.includes(order.status)) throw new AppError(409, 'TRIP_OVER', 'This trip has ended.');
    // [AUD-L4-008] A number that could never be texted is refused before the
    // link exists: nothing is written, counted or sent for it.
    if (opts.sendToPhone && !smsDestinationAllowed(opts.sendToPhone)) throw tripLinkTextRefused('destination_country');

    // [M062] The text is RESERVED before any link exists: the per-number
    // minute and the safety budget are claimed first, so a refused text leaves
    // no orphaned link behind and a link can never be minted past them.
    let budget: Awaited<ReturnType<typeof checkSafetySmsBudget>> | null = null;
    if (opts.sendToPhone) {
      const allowed = await checkOtpRateLimit(this.redis, `tripshare:${opts.sendToPhone}`);
      if (!allowed) throw new AppError(429, 'RATE_LIMITED', 'That number was just sent a link. Try again in a minute.');
      // [AUD-L4-008] The safety budget, never the login one: no flood of login
      // codes can refuse this text, and it spends nobody's login allowance.
      budget = await checkSafetySmsBudget(this.redis, opts.sendToPhone, { senderId: userId });
      if (!budget.allowed) throw tripLinkTextRefused(budget.reason);
    }

    // [S-16] 256-bit URL-safe secret, returned once; only its digest is stored.
    const token = randomBytes(32).toString('base64url');
    let row: { expiresAt: Date };
    try {
      // [M062] One mint per trip at a time (the order row lock): the live-link
      // allowance is counted and the link inserted under it, atomically.
      row = await this.prisma.$transaction(async (tx) => {
        await bindTenantTransaction(tx);
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${order.id} FOR UPDATE`;
        const live = await tx.tripShareToken.count({ where: { orderId: order.id, createdByUserId: userId, revokedAt: null, expiresAt: { gt: new Date() } } });
        if (live >= MAX_LIVE_SHARES_PER_TRIP) {
          throw new AppError(429, 'TOO_MANY_SHARE_LINKS', `You already have ${MAX_LIVE_SHARES_PER_TRIP} live links for this trip. Stop sharing before you share again.`);
        }
        return tx.tripShareToken.create({
          data: {
            tenantId: order.tenantId,
            orderId: order.id,
            createdByUserId: userId,
            token: null,
            tokenDigest: tripShareDigest(token),
            tokenPrefix: token.slice(0, 6),
            sharedToPhone: opts.sendToPhone ?? null,
            expiresAt: new Date(Date.now() + MINT_CEILING_HOURS * 3_600_000),
          },
          select: { expiresAt: true },
        });
      });
    } catch (err) {
      // No link, no text: give the reserved budget back.
      await budget?.refund?.().catch(() => {});
      throw err;
    }
    tripShareCounter.labels('minted').inc();

    const url = `${process.env['APP_PUBLIC_URL'] ?? 'https://swiftgy.com'}/trip/${token}`;
    if (opts.sendToPhone) {
      const plate = order.driver ? ` Vehicle: ${order.driver.vehicleColor} ${order.driver.vehicleMake} ${order.driver.vehicleModel}, plate ${order.driver.licensePlate}.` : '';
      await this.channels.sms.sendSms(
        opts.sendToPhone,
        `A Swift trip is being shared with you. Follow it live: ${url}.${plate}`,
      ).catch(async (err: unknown) => {
        // The share still works via the link the app shows — log, don't fail.
        // A text that never left gives back the budget it counted.
        await budget?.refund?.().catch(() => {});
        log().warn({ err, orderId }, 'trip-share SMS send failed');
      });
    }
    return { token, url, expiresAt: row.expiresAt };
  }

  /** Owner controls use record metadata, never recovered bearer secrets. */
  async listOwned(userId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, customerId: userId, orderType: 'TAXI' }, select: { tenantId: true } });
    if (!order) throw new NotFoundError('Trip', orderId);
    return this.prisma.tripShareToken.findMany({
      where: { orderId, tenantId: order.tenantId, createdByUserId: userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, createdAt: true, expiresAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 100,
    });
  }

  /** Stop ALL links for this owned trip, including links forgotten by a client. */
  async revokeAll(userId: string, orderId: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id: orderId, customerId: userId, orderType: 'TAXI' }, select: { tenantId: true } });
      if (!order) throw new NotFoundError('Trip', orderId);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "orders" WHERE "id" = ${orderId} AND "customerId" = ${userId} AND "tenantId" = ${order.tenantId} FOR UPDATE`);
      await tx.tripShareToken.updateMany({
        where: { orderId, tenantId: order.tenantId, createdByUserId: userId, revokedAt: null }, data: { revokedAt: new Date() },
      });
      return { revoked: true };
    });
  }

  /** Revoke — sharer only. Idempotent. */
  async revoke(userId: string, token: string) {
    const row = await this.prisma.tripShareToken.findUnique({ where: { tokenDigest: tripShareDigest(token) }, select: { id: true, createdByUserId: true, revokedAt: true, tokenDigest: true } });
    if (!row || row.createdByUserId !== userId || !row.tokenDigest || !digestMatches(token, row.tokenDigest)) throw new NotFoundError('Share', token.slice(0, 6));
    if (!row.revokedAt) {
      await this.prisma.tripShareToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    }
    return { revoked: true };
  }

  /** The UNAUTHENTICATED public read (spec §6). Returns null for anything
   *  invalid — expired, revoked, unknown — indistinguishably (no oracle).
   *  Payload law: passenger FIRST NAME only; driver first name + photo +
   *  vehicle + plate; human status; live fix only while the trip is active.
   *  No addresses, no phone numbers, no ids. */
  async publicView(token: string, now = new Date(), caller?: string) {
    // [S-16] Rollback: public lookup off — never plaintext back on.
    if (tripSharePublicLookupKilled()) { tripShareCounter.labels('lookup_killed').inc(); return null; }
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) { await this.recordMiss(caller); return null; }
    // A caller that keeps guessing is blocked; a caller that keeps reading is throttled.
    if (caller && !(await this.callerAllowed(caller))) { tripShareCounter.labels('blocked').inc(); return null; }
    const row = await this.prisma.tripShareToken.findUnique({
      where: { tokenDigest: tripShareDigest(token) },
      select: {
        id: true, expiresAt: true, revokedAt: true, viewCount: true, tokenDigest: true,
        order: {
          select: {
            status: true, updatedAt: true, deliveredAt: true, currencyCode: true,
            customer: { select: { firstName: true } },
            driver: {
              select: {
                currentLat: true, currentLng: true, lastLocationUpdate: true,
                vehicleMake: true, vehicleModel: true, vehicleColor: true, licensePlate: true,
                user: { select: { firstName: true } },
              },
            },
          },
        },
      },
    });
    if (!row || !row.tokenDigest || !digestMatches(token, row.tokenDigest)) { await this.recordMiss(caller); return null; }
    if (row.revokedAt || now >= row.expiresAt) return null;
    if (!(await this.viewAllowed(row.id, caller))) { tripShareCounter.labels('rate_limited').inc(); return null; }
    tripShareCounter.labels('viewed').inc();

    const order = row.order;
    const ended = TERMINAL.includes(order.status);
    if (ended) {
      const endedAt = order.deliveredAt ?? order.updatedAt;
      if (now.getTime() > endedAt.getTime() + SHARE_GRACE_MINUTES * 60_000) return null; // grace over
    }

    // View counting is best-effort — never blocks the page.
    void this.prisma.tripShareToken.update({
      where: { id: row.id },
      data: { viewCount: { increment: 1 }, lastViewedAt: now },
    }).catch(() => {});

    const d = order.driver;
    return {
      status: PUBLIC_STATUS[order.status] ?? 'Trip in progress',
      ended,
      passengerFirstName: order.customer.firstName,
      driver: d
        ? {
            firstName: d.user.firstName,
            // [M053] A profile photo field is whatever the mover's record holds —
            // a third-party URL, or another file's storage key. A public page
            // shows neither: the recipient identifies the car by its plate,
            // colour and model below.
            photoUrl: null,
            vehiclePhotoUrl: null,
            vehicle: `${d.vehicleColor} ${d.vehicleMake} ${d.vehicleModel}`,
            plate: d.licensePlate,
          }
        : null,
      location: !ended && d?.currentLat != null && d?.currentLng != null
        ? { lat: d.currentLat, lng: d.currentLng, at: d.lastLocationUpdate }
        : null,
      ...(await this.emergencyFor(order.currencyCode)),
    };
  }

  /**
   * [L10 §2] The emergency line this public page shows comes from the ONE
   * server setting the phone dials from: the market's CountryConfig emergency
   * policy (MOB-018), which admins read on the markets screen. A number is
   * offered only when ops verified it; otherwise the page says to call the
   * local emergency number. It used to be a hard-coded pair of numbers that no
   * setting held and nobody had verified.
   */
  private async emergencyFor(currencyCode: string): Promise<{ emergencyNote: string; emergencyDial: string | null }> {
    const market = await this.prisma.countryConfig.findFirst({ where: { currencyCode }, orderBy: { code: 'asc' }, select: { code: true, emergency: true } }).catch(() => null);
    const police = market ? parseEmergencyPolicy(market.code, market.emergency).policy?.numbers.police : undefined;
    return police?.verified
      ? { emergencyNote: `If something is wrong, call the police on ${police.number}.`, emergencyDial: police.number }
      : { emergencyNote: 'If something is wrong, call your local emergency number.', emergencyDial: null };
  }

  /** Views per minute per token (and per caller when known). */
  private async viewAllowed(rowId: string, caller?: string): Promise<boolean> {
    const keys = [`tripshare:views:${rowId}`, ...(caller ? [`tripshare:caller:${caller}`] : [])];
    for (const key of keys) {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, 60);
      if (n > VIEWS_PER_MINUTE) return false;
    }
    return true;
  }

  /** An invalid lookup is a miss; too many from one caller is enumeration. */
  private async recordMiss(caller?: string): Promise<void> {
    tripShareCounter.labels('miss').inc();
    if (!caller) return;
    const key = `tripshare:misses:${caller}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 60);
    if (n === ENUMERATION_MISSES_PER_MINUTE + 1) {
      tripShareCounter.labels('enumeration').inc();
      await this.redis.set(`tripshare:blocked:${caller}`, '1', 'EX', 600);
      log().error({ caller, misses: n }, '[S-16] trip-share token enumeration — caller blocked for 10 minutes');
    }
  }

  private async callerAllowed(caller: string): Promise<boolean> {
    return (await this.redis.get(`tripshare:blocked:${caller}`)) === null;
  }
}

/** [S-16 · operations] Every legacy plaintext token is a live exposure: it is
 *  revoked, its plaintext nulled (the digest stays as the record), and the
 *  sharer is told to share again. Idempotent; runs from the tick until none
 *  is left. Dual-read was the backfilled digest — plaintext is never read. */
export async function rotateLegacyTripShareTokens(prisma: PrismaClient, notifications: NotificationService, limit = 100): Promise<{ rotated: number; remaining: number }> {
  const legacy = await prisma.tripShareToken.findMany({ where: { token: { not: null } }, select: { id: true, orderId: true, createdByUserId: true, revokedAt: true, expiresAt: true }, take: limit });
  let rotated = 0;
  for (const row of legacy) {
    const now = new Date();
    const live = !row.revokedAt && row.expiresAt > now;
    await prisma.tripShareToken.update({ where: { id: row.id }, data: { token: null, rotatedAt: now, ...(live ? { revokedAt: now } : {}) } });
    rotated += 1; tripShareCounter.labels('legacy_rotated').inc();
    if (live) {
      await notifications.send({
        userId: row.createdByUserId,
        type: 'SAFETY',
        title: 'Your trip share link was reset',
        body: 'For your safety we replaced how share links are stored. The link you sent no longer works — share your trip again from the app.',
        data: { kind: 'trip_share_rotated', orderId: row.orderId },
      }).catch(() => null);
    }
  }
  const remaining = await prisma.tripShareToken.count({ where: { token: { not: null } } });
  tripShareGauge.labels('legacy_plaintext_remaining').set(remaining);
  return { rotated, remaining };
}

/**
 * [L10 §2 · coordinator ruling 5 Oct 2026] When the monitoring a rider gave
 * someone ends, that person is told how — but only through Swift itself. A
 * trip shared by text to the number of a signed-in Swift user (the "guardian")
 * gets an in-app notice: the rider stopped sharing, the trip was completed or
 * cancelled, or the link ran out before Swift saw the trip finish (contact
 * lost). The public link stays deliberately silent: a revoked or expired link
 * answers exactly like an unknown one (stalker safety), so nothing here
 * changes what a link holder sees.
 *
 * A sweep, not a hook: one place sees every ending (a stop, stop-all, a trip
 * finishing on any path, a link running out). Each link's notice is sent at
 * most once (keyed per link); a legacy row Swift rotated is never reported as
 * the rider's choice.
 */
export type GuardianOutcome = 'STOPPED_BY_RIDER' | 'COMPLETED' | 'CANCELLED' | 'LOST_CONTACT' | 'ENDED';
const GUARDIAN_WINDOW_MS = 2 * 3_600_000;

export function guardianOutcome(
  row: { revokedAt: Date | null; expiresAt: Date; order: { status: string; deliveredAt: Date | null; updatedAt: Date } },
  now: Date,
): GuardianOutcome | null {
  const ended = TERMINAL.includes(row.order.status);
  const endedAt = ended ? row.order.deliveredAt ?? row.order.updatedAt : null;
  if (row.revokedAt && (!endedAt || row.revokedAt < endedAt)) return 'STOPPED_BY_RIDER';
  if (endedAt) {
    if (row.order.status === 'DELIVERED' || row.order.status === 'COMPLETED') return 'COMPLETED';
    if (row.order.status === 'CANCELLED' || row.order.status === 'REFUNDED') return 'CANCELLED';
    return 'ENDED';
  }
  if (row.expiresAt <= now) return 'LOST_CONTACT';
  return null;
}

function guardianNotice(outcome: GuardianOutcome, name: string): { title: string; body: string } {
  switch (outcome) {
    case 'STOPPED_BY_RIDER': return { title: `${name} stopped sharing their trip`, body: 'You can no longer follow this trip.' };
    case 'COMPLETED': return { title: `${name}'s trip was completed`, body: 'The trip they shared with you has finished.' };
    case 'CANCELLED': return { title: `${name}'s trip was cancelled`, body: 'The trip they shared with you was cancelled.' };
    case 'LOST_CONTACT': return { title: `Sharing of ${name}'s trip ended before it finished`, body: `Swift did not see this trip finish before the link ran out. Contact ${name} directly to check they are OK.` };
    default: return { title: `${name}'s trip has ended`, body: 'The trip they shared with you has ended.' };
  }
}

export async function notifyTripShareGuardians(prisma: PrismaClient, notifications: NotificationService, now = new Date()): Promise<{ notified: number }> {
  const since = new Date(now.getTime() - GUARDIAN_WINDOW_MS);
  const rows = await runWithoutTenant(() => prisma.tripShareToken.findMany({
    where: {
      sharedToPhone: { not: null },
      rotatedAt: null,
      OR: [
        { revokedAt: { gte: since } },
        { expiresAt: { gte: since, lte: now } },
        { order: { status: { in: TERMINAL as never }, updatedAt: { gte: since } } },
      ],
    },
    select: {
      id: true, createdByUserId: true, sharedToPhone: true, revokedAt: true, expiresAt: true,
      order: { select: { status: true, deliveredAt: true, updatedAt: true, customer: { select: { firstName: true } } } },
    },
    take: 500,
  }), 'trip-share-guardian-outcome');
  let notified = 0;
  for (const row of rows) {
    const outcome = guardianOutcome(row, now);
    if (!outcome) continue;
    const guardian = await runWithoutTenant(() => prisma.user.findFirst({
      where: { phone: row.sharedToPhone!, isPhoneVerified: true, status: 'ACTIVE', id: { not: row.createdByUserId } },
      select: { id: true },
    }), 'trip-share-guardian-outcome');
    if (!guardian) continue; // not a Swift user: the text they got is all they have, and the link stays silent
    const notice = guardianNotice(outcome, row.order.customer.firstName || 'Someone');
    const id = await notifications.send({
      userId: guardian.id,
      type: 'SAFETY',
      ...notice,
      // No order id: the guardian follows a trip, they do not own one.
      data: { kind: 'trip_share_ended', outcome },
      dedupeKey: `trip-share-ended:${row.id}`,
    }).catch((err: unknown) => { log().warn({ err, tripShareId: row.id }, '[L10 §2] guardian outcome notice failed — retried next sweep'); return null; });
    if (id) { notified += 1; tripShareCounter.labels(`guardian_${outcome.toLowerCase()}`).inc(); }
  }
  return { notified };
}
