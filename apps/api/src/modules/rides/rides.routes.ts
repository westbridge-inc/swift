import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FareService } from './fare.service';
import { OrderService } from '../order/order.service';
import { CountryConfigService } from '../country/country-config.service';
import { makeDispatchService } from '../dispatch/dispatch.service';
import { orderingRestriction } from '../cash/cash-rules.service';
import { generateOrderNumber } from '../../utils/markup';
import { AppError, NotFoundError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// Taxi (master plan §4.2): the fare is computed and SHOWN before any driver
// sees the request, drivers come from the shared dispatch engine, and the
// ride PIN guards pickup. Cash, recorded only.
// ---------------------------------------------------------------------------

const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const estimateSchema = z.object({
  pickup: pointSchema,
  dropoff: pointSchema,
});

const requestRideSchema = z.object({
  pickup: pointSchema,
  dropoff: pointSchema,
  pickupAddress: z.string().trim().min(3).max(200),
  dropoffAddress: z.string().trim().min(3).max(200),
  passengerCount: z.number().int().min(1).max(6).default(1),
});

const cancelSchema = z.object({
  reason: z.string().max(500).optional(),
});

export async function ridesRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const fareService = new FareService(app.prisma);
  const orderService = new OrderService(app.prisma, app.io);
  const countryConfig = new CountryConfigService(app.prisma);
  const dispatch = makeDispatchService(app);

  /** POST /estimate — the exact fare, before anything is requested. */
  app.post('/estimate', auth, async (request) => {
    const body = estimateSchema.parse(request.body);
    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: request.user.userId },
      select: { countryCode: true },
    });
    const estimate = await fareService.estimate(body.pickup, body.dropoff, user.countryCode);
    return { success: true, data: estimate };
  });

  /** POST /request — create the ride at the quoted fare and start dispatch. */
  app.post('/request', auth, async (request, reply) => {
    const body = requestRideSchema.parse(request.body);
    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: request.user.userId },
      select: { id: true, countryCode: true, trustLevel: true },
    });

    const active = await app.prisma.order.findFirst({
      where: {
        customerId: user.id,
        orderType: 'TAXI',
        status: { in: ['PENDING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'] },
      },
      select: { id: true },
    });
    if (active) {
      throw new AppError(409, 'RIDE_IN_PROGRESS', 'You already have an active ride');
    }

    // Strike consequences apply to rides exactly as to deliveries
    const restriction = await orderingRestriction(app.prisma, user.id);
    if (restriction === 'banned') {
      throw new AppError(403, 'ACCOUNT_RESTRICTED', 'Rides are disabled on this account after repeated failed payments. Contact support.');
    }
    if (restriction === 'restricted') {
      throw new AppError(403, 'STRIKE_RESTRICTED', 'After repeated failed payments, rides require ID verification. Verify your identity to continue.');
    }

    const estimate = await fareService.estimate(body.pickup, body.dropoff, user.countryCode);

    // Same ID-gate as checkout: big cash rides need an ID-verified account
    const gateLocal = await countryConfig.getIdGateThresholdLocal(user.countryCode);
    if (user.trustLevel === 'L1' && estimate.fare >= gateLocal) {
      throw new AppError(403, 'ID_VERIFICATION_REQUIRED',
        `Rides of $${Math.round(gateLocal).toLocaleString()} ${estimate.currencyCode} or more need ID verification.`,
        { threshold: gateLocal, fare: estimate.fare });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCount = await app.prisma.order.count({ where: { placedAt: { gte: today } } });

    // PIN is verified by the driver at pickup (mandatory for taxi)
    const ridePin = String(Math.floor(1000 + Math.random() * 9000));

    const order = await app.prisma.order.create({
      data: {
        orderNumber: generateOrderNumber(todayCount + 1),
        orderType: 'TAXI',
        customerId: user.id,
        status: 'PENDING',
        pickupAddress: body.pickupAddress,
        pickupLat: body.pickup.lat,
        pickupLng: body.pickup.lng,
        deliveryAddress: body.dropoffAddress,
        deliveryLat: body.dropoff.lat,
        deliveryLng: body.dropoff.lng,
        taxiPickupAddress: body.pickupAddress,
        taxiDropoffAddress: body.dropoffAddress,
        taxiPassengerCount: body.passengerCount,
        taxiDistance: estimate.distanceKm,
        taxiDuration: estimate.durationMin,
        taxiFareTotal: estimate.fare,
        subtotalBase: estimate.fare,
        subtotalMarkup: 0,
        subtotalCustomer: estimate.fare,
        deliveryFee: 0,
        totalAmount: estimate.fare,
        paymentMethod: 'CASH',
        ridePin,
        statusHistory: {
          create: { status: 'PENDING', changedBy: user.id, note: `Ride requested — fixed fare $${estimate.fare}` },
        },
      },
    });

    // Shared dispatch engine, driver pool — same cascade, same atomicity
    await dispatch.dispatchOrder(order.id);

    reply.code(201);
    return {
      success: true,
      data: {
        ride: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          fare: estimate.fare,
          currencyCode: estimate.currencyCode,
          fareSource: estimate.source,
          distanceKm: estimate.distanceKm,
          durationMin: estimate.durationMin,
          ridePin,
          pickupAddress: body.pickupAddress,
          dropoffAddress: body.dropoffAddress,
        },
        message: 'Looking for a driver near you…',
      },
    };
  });

  /** GET /active — the customer's current ride, with driver identity. */
  app.get('/active', auth, async (request) => {
    const ride = await app.prisma.order.findFirst({
      where: {
        customerId: request.user.userId,
        orderType: 'TAXI',
        status: { in: ['PENDING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'] },
      },
      include: {
        driver: {
          select: {
            id: true, vehicleMake: true, vehicleModel: true, vehicleColor: true,
            licensePlate: true, averageRating: true, currentLat: true, currentLng: true,
            user: { select: { firstName: true, avatar: true, phone: true } },
          },
        },
      },
      orderBy: { placedAt: 'desc' },
    });
    return { success: true, data: ride };
  });

  /** GET /:id — one owned ride. */
  app.get<{ Params: { id: string } }>('/:id', auth, async (request) => {
    const ride = await app.prisma.order.findFirst({
      where: { id: request.params.id, customerId: request.user.userId, orderType: 'TAXI' },
      include: {
        driver: {
          select: {
            vehicleMake: true, vehicleModel: true, vehicleColor: true, licensePlate: true,
            averageRating: true, user: { select: { firstName: true, avatar: true } },
          },
        },
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!ride) throw new NotFoundError('Ride', request.params.id);
    return { success: true, data: ride };
  });

  /** POST /:id/cancel — rides ride the same state machine as everything else. */
  app.post<{ Params: { id: string } }>('/:id/cancel', auth, async (request) => {
    const body = cancelSchema.parse(request.body ?? {});
    const result = await orderService.cancelOrder(request.params.id, request.user.userId, body.reason);
    return { success: true, data: result };
  });
}
