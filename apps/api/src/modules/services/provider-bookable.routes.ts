import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { bindTenantTransaction } from '../../plugins/prisma';
import { instantBookingEnabled } from '../booking/instant-booking';
import { canonicalServiceTrade } from './services.service';
import {
  guyanaToday,
  isProTradeBookable,
  MAX_OFFERINGS_PER_PROVIDER,
  MAX_UPCOMING_TIME_OFF,
  offeringCreateSchema,
  offeringUpdateSchema,
  storedWeeklyHours,
  TIME_OFF_HORIZON_DAYS,
  timeOffSchema,
  weeklyHoursForSave,
  weeklyHoursSchema,
} from './provider-calendar';

// ---------------------------------------------------------------------------
// [BOOK-P1 Track P] A provider's bookable services, weekly hours and time off:
// the provider's own settings, read and written only by the provider.
//
// Behind INSTANT_BOOKING: while it is off every route here answers 404
// PRO_BOOKING_OFF and writes nothing, so production and staging behave exactly
// as before. Only the first bookable categories (owner C4: tutor, cleaner,
// photographer; a held trade never) may set them up. No customer sees any of
// it yet: booking a pro is P2.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

export function proBookingOff(): AppError {
  return new AppError(404, 'PRO_BOOKING_OFF', 'Bookable services are not available yet.');
}

function tradeNotBookable(): AppError {
  return new AppError(409, 'TRADE_NOT_BOOKABLE', 'Your service does not take bookings from a menu yet. Customers can still ask you for a quote.');
}

interface OfferingRow {
  id: string;
  name: string;
  durationMinutes: number;
  price: Prisma.Decimal;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** An offering as the provider reads it: the price as a number (GYD). */
function shownOffering(o: OfferingRow) {
  return {
    id: o.id, name: o.name, durationMinutes: o.durationMinutes, price: Number(o.price), active: o.active,
    createdAt: o.createdAt, updatedAt: o.updatedAt,
  };
}

const OFFERING_SELECT = { id: true, name: true, durationMinutes: true, price: true, active: true, createdAt: true, updatedAt: true } as const;

export function registerProviderBookableRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.authenticate] };
  /** The caller's provider profile, with the switch and the category checked. Writes need a bookable trade. */
  async function myProvider(userId: string, forWrite: boolean) {
    if (!instantBookingEnabled()) throw proBookingOff();
    const provider = await app.prisma.serviceProvider.findUnique({
      where: { userId },
      select: { id: true, trade: true, weeklyHours: true },
    });
    if (!provider) throw new NotFoundError('ServiceProvider');
    const bookable = isProTradeBookable(canonicalServiceTrade(provider.trade));
    if (forWrite && !bookable) throw tradeNotBookable();
    return { ...provider, bookable };
  }

  /** GET /providers/me/bookable — my services, weekly hours and upcoming time off. */
  app.get('/providers/me/bookable', auth, async (request) => {
    const provider = await myProvider(request.user.userId, false);
    const [offerings, timeOff] = await Promise.all([
      app.prisma.serviceOffering.findMany({ where: { providerId: provider.id }, orderBy: [{ active: 'desc' }, { createdAt: 'asc' }], select: OFFERING_SELECT }),
      app.prisma.serviceProviderTimeOff.findMany({
        where: { providerId: provider.id, date: { gte: guyanaToday() } },
        orderBy: [{ date: 'asc' }, { start: 'asc' }],
        select: { id: true, date: true, start: true, end: true },
      }),
    ]);
    return {
      success: true,
      data: {
        bookable: provider.bookable,
        offerings: offerings.map(shownOffering),
        weeklyHours: storedWeeklyHours(provider.weeklyHours),
        timeOff: timeOff.map((t) => ({ id: t.id, date: t.date.toISOString().slice(0, 10), start: t.start, end: t.end })),
      },
    };
  });

  /** POST /providers/me/offerings — add a bookable service (name, length, fixed price). */
  app.post('/providers/me/offerings', auth, async (request) => {
    const body = offeringCreateSchema.parse(request.body);
    const provider = await myProvider(request.user.userId, true);
    const created = await app.prisma.$transaction(async (tx) => {
      // One writer per provider at a time, so the cap holds under concurrent adds.
      await bindTenantTransaction(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-offerings:${provider.id}`}, 0))`;
      const count = await tx.serviceOffering.count({ where: { providerId: provider.id } });
      if (count >= MAX_OFFERINGS_PER_PROVIDER) {
        throw new AppError(409, 'TOO_MANY_OFFERINGS', `You can list up to ${MAX_OFFERINGS_PER_PROVIDER} services. Switch one off and change it instead.`);
      }
      return tx.serviceOffering.create({
        data: { providerId: provider.id, name: body.name, durationMinutes: body.durationMinutes, price: new Prisma.Decimal(body.price) },
        select: OFFERING_SELECT,
      });
    });
    return { success: true, data: shownOffering(created) };
  });

  /** PATCH /providers/me/offerings/:id — change one of my services, or switch it off or on. */
  app.patch<{ Params: { id: string } }>('/providers/me/offerings/:id', auth, async (request) => {
    const body = offeringUpdateSchema.parse(request.body);
    const provider = await myProvider(request.user.userId, true);
    const changed = await app.prisma.serviceOffering.updateMany({
      where: { id: request.params.id, providerId: provider.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.durationMinutes !== undefined ? { durationMinutes: body.durationMinutes } : {}),
        ...(body.price !== undefined ? { price: new Prisma.Decimal(body.price) } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
    });
    if (changed.count === 0) throw new NotFoundError('ServiceOffering', request.params.id);
    const offering = await app.prisma.serviceOffering.findFirstOrThrow({ where: { id: request.params.id, providerId: provider.id }, select: OFFERING_SELECT });
    return { success: true, data: shownOffering(offering) };
  });

  /** PUT /providers/me/hours — my weekly hours (every day's windows, replacing what is stored). */
  app.put('/providers/me/hours', auth, async (request) => {
    const body = weeklyHoursSchema.parse(request.body);
    const provider = await myProvider(request.user.userId, true);
    const slots = weeklyHoursForSave(body.slots);
    await app.prisma.serviceProvider.update({
      where: { id: provider.id },
      data: { weeklyHours: slots.length > 0 ? (slots as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
    });
    return { success: true, data: { weeklyHours: slots } };
  });

  /** POST /providers/me/time-off — a whole day off, or a window of one day. */
  app.post('/providers/me/time-off', auth, async (request) => {
    const body = timeOffSchema.parse(request.body);
    const provider = await myProvider(request.user.userId, true);
    const [y, m, d] = body.date.split('-').map(Number);
    const date = new Date(Date.UTC(y!, m! - 1, d!));
    const today = guyanaToday();
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== body.date) {
      throw new AppError(400, 'BAD_DATE', 'Choose a real date.');
    }
    if (date < today) throw new AppError(400, 'DATE_IN_PAST', 'Choose today or a later day.');
    if (date.getTime() > today.getTime() + TIME_OFF_HORIZON_DAYS * DAY_MS) {
      throw new AppError(400, 'DATE_TOO_FAR', 'Choose a day within the next year.');
    }
    const created = await app.prisma.$transaction(async (tx) => {
      await bindTenantTransaction(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-time-off:${provider.id}`}, 0))`;
      const upcoming = await tx.serviceProviderTimeOff.count({ where: { providerId: provider.id, date: { gte: today } } });
      if (upcoming >= MAX_UPCOMING_TIME_OFF) {
        throw new AppError(409, 'TOO_MUCH_TIME_OFF', `You can set up to ${MAX_UPCOMING_TIME_OFF} times off ahead. Remove one first.`);
      }
      return tx.serviceProviderTimeOff.create({
        data: { providerId: provider.id, date, start: body.start ?? null, end: body.end ?? null },
        select: { id: true, date: true, start: true, end: true },
      });
    });
    return { success: true, data: { id: created.id, date: body.date, start: created.start, end: created.end } };
  });

  /** DELETE /providers/me/time-off/:id — take back a time off (my own only). */
  app.delete<{ Params: { id: string } }>('/providers/me/time-off/:id', auth, async (request) => {
    const provider = await myProvider(request.user.userId, true);
    const removed = await app.prisma.serviceProviderTimeOff.deleteMany({ where: { id: request.params.id, providerId: provider.id } });
    if (removed.count === 0) throw new NotFoundError('TimeOff', request.params.id);
    return { success: true, data: { deleted: true } };
  });
}
