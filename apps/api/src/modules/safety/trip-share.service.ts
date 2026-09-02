import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { NotificationChannels } from '../../providers/notifications/channels';
import { AppError, NotFoundError } from '../../utils/errors';
import { checkOtpRateLimit } from '../../utils/otp';
import { checkOtpDailyBudget } from '../../utils/sms-budget';
import { log } from '../../utils/logger';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';
import { tripShareCounter, tripShareGauge } from '../../plugins/observability';
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
   *  handshake: 1/min per target + the shared daily budget. */
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

    // [S-16] 256-bit URL-safe secret, returned once; only its digest is stored.
    const token = randomBytes(32).toString('base64url');
    const row = await this.prisma.tripShareToken.create({
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
    });
    tripShareCounter.labels('minted').inc();

    const url = `${process.env['APP_PUBLIC_URL'] ?? 'https://swift.gy'}/trip/${token}`;
    if (opts.sendToPhone) {
      const allowed = await checkOtpRateLimit(this.redis, `tripshare:${opts.sendToPhone}`);
      if (!allowed) throw new AppError(429, 'RATE_LIMITED', 'That number was just sent a link. Try again in a minute.');
      const budget = await checkOtpDailyBudget(this.redis, opts.sendToPhone);
      if (!budget.allowed) throw new AppError(429, 'SMS_BUDGET_EXCEEDED', 'This number has received too many messages today.');
      const plate = order.driver ? ` Vehicle: ${order.driver.vehicleColor} ${order.driver.vehicleMake} ${order.driver.vehicleModel}, plate ${order.driver.licensePlate}.` : '';
      await this.channels.sms.sendSms(
        opts.sendToPhone,
        `A Swift trip is being shared with you. Follow it live: ${url}.${plate}`,
      ).catch((err: unknown) => {
        // The share still works via the link the app shows — log, don't fail.
        log().warn({ err, orderId }, 'trip-share SMS send failed');
      });
    }
    return { token, url, expiresAt: row.expiresAt };
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
            status: true, updatedAt: true, deliveredAt: true,
            customer: { select: { firstName: true } },
            driver: {
              select: {
                currentLat: true, currentLng: true, lastLocationUpdate: true,
                vehicleMake: true, vehicleModel: true, vehicleColor: true, licensePlate: true,
                profilePhotoUrl: true, vehiclePhotoUrl: true,
                user: { select: { firstName: true } },
              },
            },
          },
        },
      },
    });
    if (!row || !row.tokenDigest || !digestMatches(token, row.tokenDigest)) { await this.recordMiss(caller); return null; }
    if (row.revokedAt || now > row.expiresAt) return null;
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
            photoUrl: d.profilePhotoUrl,
            vehiclePhotoUrl: d.vehiclePhotoUrl,
            vehicle: `${d.vehicleColor} ${d.vehicleMake} ${d.vehicleModel}`,
            plate: d.licensePlate,
          }
        : null,
      location: !ended && d?.currentLat != null && d?.currentLng != null
        ? { lat: d.currentLat, lng: d.currentLng, at: d.lastLocationUpdate }
        : null,
      emergencyNote: 'If something is wrong, call 911 (Guyana: +592-225-8196).',
    };
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
