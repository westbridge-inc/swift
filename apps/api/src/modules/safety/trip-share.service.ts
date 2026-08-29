import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { NotificationChannels } from '../../providers/notifications/channels';
import { AppError, NotFoundError } from '../../utils/errors';
import { checkOtpRateLimit } from '../../utils/otp';
import { checkOtpDailyBudget } from '../../utils/sms-budget';
import { log } from '../../utils/logger';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';

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

    const token = randomBytes(16).toString('base64url'); // 128-bit, URL-safe
    const row = await this.prisma.tripShareToken.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        createdByUserId: userId,
        token,
        sharedToPhone: opts.sendToPhone ?? null,
        expiresAt: new Date(Date.now() + MINT_CEILING_HOURS * 3_600_000),
      },
    });

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
    return { token: row.token, url, expiresAt: row.expiresAt };
  }

  /** Revoke — sharer only. Idempotent. */
  async revoke(userId: string, token: string) {
    const row = await this.prisma.tripShareToken.findUnique({ where: { token }, select: { id: true, createdByUserId: true, revokedAt: true } });
    if (!row || row.createdByUserId !== userId) throw new NotFoundError('Share', token);
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
  async publicView(token: string, now = new Date()) {
    const row = await this.prisma.tripShareToken.findUnique({
      where: { token },
      select: {
        id: true, expiresAt: true, revokedAt: true, viewCount: true,
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
    if (!row || row.revokedAt || now > row.expiresAt) return null;

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
}
