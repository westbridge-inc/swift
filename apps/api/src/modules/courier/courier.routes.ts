import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { estimateCourierFee, mergeCourierRates, type CourierRates, type PackageSize, type DeliverySpeed } from './courier.service';
import { CountryConfigService } from '../country/country-config.service';
import { getMapsProvider } from '../../providers/maps/maps-provider';
import { makeDispatchService } from '../dispatch/dispatch.service';
import { OrderService, holdWindowMs } from '../order/order.service';
import { NotificationService } from '../notification/notification.service';
import { orderingRestriction } from '../cash/cash-rules.service';
import { generateOrderNumber } from '../../utils/markup';
import { AppError, NotFoundError } from '../../utils/errors';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { ALLOWED_IMAGE_TYPES, looksLikeImage } from '../../utils/images';
import type { OrderStatus } from '@prisma/client';
import { lockActiveOrderCustomer } from '../order/order-creation-authority';

// ---------------------------------------------------------------------------
// Module C: Courier (spec §4.3) — send a parcel person-to-person. A non-cart
// order (no vendor): pickup != dropoff, third-party recipient, size-based fee,
// dispatched to the shared rider pool. 100% of the fee is the rider's earning;
// Swift's revenue is the rider's weekly subscription. Cash, recorded only.
// ---------------------------------------------------------------------------

const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
const sizeSchema = z.enum(['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE']);
const speedSchema = z.enum(['STANDARD', 'EXPRESS', 'RUSH']).default('STANDARD');

const estimateSchema = z.object({
  pickup: pointSchema,
  dropoff: pointSchema,
  packageSize: sizeSchema,
  speed: speedSchema,
});

const orderSchema = z.object({
  pickup: pointSchema,
  dropoff: pointSchema,
  pickupAddress: z.string().trim().min(3).max(200),
  dropoffAddress: z.string().trim().min(3).max(200),
  packageSize: sizeSchema,
  packageDescription: z.string().trim().max(500).optional(),
  packagePhotoUrl: z.string().max(2048).optional(),
  speed: speedSchema,
  recipientName: z.string().trim().min(2).max(120),
  recipientPhone: z.string().trim().min(5).max(30),
  payer: z.enum(['SENDER', 'RECIPIENT']).default('SENDER'),
});

const cancelSchema = z.object({ reason: z.string().max(500).optional() });
const proofSchema = z.object({ proofPhotoUrl: z.string().min(5).max(2048) });

/** Sender cancellation is safe only before the parcel enters rider custody.
 * Once picked up, a parcel needs an explicit return-to-sender/ops recovery
 * flow; terminal cancellation would otherwise free a rider who still holds it.
 * The canonical transition seam independently enforces physical custody under
 * the order-row lock, closing pickup-vs-cancel races. */
const COURIER_CANCELLABLE_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'RIDER_ASSIGNED',
  'RIDER_EN_ROUTE_PICKUP',
  'RIDER_ARRIVED_PICKUP',
] as const satisfies readonly OrderStatus[];

const COURIER_CUSTODY_STATUSES = [
  'PICKED_UP',
  'EN_ROUTE_DELIVERY',
  'ARRIVED',
] as const satisfies readonly OrderStatus[];

/** Proof keeps the historical full live-state list; cancellation deliberately
 * uses the narrower pre-custody list above. */
const COURIER_LIVE_STATUSES = [
  ...COURIER_CANCELLABLE_STATUSES,
  ...COURIER_CUSTODY_STATUSES,
] as const satisfies readonly OrderStatus[];

function courierNotCancellable(status: OrderStatus): AppError {
  if ((COURIER_CUSTODY_STATUSES as readonly OrderStatus[]).includes(status)) {
    return new AppError(
      409,
      'PARCEL_IN_CUSTODY',
      'This parcel has already been picked up. Contact support to arrange return-to-sender or delivery recovery.',
    );
  }
  return new AppError(409, 'NOT_CANCELLABLE', 'This courier job can no longer be cancelled');
}

const courierMaps = getMapsProvider();

async function quote(
  pickup: { lat: number; lng: number },
  dropoff: { lat: number; lng: number },
  size: PackageSize,
  speed: DeliverySpeed,
  rates?: CourierRates,
) {
  // Real road km when OSRM is configured; deterministic estimate otherwise.
  const { km: distanceKm } = await courierMaps.routeKm(pickup, dropoff);
  return { distanceKm, estimate: estimateCourierFee(distanceKm, size, speed, rates) };
}

export default async function courierRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const dispatch = makeDispatchService(app);
  const orderService = new OrderService(app.prisma, app.io);
  const notifications = new NotificationService(app.prisma, app.io);
  const storage = getStorageProvider();

  // Per-country courier pricing [UG-CRAFT-03]: the caller's market decides
  // the rates; null config = the code defaults (byte-identical to before).
  const countryConfig = new CountryConfigService(app.prisma);
  async function ratesFor(userId: string): Promise<CourierRates> {
    try {
      const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { countryCode: true } });
      const cfg = await countryConfig.getByCode(user?.countryCode ?? 'GY');
      return mergeCourierRates(cfg.courierRates);
    } catch {
      return mergeCourierRates(null); // config lookup must never break a quote
    }
  }

  /** POST /estimate — price quote (size + distance + speed) before requesting. */
  app.post('/estimate', auth, async (request) => {
    const body = estimateSchema.parse(request.body);
    const { distanceKm, estimate } = await quote(body.pickup, body.dropoff, body.packageSize, body.speed, await ratesFor(request.user.userId));
    return { success: true, data: { ...estimate, distanceKm: Math.round(distanceKm * 10) / 10 } };
  });

  /** POST /order — create the courier job at the quoted fee and dispatch a rider. */
  app.post('/order', auth, async (request, reply) => {
    const body = orderSchema.parse(request.body);
    const userId = request.user.userId;
    const customer = await app.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { tenantId: true },
    });

    const restriction = await orderingRestriction(app.prisma, userId);
    if (restriction === 'banned') {
      throw new AppError(403, 'ACCOUNT_RESTRICTED', 'Courier is disabled on this account after repeated failed payments. Contact support.');
    }

    const { distanceKm, estimate } = await quote(body.pickup, body.dropoff, body.packageSize, body.speed, await ratesFor(userId));

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCount = await app.prisma.order.count({ where: { placedAt: { gte: today } } });

    const order = await app.prisma.$transaction(async (tx) => {
      await lockActiveOrderCustomer(tx, userId, customer.tenantId);
      return tx.order.create({
        data: {
          tenantId: customer.tenantId,
          orderNumber: generateOrderNumber(todayCount + 1),
          orderType: 'COURIER',
          customerId: userId,
          // No vendor prep step — the parcel is ready, so dispatch can run at once
          // (or at hold release when LIFECYCLE_V2 keeps the free-cancel window open).
          status: 'READY_FOR_PICKUP',
          holdExpiresAt: holdWindowMs() != null ? new Date(Date.now() + holdWindowMs()!) : null,
          fulfillment: 'DELIVERY',
          pickupAddress: body.pickupAddress,
          pickupLat: body.pickup.lat,
          pickupLng: body.pickup.lng,
          deliveryAddress: body.dropoffAddress,
          deliveryLat: body.dropoff.lat,
          deliveryLng: body.dropoff.lng,
          courierPackageSize: body.packageSize,
          courierPackageDescription: body.packageDescription,
          courierPackagePhotoUrl: body.packagePhotoUrl,
          courierSpeed: body.speed,
          // SWIFT-061: EXPRESS/RUSH are priced ×1.5/×2 — make the priority REAL, not
          // just a surcharge. isExpress is the ONE dispatch-priority flag (same as a
          // food EXPRESS order): 12s offers, 45s redispatch, sorted first on the board.
          isExpress: body.speed !== 'STANDARD',
          courierRecipientName: body.recipientName,
          courierRecipientPhone: body.recipientPhone,
          courierPayer: body.payer,
          courierTrackingToken: nanoid(16),
          subtotalBase: 0,
          subtotalMarkup: 0,
          subtotalCustomer: 0,
          // The whole courier fee is the rider's earning (100%).
          deliveryFee: estimate.totalFee,
          totalAmount: estimate.totalFee,
          estimatedDeliveryTime: estimate.estimatedMinutes,
          paymentMethod: 'CASH',
          statusHistory: {
            create: { status: 'READY_FOR_PICKUP', changedBy: userId, note: `Courier requested — fee $${estimate.totalFee}` },
          },
        },
      });
    });

    // Held courier jobs dispatch at release (the worker enqueues); otherwise now.
    // SWIFT-097: enqueue the first-pass dispatch like taxi does (SWIFT-AUD-D6-08),
    // instead of awaiting the offer cascade inline — the cascade does ETA
    // round-trips that would pin this handler (and a DB connection) open. The
    // client listens for the dispatch:offer socket event either way. Inline
    // fallback when no queue is up (tests / degraded boot).
    if (!order.holdExpiresAt) {
      if (app.dispatchQueue) {
        await app.dispatchQueue.add('dispatch-order', { orderId: order.id }, {
          priority: 5,
          removeOnComplete: 100,
          removeOnFail: 50,
        });
      } else {
        await dispatch.dispatchOrder(order.id);
      }
    }

    reply.code(201);
    return {
      success: true,
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        fee: estimate.totalFee,
        distanceKm: Math.round(distanceKm * 10) / 10,
        trackingToken: order.courierTrackingToken,
        trackingUrl: `/courier/track/${order.courierTrackingToken}`,
      },
    };
  });

  /** GET /orders — the sender's courier history. */
  app.get('/orders', auth, async (request) => {
    const orders = await app.prisma.order.findMany({
      where: { customerId: request.user.userId, orderType: 'COURIER' },
      orderBy: { placedAt: 'desc' },
      take: 50,
    });
    return { success: true, data: orders };
  });

  /** GET /order/:id — sender's courier job detail. */
  app.get('/order/:id', auth, async (request) => {
    const { id } = request.params as { id: string };
    const order = await app.prisma.order.findFirst({
      where: { id, customerId: request.user.userId, orderType: 'COURIER' },
      include: { rider: { include: { user: { select: { firstName: true, lastName: true, phone: true } } } } },
    });
    if (!order) throw new NotFoundError('CourierOrder', id);
    return { success: true, data: order };
  });

  /** GET /track/:token — public recipient tracking link (no auth, opaque token). */
  app.get('/track/:token', async (request) => {
    const { token } = request.params as { token: string };
    const order = await app.prisma.order.findUnique({
      where: { courierTrackingToken: token },
      select: {
        orderNumber: true,
        status: true,
        courierRecipientName: true,
        pickupAddress: true,
        deliveryAddress: true,
        estimatedDeliveryTime: true,
        rider: { select: { currentLat: true, currentLng: true, user: { select: { firstName: true } } } },
      },
    });
    if (!order) throw new NotFoundError('CourierOrder', token);
    return { success: true, data: order };
  });

  /** POST /order/:id/cancel — sender cancels before rider pickup. */
  app.post('/order/:id/cancel', auth, async (request) => {
    const { id } = request.params as { id: string };
    const body = cancelSchema.parse(request.body ?? {});
    const order = await app.prisma.order.findFirst({
      where: { id, customerId: request.user.userId, orderType: 'COURIER' },
    });
    if (!order) throw new NotFoundError('CourierOrder', id);
    if (['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(order.status)) {
      throw new AppError(400, 'NOT_CANCELLABLE', `A ${order.status.toLowerCase()} courier job cannot be cancelled`);
    }
    if ((COURIER_CUSTODY_STATUSES as readonly OrderStatus[]).includes(order.status)) {
      throw courierNotCancellable(order.status);
    }
    const reason = body.reason ?? 'Cancelled by sender';
    // Status/cancellation evidence + search/booking closure + float/mover
    // release + immutable log are one commit. Proof races on the same row lock.
    const { order: updated } = await orderService.transitionOrderAtomically({
      orderId: id,
      target: 'CANCELLED',
      allowedFrom: COURIER_CANCELLABLE_STATUSES,
      changedBy: request.user.userId,
      note: reason,
      cancellation: { by: request.user.userId, reason },
      releaseStaleMoverPointer: true,
      invalidStatus: courierNotCancellable,
    });

    try {
      app.io.to(`order:${id}`).emit('order:status_changed', { orderId: id, status: 'CANCELLED', timestamp: new Date().toISOString() });
    } catch (error) {
      request.log.warn({ err: error, orderId: id }, 'courier cancellation socket publication failed after commit');
    }
    if (updated.rider?.userId) {
      await notifications.send({
        userId: updated.rider.userId,
        type: 'ORDER_UPDATE',
        title: 'Courier job cancelled',
        body: `The sender cancelled ${updated.orderNumber}. You are back in the dispatch pool.`,
        data: { orderId: id, status: 'CANCELLED' },
      })
        .catch((error) => request.log.warn({ err: error, orderId: id }, 'courier cancellation notification failed after commit'));
    }

    return { success: true, data: updated };
  });

  /** POST /order/:id/proof-photo — the assigned rider uploads the delivery photo
   *  (magic-byte checked, stored in a public folder), then confirms the handoff
   *  via /proof with the returned url. Two steps keep the CAS handoff transition
   *  (and its concurrency test) untouched. Proof photos are delivery-confirmation
   *  images, not KYC — public like item photos, never the private document path. */
  app.post<{ Params: { id: string } }>('/order/:id/proof-photo', auth, async (request) => {
    const { id } = request.params;
    const rider = await app.prisma.rider.findUnique({ where: { userId: request.user.userId }, select: { id: true } });
    if (!rider) throw new NotFoundError('Rider');
    const order = await app.prisma.order.findFirst({
      where: { id, orderType: 'COURIER', riderId: rider.id },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundError('CourierOrder', id);
    if (['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(order.status)) {
      throw new AppError(400, 'NOT_IN_TRANSIT', 'This courier job is already closed');
    }

    const file = await request.file();
    if (!file) throw new AppError(400, 'NO_FILE', 'Attach a photo of the delivery');
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      throw new AppError(400, 'BAD_IMAGE_TYPE', 'Only JPEG, PNG or WebP images are accepted');
    }
    const buffer = await file.toBuffer();
    if (!looksLikeImage(buffer)) {
      throw new AppError(400, 'BAD_IMAGE', 'File content does not match an image format');
    }

    const { url } = await storage.upload({ buffer, filename: file.filename, mimeType: file.mimetype, folder: `courier-proof/${id}` });
    return { success: true, data: { url } };
  });

  /** POST /order/:id/proof — the assigned rider confirms handoff with proof. */
  app.post('/order/:id/proof', auth, async (request) => {
    const { id } = request.params as { id: string };
    const body = proofSchema.parse(request.body);
    const rider = await app.prisma.rider.findUnique({ where: { userId: request.user.userId }, select: { id: true } });
    if (!rider) throw new NotFoundError('Rider');
    const order = await app.prisma.order.findFirst({ where: { id, orderType: 'COURIER', riderId: rider.id } });
    if (!order) throw new NotFoundError('CourierOrder', id);
    if (['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(order.status)) {
      throw new AppError(400, 'NOT_IN_TRANSIT', 'This courier job is already closed');
    }
    // Proof metadata, DELIVERED, rider release/count, float, earnings, and the
    // immutable log commit atomically. A retry after any pre-commit failure
    // sees the original live state and cannot double-pay or double-count.
    const { order: updated } = await orderService.transitionOrderAtomically({
      orderId: id,
      target: 'DELIVERED',
      allowedFrom: COURIER_LIVE_STATUSES,
      changedBy: request.user.userId,
      note: 'Proof of delivery captured',
      terminalMetadata: { courierProofPhotoUrl: body.proofPhotoUrl },
      invalidStatus: () => new AppError(409, 'NOT_IN_TRANSIT', 'This courier job is already closed'),
    });

    try {
      app.io.to(`order:${id}`).emit('order:status_changed', { orderId: id, status: 'DELIVERED', timestamp: new Date().toISOString() });
    } catch (error) {
      request.log.warn({ err: error, orderId: id }, 'courier proof socket publication failed after commit');
    }
    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Parcel delivered',
      body: `${order.orderNumber} was handed to ${order.courierRecipientName ?? 'the recipient'} — proof photo captured.`,
      data: { orderId: id, status: 'DELIVERED' },
    }).catch((error) => request.log.warn({ err: error, orderId: id }, 'courier proof notification failed after commit'));

    return { success: true, data: { ...updated, totalDeliveries: updated.rider?.totalDeliveries ?? null } };
  });
}
