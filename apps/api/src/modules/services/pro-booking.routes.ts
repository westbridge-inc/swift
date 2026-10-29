import type { FastifyInstance } from 'fastify';
import { Prisma, type ServiceJob } from '@prisma/client';
import { z } from '../../lib/zod';
import { AppError, NotFoundError } from '../../utils/errors';
import { getTenantId } from '../../plugins/prisma';
import { formatGuyanaTime, guyanaDayKey } from '../../utils/guyana-day';
import { insertNoticeFor } from '../../lib/owner-wall-notices';
import { NotificationService } from '../notification/notification.service';
import { assertUsersMayContact } from '../moderation/user-block.service';
import { canonicalSlotStart } from '../booking/availability';
import { instantBookingEnabled } from '../booking/instant-booking';
import { bookingLimitsFor } from '../booking/booking-limits';
import { isTransactionConflict, lockCustomerBookings } from '../booking/booking.service';
import { customerRescheduleVerdict } from '../booking/reschedule-policy';
import { serviceAppointmentCancelView } from '../order/cancel-policy';
import { canonicalServiceTrade, serviceTradeLabel } from './services.service';
import { isProTradeBookable } from './service-catalog';
import { PRO_MIN_NOTICE_MINUTES, providerDaySlots, storedWeeklyHours } from './provider-calendar';
import { isServiceJobExclusionViolation } from './provider-time';
import { assertProviderCanOperate } from './provider-operate';
import { proBookingOff } from './provider-bookable.routes';
import { serviceQuoteAmountSchema, transitionServiceJob } from './service-job-transition';
import { executeTenantBoundServiceJobTransaction } from './service-job-transaction';
import { transitionGenerationSchema } from './service-job-client-contract';

// ---------------------------------------------------------------------------
// [BOOK-P2 Track P] BOOK A PRO — a customer books a time from a pro's menu.
//
// Behind INSTANT_BOOKING: while it is off every route here answers 404
// PRO_BOOKING_OFF before reading the body, and nothing is written. Only the
// first bookable categories (owner C4: tutor, cleaner, photographer) are ever
// bookable; a held trade never is, whatever the switch says.
//
//  GET  /providers/:id/offerings  the pro's active services (name, length, the
//                                 fixed price shown before booking).
//  GET  /providers/:id/slots      the free start times of one service on one
//                                 Guyana date: the ONE day computation
//                                 (provider-calendar.ts providerDaySlots).
//  POST /jobs/book                the booking. One transaction: both people's
//                                 rows locked, every authority re-read (active,
//                                 verified, same tenant, no block, a bookable
//                                 trade, assertProviderCanOperate), the price
//                                 the customer saw checked against the stored
//                                 one, the time checked against the same day
//                                 computation, the customer's caps, then the
//                                 job is written SCHEDULED and already
//                                 confirmed (the pro's menu is their standing
//                                 acceptance), priced at the service's price,
//                                 ending at start + its length, with its chat
//                                 room, its audit row and both notices. The
//                                 database's one-pro-one-time exclusion decides
//                                 a race; the loser gets 409 SLOT_TAKEN.
//  POST /jobs/:id/reschedule      [owner B2] either side moves a booked service
//                                 to another free time of the same length; the
//                                 customer only until two hours before it
//                                 starts. Its end moves with its start.
//
// Cash at the appointment only (owner A3): a pro's job carries no payment.
// Builds 9, 11 and 12 call none of these routes; a booked job reaches the pro's
// jobs list on those builds as a confirmed job (they start and complete it as
// today).
// ---------------------------------------------------------------------------

const bookSchema = z.object({
  providerId: z.string().min(1).max(64),
  offeringId: z.string().min(1).max(64),
  scheduledFor: z.coerce.date(),
  /** The price the customer was shown (GYD). The job is priced at the stored price only when it is this. */
  expectedPrice: serviceQuoteAmountSchema,
  note: z.string().trim().max(500).optional(),
});

const slotsQuerySchema = z.object({
  offeringId: z.string().min(1).max(64),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
});

const rescheduleSchema = transitionGenerationSchema.extend({
  scheduledFor: z.coerce.date(),
  expectedScheduledFor: z.coerce.date(),
});

/** The audit action of a booking from a pro's menu, and of its move. */
export const PRO_BOOKING_AUDIT_ACTION = 'SERVICE_JOB_BOOKED';
export const PRO_BOOKING_MOVED_AUDIT_ACTION = 'SERVICE_JOB_RESCHEDULED';

function tradeNotBookable(): AppError {
  return new AppError(409, 'TRADE_NOT_BOOKABLE', 'This provider does not take bookings from a list of services. Ask them for a quote instead.');
}

function slotTaken(): AppError {
  return new AppError(409, 'SLOT_TAKEN', 'That time was just booked with this provider — pick another time');
}

function slotLabel(when: Date): string {
  return formatGuyanaTime(when, { weekday: 'short', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short', hour12: true }, 'en-US');
}

/** A service as the customer reads it: the fixed price as a number (GYD). */
function shownOffering(o: { id: string; name: string; durationMinutes: number; price: Prisma.Decimal }) {
  return { id: o.id, name: o.name, durationMinutes: o.durationMinutes, price: Number(o.price) };
}

/** [BOOK-P2] Writers of one pro's time (a booking, a move) queue here, one at a time, until their
 *  transaction ends, the store's lockBusinessTime twin: the time check that follows reads every
 *  job the writer before it committed, so a race is answered SLOT_TAKEN by the check, never by
 *  two writers waiting on each other's uncommitted rows (a deadlock). Taken before any User row
 *  lock (a booking) and before the job row (a move): no cycle with the quote flow's User locks. */
export async function lockProviderTime(tx: Prisma.TransactionClient, providerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pro-time:${providerId}`}, 0))`;
}

/** A lost write: the identical-start unique (P2002) or the one-pro-one-time exclusion (23P01). */
function isSlotConflict(error: unknown): boolean {
  return (error as Prisma.PrismaClientKnownRequestError | null)?.code === 'P2002' || isServiceJobExclusionViolation(error);
}

/**
 * [BOOK-P2] Is `start` a time this pro can be booked for this length, now? The SAME day
 * computation the slot list shows (hours, the service's stride, two hours' notice, time off,
 * every other live job). The refusal says why: in the past, too soon, held by another job,
 * or not an open time at all.
 */
async function assertBookableTime(
  db: Prisma.TransactionClient,
  input: { providerId: string; weeklyHours: unknown; durationMinutes: number; start: Date; now: Date; excludeJobId?: string },
): Promise<void> {
  if (input.start.getTime() <= input.now.getTime()) throw new AppError(400, 'SLOT_IN_PAST', 'Pick a time in the future');
  if (input.start.getTime() <= input.now.getTime() + PRO_MIN_NOTICE_MINUTES * 60_000) {
    throw new AppError(409, 'TOO_SOON', `Book at least ${PRO_MIN_NOTICE_MINUTES / 60} hours ahead. Pick a later time.`);
  }
  const day = { providerId: input.providerId, weeklyHours: input.weeklyHours, offering: { durationMinutes: input.durationMinutes }, date: guyanaDayKey(input.start), now: input.now };
  const at = (list: Date[]) => list.some((s) => s.getTime() === input.start.getTime());
  if (at(await providerDaySlots(db, { ...day, excludeJobId: input.excludeJobId }))) return;
  // Open on the pro's calendar (hours, stride, notice, time off) but held by another job: taken.
  if (at(await providerDaySlots(db, { ...day, ignoreJobs: true }))) throw slotTaken();
  throw new AppError(409, 'SLOT_UNAVAILABLE', 'That time is not open for booking with this provider. Pick a time from the list.');
}

export function registerProBookingRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.authenticate] };
  const notifications = new NotificationService(app.prisma, app.io);

  function authenticatedTenant(): string {
    const tenantId = getTenantId();
    if (!tenantId) throw new AppError(401, 'UNAUTHORIZED', 'No authenticated tenant is bound to this request');
    return tenantId;
  }

  /** A pro a customer may book: listed in the caller's tenant, ACTIVE, no block either way,
   *  a bookable trade, able to take new work. Anything else reads as not found or refused. */
  async function bookableProvider(providerId: string, viewerId: string) {
    const tenantId = authenticatedTenant();
    const provider = await app.prisma.serviceProvider.findFirst({
      where: { id: providerId, user: { tenantId, status: 'ACTIVE' } },
      select: { id: true, userId: true, trade: true, weeklyHours: true },
    });
    if (!provider) throw new NotFoundError('ServiceProvider', providerId);
    if (provider.userId !== viewerId) {
      await assertUsersMayContact(app.prisma, tenantId, viewerId, provider.userId).catch((error: unknown) => {
        // Neutral: a blocked pro is not listed to the viewer (browse), so it reads as not found.
        if (error instanceof AppError && error.code === 'USER_BLOCKED') throw new NotFoundError('ServiceProvider', providerId);
        throw error;
      });
    }
    if (!isProTradeBookable(canonicalServiceTrade(provider.trade))) throw tradeNotBookable();
    await assertProviderCanOperate(app.prisma, provider);
    return provider;
  }

  /** GET /providers/:id/offerings — the pro's bookable services, with their fixed prices. */
  app.get<{ Params: { id: string } }>('/providers/:id/offerings', auth, async (request) => {
    if (!instantBookingEnabled()) throw proBookingOff();
    const provider = await bookableProvider(request.params.id, request.user.userId);
    const offerings = await app.prisma.serviceOffering.findMany({
      where: { providerId: provider.id, active: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, durationMinutes: true, price: true },
    });
    const hours = storedWeeklyHours(provider.weeklyHours);
    return {
      success: true,
      data: {
        providerId: provider.id,
        tradeLabel: serviceTradeLabel(provider.trade),
        // No hours = nothing bookable yet: the services are still listed with their prices.
        offerings: offerings.map(shownOffering),
        bookableWeekdays: [...new Set(hours.map((w) => w.dayOfWeek))].sort((a, b) => a - b),
        minNoticeMinutes: PRO_MIN_NOTICE_MINUTES,
        paymentMethod: 'CASH',
      },
    };
  });

  /** GET /providers/:id/slots?offeringId=&date=YYYY-MM-DD — the free start times of one service. */
  app.get<{ Params: { id: string } }>('/providers/:id/slots', auth, async (request) => {
    if (!instantBookingEnabled()) throw proBookingOff();
    const query = slotsQuerySchema.parse(request.query);
    const provider = await bookableProvider(request.params.id, request.user.userId);
    const offering = await app.prisma.serviceOffering.findFirst({
      where: { id: query.offeringId, providerId: provider.id, active: true },
      select: { id: true, name: true, durationMinutes: true, price: true },
    });
    if (!offering) throw new NotFoundError('ServiceOffering', query.offeringId);
    const [year, month, day] = query.date.split('-').map(Number) as [number, number, number];
    if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== query.date) {
      throw new AppError(400, 'BAD_DATE', 'Choose a real date.');
    }
    // THE day computation: the one the booking checks its time against (assertBookableTime).
    const slots = await providerDaySlots(app.prisma, { providerId: provider.id, weeklyHours: provider.weeklyHours, offering, date: query.date });
    return {
      success: true,
      data: {
        date: query.date,
        offering: shownOffering(offering),
        durationMinutes: offering.durationMinutes,
        slots: slots.map((s) => s.toISOString()),
        bookableWeekdays: [...new Set(storedWeeklyHours(provider.weeklyHours).map((w) => w.dayOfWeek))].sort((a, b) => a - b),
        minNoticeMinutes: PRO_MIN_NOTICE_MINUTES,
      },
    };
  });

  /** POST /jobs/book — book a time from a pro's menu: SCHEDULED, confirmed, at the price shown. */
  app.post('/jobs/book', auth, async (request, reply) => {
    if (!instantBookingEnabled()) throw proBookingOff();
    const body = bookSchema.parse(request.body);
    const customerId = request.user.userId;
    const tenantId = authenticatedTenant();
    const start = canonicalSlotStart(body.scheduledFor);
    const limits = await bookingLimitsFor(app.prisma, tenantId);
    const candidate = await app.prisma.serviceProvider.findUnique({ where: { id: body.providerId }, select: { userId: true } });
    if (!candidate) throw new NotFoundError('ServiceProvider', body.providerId);

    let outcome: { job: ServiceJob; created: boolean; notificationIds: string[] };
    try {
      outcome = await executeTenantBoundServiceJobTransaction(app.prisma, async (tx) => {
        // The customer's booking lock first, then the pro's time (the store checkout's order:
        // customer, then the business's time), both held to commit: a retried booking waits
        // here and finds the first; a second booking of the same pro waits and then sees it.
        await lockCustomerBookings(tx, customerId);
        await lockProviderTime(tx, body.providerId);
        // Both people's rows, in id order: the authority lock every job request, profile change,
        // document decision and account closure takes (services.service.ts createServiceJobWithLiveAuthority).
        const ids = [...new Set([customerId, candidate.userId])].sort();
        const locked = await tx.$queryRaw<Array<{ id: string; status: string; tenantId: string }>>(Prisma.sql`
          SELECT "id", "status"::text, "tenantId" FROM "users"
          WHERE "id" IN (${Prisma.join(ids)})
          ORDER BY "id"
          FOR UPDATE /* pro-booking-live-authority */
        `);
        const users = new Map(locked.map((u) => [u.id, u]));
        const customer = users.get(customerId);
        if (!customer || customer.status !== 'ACTIVE' || customer.tenantId !== tenantId) {
          throw new AppError(403, 'CUSTOMER_NOT_ACTIVE', 'Your account cannot book a service right now.');
        }
        const provider = await tx.serviceProvider.findUnique({
          where: { id: body.providerId },
          select: { id: true, userId: true, trade: true, weeklyHours: true },
        });
        const providerUser = provider ? users.get(provider.userId) : undefined;
        if (!provider || provider.userId !== candidate.userId || !providerUser || providerUser.tenantId !== tenantId || providerUser.status !== 'ACTIVE') {
          // Another tenant's pro is indistinguishable from none.
          throw new NotFoundError('ServiceProvider', body.providerId);
        }
        if (provider.userId === customerId) throw new AppError(400, 'SELF_JOB', 'You cannot book yourself');
        await assertUsersMayContact(tx, tenantId, customerId, provider.userId);
        const trade = canonicalServiceTrade(provider.trade);
        // [owner C4 · R15] A held trade, or one without a bookable menu, is never booked.
        if (!isProTradeBookable(trade)) throw tradeNotBookable();
        // [BOOK-P2 · BILL-PRO hook] Live verification today; the weekly fee joins it (provider-operate.ts).
        await assertProviderCanOperate(tx, provider);

        // A retried booking (a lost answer, a second tap) is the same booking: this customer already
        // holds this service with this pro at this time. Read under the customer's locks above.
        const earlier = await tx.serviceJob.findFirst({
          where: { customerId, providerId: provider.id, offeringId: body.offeringId, scheduledFor: start, status: 'SCHEDULED' },
        });
        if (earlier) return { job: earlier, created: false, notificationIds: [] };

        const offering = await tx.serviceOffering.findFirst({
          where: { id: body.offeringId, providerId: provider.id },
          select: { id: true, name: true, durationMinutes: true, price: true, active: true },
        });
        if (!offering) throw new NotFoundError('ServiceOffering', body.offeringId);
        if (!offering.active) {
          throw new AppError(409, 'OFFERING_UNAVAILABLE', 'This service is no longer offered. Pick another service.');
        }
        // The price on the job is the price the customer was shown, or nothing is booked.
        if (!offering.price.equals(new Prisma.Decimal(body.expectedPrice))) {
          throw new AppError(409, 'PRICE_CHANGED', `The price of this service changed to GYD ${Number(offering.price)}. Check it and book again.`, {
            price: Number(offering.price),
          });
        }

        const now = new Date();
        await assertBookableTime(tx, {
          providerId: provider.id, weeklyHours: provider.weeklyHours, durationMinutes: offering.durationMinutes, start, now,
        });

        // [BOOK-S2 caps, the same numbers] One customer holds at most `perBusiness` upcoming
        // appointments with one pro and `total` with pros in all, counted under the customer's
        // booking lock (taken first, above), so two bookings never both slip past a cap.
        const upcoming = await tx.serviceJob.findMany({
          where: { customerId, offeringId: { not: null }, status: 'SCHEDULED', scheduledFor: { gt: now } },
          select: { providerId: true },
        });
        const withThisPro = upcoming.filter((j) => j.providerId === provider.id).length;
        if (withThisPro >= limits.perBusiness) {
          throw new AppError(409, 'BOOKING_LIMIT_REACHED', `You already have ${withThisPro} upcoming bookings with this provider. Cancel one, or book again after one is done.`);
        }
        if (upcoming.length >= limits.total) {
          throw new AppError(409, 'BOOKING_LIMIT_REACHED', `You already have ${upcoming.length} upcoming bookings with providers. Cancel one, or book again after one is done.`);
        }

        const endsAt = new Date(start.getTime() + offering.durationMinutes * 60_000);
        const job = await tx.serviceJob.create({
          data: {
            tenantId,
            customerId,
            providerId: provider.id,
            description: body.note ? `${offering.name}: ${body.note}` : offering.name,
            photos: [],
            status: 'SCHEDULED',
            // The fixed price, shown before booking (Decimal(12,2), as stored on the service).
            quoteAmount: offering.price,
            scheduledFor: start,
            endsAt,
            offeringId: offering.id,
            // The pro's menu is their standing acceptance: confirmed at booking (no confirm step).
            providerConfirmedAt: now,
          },
        });
        const room = await tx.chatRoom.create({
          data: {
            serviceJobId: job.id,
            participants: { create: [{ userId: customerId, role: 'customer' }, { userId: provider.userId, role: 'provider' }] },
          },
        });
        const linked = await tx.serviceJob.update({ where: { id: job.id }, data: { chatRoomId: room.id } });
        await tx.auditLog.create({
          data: {
            userId: customerId,
            action: PRO_BOOKING_AUDIT_ACTION,
            entity: 'ServiceJob',
            entityId: job.id,
            changes: {
              to: 'SCHEDULED',
              offeringId: offering.id,
              scheduledFor: start.toISOString(),
              endsAt: endsAt.toISOString(),
              price: offering.price.toString(),
              confirmedBy: 'PROVIDER_MENU',
            },
          },
        });
        const when = slotLabel(start);
        const notices = [
          {
            userId: provider.userId,
            title: 'New booking (confirmed)',
            body: `${offering.name}, ${when}. Already confirmed — nothing to accept. Cash on completion.`,
          },
          {
            userId: customerId,
            title: 'Booking confirmed',
            body: `${offering.name} with your ${serviceTradeLabel(provider.trade).toLowerCase()}, ${when}. Pay cash on completion.`,
          },
        ];
        const notificationIds: string[] = [];
        for (const n of notices) {
          const row = await insertNoticeFor(tx, {
            userId: n.userId,
            type: 'ORDER_UPDATE',
            title: n.title,
            body: n.body,
            data: { kind: 'booking_confirmed', jobId: job.id },
            dedupeKey: `service-job:${job.id}:booked:${n.userId}`,
          });
          notificationIds.push(row.id);
        }
        return { job: linked, created: true, notificationIds };
      });
    } catch (error) {
      if (isSlotConflict(error)) throw slotTaken();
      if (isTransactionConflict(error)) throw new AppError(409, 'BOOKING_BUSY', 'This provider is being booked right now — try again.');
      throw error;
    }
    await Promise.all(outcome.notificationIds.map((id) => notifications.publishPersisted(id)));
    reply.code(201);
    return { success: true, data: { ...outcome.job, appointment: serviceAppointmentViewFor(outcome.job, customerId) } };
  });

  /** POST /jobs/:id/reschedule — move a booked service to another free time (owner B2). */
  app.post<{ Params: { id: string } }>('/jobs/:id/reschedule', auth, async (request) => {
    if (!instantBookingEnabled()) throw proBookingOff();
    const body = rescheduleSchema.parse(request.body);
    const userId = request.user.userId;
    const job = await app.prisma.serviceJob.findUnique({
      where: { id: request.params.id },
      include: { provider: { select: { id: true, userId: true, weeklyHours: true } } },
    });
    if (!job) throw new NotFoundError('ServiceJob', request.params.id);
    const byCustomer = job.customerId === userId;
    if (!byCustomer && job.provider.userId !== userId) throw new AppError(403, 'FORBIDDEN', 'You are not part of this job');
    if (!job.offeringId || !job.scheduledFor || !job.endsAt) {
      throw new AppError(400, 'NOT_RESCHEDULABLE', 'Only a time booked from a provider’s list of services can be moved here. Agree a new time in the chat.');
    }
    if (job.status !== 'SCHEDULED') throw new AppError(400, 'NOT_RESCHEDULABLE', `This job is ${job.status.toLowerCase().replace('_', ' ')} and cannot be moved`);
    const now = new Date();
    // [owner B2] The customer moves it in the app only until two hours before it starts; the pro at any time.
    if (byCustomer) {
      const verdict = customerRescheduleVerdict(job.scheduledFor, now);
      if (!verdict.allowed) throw new AppError(409, verdict.code, verdict.message);
    }
    const to = canonicalSlotStart(body.scheduledFor);
    if (to.getTime() === job.scheduledFor.getTime()) {
      return { success: true, data: { ...job, provider: undefined, appointment: serviceAppointmentViewFor(job, userId, now) } };
    }
    // The length that was booked moves with it (a later change to the service does not reprice or resize it).
    const bookedMinutes = Math.round((job.endsAt.getTime() - job.scheduledFor.getTime()) / 60_000);
    const endsAt = new Date(to.getTime() + bookedMinutes * 60_000);
    const otherUserId = byCustomer ? job.provider.userId : job.customerId;
    const from = slotLabel(job.scheduledFor);
    const when = slotLabel(to);
    let moved: Awaited<ReturnType<typeof transitionServiceJob>>;
    try {
      moved = await executeTenantBoundServiceJobTransaction(app.prisma, async (tx) => {
        await lockProviderTime(tx, job.providerId);
        await assertBookableTime(tx, {
          providerId: job.providerId, weeklyHours: job.provider.weeklyHours, durationMinutes: bookedMinutes, start: to, now, excludeJobId: job.id,
        });
        return transitionServiceJob(tx, {
          jobId: job.id,
          actorUserId: userId,
          expectedUpdatedAt: body.expectedUpdatedAt,
          from: 'SCHEDULED',
          to: 'SCHEDULED',
          guard: {
            scheduledFor: body.expectedScheduledFor,
            offeringId: job.offeringId,
            ...(byCustomer ? { customerId: userId } : { provider: { userId } }),
          },
          // [P1 owed] The end moves with the start: the held range stays the booked length.
          data: { scheduledFor: to, endsAt },
          action: PRO_BOOKING_MOVED_AUDIT_ACTION,
          audit: { scheduledFor: to.toISOString(), endsAt: endsAt.toISOString(), previousScheduledFor: body.expectedScheduledFor.toISOString(), movedBy: byCustomer ? 'CUSTOMER' : 'PROVIDER' },
          notices: [{
            userId: otherUserId,
            type: 'ORDER_UPDATE',
            title: 'Booking moved',
            body: byCustomer
              ? `The customer moved their booking from ${from} to ${when}.`
              : `Your provider moved your booking from ${from} to ${when}. If the new time doesn’t suit you, contact them or cancel it.`,
            data: { kind: 'booking_moved', jobId: job.id },
          }],
          now,
        });
      });
    } catch (error) {
      if (isSlotConflict(error)) throw slotTaken();
      if (isTransactionConflict(error)) throw new AppError(409, 'SERVICE_JOB_CHANGED', 'This job changed — refresh it before trying again.');
      throw error;
    }
    await Promise.all(moved.notificationIds.map((id) => notifications.publishPersisted(id)));
    return { success: true, data: { ...moved.job, appointment: serviceAppointmentViewFor(moved.job, userId, now) } };
  });
}

/** [BOOK-P2] The appointment rules the customer reads on a job booked from a menu (the booking,
 *  the move, GET /jobs and /jobs/:id): cancel and move, from the same verdicts the routes apply.
 *  Null for the pro, a quote job, or the switch off. */
export function serviceAppointmentViewFor(job: ServiceJob, viewerId: string, now = new Date()) {
  if (!job.offeringId || !job.scheduledFor || job.customerId !== viewerId || !instantBookingEnabled()) return null;
  const cancel = serviceAppointmentCancelView(job, now);
  const live = job.status === 'SCHEDULED';
  const move = customerRescheduleVerdict(job.scheduledFor, now);
  return {
    ...cancel,
    canReschedule: live && move.allowed,
    rescheduleUnavailable: live && !move.allowed ? { code: move.code, message: move.message } : null,
  };
}
