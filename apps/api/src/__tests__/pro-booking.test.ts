import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// [BOOK-P3 · COORD 16:13Z] A pro is bookable from their list only after accepting the agreement version with the
// advance-acceptance clause; no such version exists on main yet (fail-closed), so this suite names one and every
// pro it makes accepted it (makePro). The gate itself: pro-booking-followups.test.ts + pro-booking.unit.test.ts.
vi.mock('../modules/services/pro-menu-agreement-version', () => ({
  PRO_MENU_AGREEMENT: { documentType: 'vendor_agreement', sinceVersion: '2026-10-29' },
}));
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';
import {
  SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER,
  SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION,
} from '@swift/types';
import { beginRequestTenantContext, prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { servicesRoutes } from '../modules/services/services.routes';
import { serviceCatalogRoutes } from '../modules/services/service-catalog.routes';
import { providerChecklist } from '../modules/services/services.service';
import { registerErrorHandler } from '../middleware/error-handler';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { rlsDdlFor, tenantLineageDdl } from '../lib/tenant-rls';
import { providerTimeDdl } from '../modules/services/provider-time';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';
import { testPhone } from './helpers/fixture-ids';
import { installDdl } from './helpers/install-ddl';
import { runWithoutTenant } from '../plugins/tenant-context';
import { grantSuiteCapability } from '../lib/test-target-lock';

// The heal below is raw DDL (idempotent; a no-op on a migrated database).
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [BOOK-P2 Track P] BOOK A PRO. A customer books a time from a pro's menu: the
// job is SCHEDULED and already confirmed, priced at the price the customer was
// shown, ending at start + the service's length, with its chat room and both
// notices, all in one transaction. Behind INSTANT_BOOKING; only tutor, cleaner
// and photographer (owner C4), never a held trade. The database's
// one-pro-one-time exclusion decides a race. The customer cancels free until
// two hours before (owner B1) and moves it until then (B2); the pro moves it at
// any time, and its end moves with it. The build-9 quote flow is unchanged.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60_000;
let app: FastifyInstance;
const userIds: string[] = [];
const providerIds: string[] = [];
const TENANT_B = `pro-p2-tenant-${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, '0')}`;

/** A date 10 days ahead (Guyana), and true instants on it. */
const DATE = guyanaDayKey(new Date(Date.now() + 10 * DAY));
const [YY, MM, DD] = DATE.split('-').map(Number) as [number, number, number];
const at = (hh: number, mm = 0) => instantOfGuyanaWallClock(new Date(Date.UTC(YY, MM - 1, DD, hh, mm)));
const hhmm = (d: Date | string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Guyana', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d));
const WEEKDAY = new Date(Date.UTC(YY, MM - 1, DD)).getUTCDay();
const HOURS_9_TO_13 = [{ dayOfWeek: WEEKDAY, start: '09:00', end: '13:00' }];

async function makeUser(tenantId = 'swift-default') {
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: testPhone(), firstName: 'Pro', lastName: 'P2', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId,
        isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: 'storage://test/p2-selfie.jpg', customer: { create: {} },
      },
    });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'book-p2', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
    });
    return { userId: user.id, token };
  });
}

/** A pro whose whole checklist a person approved (live verification), with weekly hours. */
async function makePro(trade = 'tutor', opts: { hours?: unknown; tenantId?: string } = {}) {
  const u = await makeUser(opts.tenantId);
  const provider = await runWithoutTenant(() => app.prisma.serviceProvider.create({
    data: { userId: u.userId, trade, isVerified: true, weeklyHours: (opts.hours ?? HOURS_9_TO_13) as Prisma.InputJsonValue },
  }));
  providerIds.push(provider.id);
  const checklist = await runWithoutTenant(() => providerChecklist(app.prisma, u.userId));
  for (const docType of checklist) {
    await runWithoutTenant(() => app.prisma.verificationDocument.create({
      data: { userId: u.userId, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}.jpg`, status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
    }));
  }
  // [BOOK-P3] The pro accepted the agreement with the advance-acceptance clause (the mocked version above).
  await runWithoutTenant(() => app.prisma.consentRecord.create({
    data: {
      subjectType: 'vendor_user', subjectId: u.userId, documentType: 'vendor_agreement', documentVersion: '2026-10-29',
      documentContentHash: 'book-p3-test', action: 'granted', surface: 'ios',
    },
  }));
  return { ...u, providerId: provider.id, checklist };
}

async function makeOffering(providerId: string, durationMinutes: number, price = 3000, active = true) {
  return runWithoutTenant(() => app.prisma.serviceOffering.create({
    data: { providerId, name: `Lesson ${durationMinutes}`, durationMinutes, price: new Prisma.Decimal(price), active },
  }));
}

function inject(method: 'GET' | 'POST', url: string, token: string, payload?: unknown, legacy = false) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
      ...(legacy ? {} : { [SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER]: SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION }),
    },
  });
}

function book(token: string, pro: { providerId: string }, offering: { id: string; price: Prisma.Decimal }, start: Date, extra: Record<string, unknown> = {}) {
  return inject('POST', '/api/v1/services/jobs/book', token, {
    providerId: pro.providerId, offeringId: offering.id, scheduledFor: start.toISOString(), expectedPrice: Number(offering.price), ...extra,
  });
}

async function slots(token: string, pro: { providerId: string }, offering: { id: string }, date = DATE) {
  const res = await inject('GET', `/api/v1/services/providers/${pro.providerId}/slots?offeringId=${offering.id}&date=${date}`, token);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data.slots as string[]).map(hhmm);
}

const jobRow = (id: string) => runWithoutTenant(() => app.prisma.serviceJob.findUniqueOrThrow({ where: { id } }));
const liveJobsOf = (providerId: string) => runWithoutTenant(() => app.prisma.serviceJob.findMany({
  where: { providerId, status: { in: ['SCHEDULED', 'IN_PROGRESS'] } }, orderBy: { scheduledFor: 'asc' },
}));

async function reschedule(token: string, jobId: string, to: Date) {
  const job = await jobRow(jobId);
  return inject('POST', `/api/v1/services/jobs/${jobId}/reschedule`, token, {
    scheduledFor: to.toISOString(), expectedUpdatedAt: job.updatedAt.toISOString(), expectedScheduledFor: job.scheduledFor!.toISOString(),
  });
}

async function cancel(token: string, jobId: string) {
  const job = await jobRow(jobId);
  return inject('POST', `/api/v1/services/jobs/${jobId}/cancel`, token, { expectedUpdatedAt: job.updatedAt.toISOString() });
}

/** A job booked from the menu, written straight to the row (for times the route would refuse: near now, past). */
async function rowAppointment(pro: { providerId: string }, customerId: string, offering: { id: string; durationMinutes: number }, start: Date, confirmedAt = new Date(Date.now() - 10 * MIN)) {
  return runWithoutTenant(() => app.prisma.serviceJob.create({
    data: {
      customerId, providerId: pro.providerId, description: 'Booked from the menu', status: 'SCHEDULED',
      quoteAmount: new Prisma.Decimal(3000), scheduledFor: start, endsAt: new Date(start.getTime() + offering.durationMinutes * MIN),
      offeringId: offering.id, providerConfirmedAt: confirmedAt,
    },
  }));
}

async function purge() {
  await runWithoutTenant(async () => {
    const ids = [...userIds];
    if (ids.length === 0) return;
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    const jobIds = (await app.prisma.serviceJob.findMany({ where: { OR: [{ providerId: { in: providerIds } }, { customerId: { in: ids } }] }, select: { id: true } })).map((j) => j.id);
    await app.prisma.chatRoom.deleteMany({ where: { serviceJobId: { in: jobIds } } });
    await app.prisma.serviceJob.deleteMany({ where: { providerId: { in: providerIds } } });
    await app.prisma.serviceJob.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.serviceProviderTimeOff.deleteMany({ where: { providerId: { in: providerIds } } });
    await app.prisma.serviceOffering.deleteMany({ where: { providerId: { in: providerIds } } });
    await app.prisma.serviceProvider.deleteMany({ where: { id: { in: providerIds } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.userBlock.deleteMany({ where: { OR: [{ blockerId: { in: ids } }, { blockedId: { in: ids } }] } });
    await purgeAuditLogs(app.prisma, { userId: { in: ids } }, 'test-cleanup:book-p2');
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.register(serviceCatalogRoutes, { prefix: '/api/v1/services' });
  await app.ready();
  // A db-push database lacks the raw SQL: heal it with the migration's own statements (a no-op on a migrated one).
  await installDdl(app.prisma, [
    ...providerTimeDdl(),
    ...['service_offerings', 'service_provider_time_off'].flatMap((t) => rlsDdlFor(t)),
    ...tenantLineageDdl().filter((s) => s.includes('_tenant_matches_provider')),
  ]);
  await runWithoutTenant(() => app.prisma.tenant.upsert({ where: { id: TENANT_B }, update: {}, create: { id: TENANT_B, name: 'Pro P2 Tenant B', slug: TENANT_B } }));
});

afterEach(() => { delete process.env['INSTANT_BOOKING']; });

afterAll(async () => {
  await purge();
  await runWithoutTenant(() => app.prisma.tenant.deleteMany({ where: { id: TENANT_B } }));
  await app.close();
});

const on = () => { process.env['INSTANT_BOOKING'] = '1'; };

describe('switch off: nothing new answers, nothing is written', () => {
  it('every booking route answers 404 PRO_BOOKING_OFF before reading the body', async () => {
    const pro = await makePro();
    const c = await makeUser();
    const offering = await makeOffering(pro.providerId, 60);
    const job = await rowAppointment(pro, c.userId, offering, at(10));
    const calls: Array<[('GET' | 'POST'), string, unknown?]> = [
      ['GET', `/api/v1/services/providers/${pro.providerId}/offerings`],
      ['GET', `/api/v1/services/providers/${pro.providerId}/slots?offeringId=${offering.id}&date=${DATE}`],
      ['GET', `/api/v1/services/providers/${pro.providerId}/slots?date=junk`],
      ['POST', '/api/v1/services/jobs/book', { providerId: pro.providerId, offeringId: offering.id, scheduledFor: at(11).toISOString(), expectedPrice: 3000 }],
      ['POST', '/api/v1/services/jobs/book', { junk: true }],
      ['POST', `/api/v1/services/jobs/${job.id}/reschedule`, { junk: true }],
    ];
    for (const [method, url, body] of calls) {
      const res = await inject(method, url, c.token, body);
      expect([res.statusCode, res.json().error?.code], `${method} ${url}`).toEqual([404, 'PRO_BOOKING_OFF']);
    }
    expect((await liveJobsOf(pro.providerId)).map((j) => j.id)).toEqual([job.id]);
  });

  it('the catalogue offers no appointments, and a booked time keeps the quote-job cancel rule', async () => {
    const res = await app.inject('/api/v1/services/catalog');
    for (const category of res.json().data.categories as Array<{ id: string; modes: string[]; appointmentsEnabled: boolean }>) {
      expect([category.modes, category.appointmentsEnabled], category.id).toEqual([['QUOTE_JOB'], false]);
    }
    const pro = await makePro();
    const c = await makeUser();
    const job = await rowAppointment(pro, c.userId, await makeOffering(pro.providerId, 60), at(10));
    const refused = await cancel(c.token, job.id);
    expect([refused.statusCode, refused.json().error.code]).toEqual([409, 'SERVICE_JOB_BOOKED']);
    const read = await inject('GET', `/api/v1/services/jobs/${job.id}`, c.token);
    expect(read.json().data).not.toHaveProperty('appointment');
  });
});

describe('switch on: the catalogue', () => {
  it('only tutor, cleaner and photographer take appointments; a held trade never; every open trade keeps the quote', async () => {
    on();
    const res = await app.inject('/api/v1/services/catalog');
    const categories = res.json().data.categories as Array<{ id: string; modes: string[]; appointmentsEnabled: boolean; quoteRequestsEnabled: boolean }>;
    const taking = categories.filter((c) => c.appointmentsEnabled).map((c) => c.id).sort();
    expect(taking).toEqual(['cleaner', 'photographer', 'tutor']);
    for (const c of categories) {
      expect(c.modes, c.id).toEqual(c.appointmentsEnabled ? ['QUOTE_JOB', 'APPOINTMENT'] : ['QUOTE_JOB']);
    }
    const barber = categories.find((c) => c.id === 'barber')!;
    expect([barber.appointmentsEnabled, barber.quoteRequestsEnabled]).toEqual([false, false]);
  });
});

describe('switch on: a customer books a pro', () => {
  it('lists the services and the free times, and books one: SCHEDULED, confirmed, at the price shown, with its end, room, audit and notices', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const offering = await makeOffering(pro.providerId, 60, 3000.5);
    await makeOffering(pro.providerId, 30, 1500, false);
    const listed = await inject('GET', `/api/v1/services/providers/${pro.providerId}/offerings`, c.token);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data).toMatchObject({
      providerId: pro.providerId,
      offerings: [{ id: offering.id, name: 'Lesson 60', durationMinutes: 60, price: 3000.5 }],
      bookableWeekdays: [WEEKDAY], minNoticeMinutes: 120, paymentMethod: 'CASH',
    });
    expect(await slots(c.token, pro, offering)).toEqual(['09:00', '10:00', '11:00', '12:00']);

    const res = await book(c.token, pro, offering, at(10));
    expect(res.statusCode, res.body).toBe(201);
    const job = await jobRow(res.json().data.id);
    expect(job.status).toBe('SCHEDULED');
    expect(job.providerConfirmedAt).not.toBeNull();
    expect(job.quoteAmount!.toString()).toBe('3000.5');
    expect([job.offeringId, job.scheduledFor!.toISOString(), job.endsAt!.toISOString()]).toEqual([offering.id, at(10).toISOString(), at(11).toISOString()]);
    expect(job.description).toBe('Lesson 60');
    expect(res.json().data.appointment).toMatchObject({
      canCancel: true, freeCancellationExpiresAt: new Date(at(10).getTime() - 120 * MIN).toISOString(), canReschedule: true,
    });
    const room = await runWithoutTenant(() => app.prisma.chatRoom.findUniqueOrThrow({ where: { id: job.chatRoomId! }, include: { participants: true } }));
    expect(room.participants.map((p) => [p.userId, p.role]).sort()).toEqual([[c.userId, 'customer'], [pro.userId, 'provider']].sort());
    const audit = await runWithoutTenant(() => app.prisma.auditLog.findMany({ where: { entity: 'ServiceJob', entityId: job.id } }));
    expect(audit.map((a) => a.action)).toEqual(['SERVICE_JOB_BOOKED']);
    const notices = await runWithoutTenant(() => app.prisma.notification.findMany({ where: { userId: { in: [c.userId, pro.userId] } } }));
    expect(notices.map((n) => [n.userId, n.title, (n.data as { kind: string; jobId: string }).kind, (n.data as { jobId: string }).jobId]).sort()).toEqual([
      [c.userId, 'Booking confirmed', 'booking_confirmed', job.id],
      [pro.userId, 'New booking (confirmed)', 'booking_confirmed', job.id],
    ].sort());
    // The time is gone from the list.
    expect(await slots(c.token, pro, offering)).toEqual(['09:00', '11:00', '12:00']);
  });

  it('the price on the job is the price shown: a different price books nothing (409 PRICE_CHANGED)', async () => {
    on();
    const pro = await makePro('cleaner');
    const c = await makeUser();
    const offering = await makeOffering(pro.providerId, 120, 8000);
    const wrong = await book(c.token, pro, offering, at(9), { expectedPrice: 7999.99 });
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([409, 'PRICE_CHANGED']);
    // The pro changes the price after the customer looked: the old price books nothing either.
    await runWithoutTenant(() => app.prisma.serviceOffering.update({ where: { id: offering.id }, data: { price: new Prisma.Decimal(9000) } }));
    const stale = await book(c.token, pro, offering, at(9));
    expect([stale.statusCode, stale.json().error.code, stale.json().error.details?.price]).toEqual([409, 'PRICE_CHANGED', 9000]);
    expect(await liveJobsOf(pro.providerId)).toEqual([]);
  });

  it('double-booking across services is refused: a 30-minute service at 10:30 inside a booked 10:00 hour (409 SLOT_TAKEN); 11:00 back to back is fine', async () => {
    on();
    const pro = await makePro('photographer');
    const first = await makeUser();
    const second = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const half = await makeOffering(pro.providerId, 30, 1500);
    expect((await book(first.token, pro, hour, at(10))).statusCode).toBe(201);
    expect(await slots(second.token, pro, half)).toEqual(['09:00', '09:30', '11:00', '11:30', '12:00', '12:30']);
    const res = await book(second.token, pro, half, at(10, 30));
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'SLOT_TAKEN']);
    expect((await book(second.token, pro, half, at(11))).statusCode).toBe(201);
    expect((await liveJobsOf(pro.providerId)).map((j) => hhmm(j.scheduledFor!))).toEqual(['10:00', '11:00']);
  });

  it('a held trade is never bookable, even with the switch on; nor a trade without a bookable menu', async () => {
    on();
    const c = await makeUser();
    for (const trade of ['barber', 'hairdresser', 'carpenter']) {
      const pro = await makePro(trade);
      const offering = await makeOffering(pro.providerId, 60);
      const listed = await inject('GET', `/api/v1/services/providers/${pro.providerId}/offerings`, c.token);
      expect([listed.statusCode, listed.json().error.code], trade).toEqual([409, 'TRADE_NOT_BOOKABLE']);
      const res = await book(c.token, pro, offering, at(10));
      expect([res.statusCode, res.json().error.code], trade).toEqual([409, 'TRADE_NOT_BOOKABLE']);
      expect(await liveJobsOf(pro.providerId), trade).toEqual([]);
    }
  });

  it('refuses a time that is not open: outside the hours, inside two hours, in the past, on time off; and a switched-off service', async () => {
    on();
    const pro = await makePro('tutor', { hours: [{ dayOfWeek: WEEKDAY, start: '09:00', end: '13:00' }, { dayOfWeek: new Date().getUTCDay(), start: '00:00', end: '23:59' }] });
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const outside = await book(c.token, pro, hour, at(14));
    expect([outside.statusCode, outside.json().error.code]).toEqual([409, 'SLOT_UNAVAILABLE']);
    const offGrid = await book(c.token, pro, hour, at(9, 30));
    expect([offGrid.statusCode, offGrid.json().error.code]).toEqual([409, 'SLOT_UNAVAILABLE']);
    const soon = await book(c.token, pro, hour, new Date(Math.ceil((Date.now() + 60 * MIN) / (60 * MIN)) * 60 * MIN));
    expect([soon.statusCode, soon.json().error.code]).toEqual([409, 'TOO_SOON']);
    const past = await book(c.token, pro, hour, new Date(Date.now() - DAY));
    expect([past.statusCode, past.json().error.code]).toEqual([400, 'SLOT_IN_PAST']);
    await runWithoutTenant(() => app.prisma.serviceProviderTimeOff.create({ data: { providerId: pro.providerId, date: new Date(Date.UTC(YY, MM - 1, DD)), start: '11:00', end: '12:00' } }));
    const off = await book(c.token, pro, hour, at(11));
    expect([off.statusCode, off.json().error.code]).toEqual([409, 'SLOT_UNAVAILABLE']);
    const gone = await makeOffering(pro.providerId, 60, 3000, false);
    const switchedOff = await book(c.token, pro, gone, at(10));
    expect([switchedOff.statusCode, switchedOff.json().error.code]).toEqual([409, 'OFFERING_UNAVAILABLE']);
    expect(await liveJobsOf(pro.providerId)).toEqual([]);
  });

  it('[P1 S4-4 ruling] a quote job holds two hours of the pro\'s day for a booking (the database still holds its minute)', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const quote = await runWithoutTenant(() => app.prisma.serviceJob.create({
      data: { customerId: c.userId, providerId: pro.providerId, description: 'Please quote this job', status: 'SCHEDULED', quoteAmount: new Prisma.Decimal(5000), scheduledFor: at(9) },
    }));
    expect(quote.endsAt).toBeNull();
    const hour = await makeOffering(pro.providerId, 60);
    expect(await slots(c.token, pro, hour)).toEqual(['11:00', '12:00']);
    const res = await book(c.token, pro, hour, at(10));
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'SLOT_TAKEN']);
    expect((await book(c.token, pro, hour, at(11))).statusCode).toBe(201);
  });

  it('a retried booking is the same booking: one job, one room', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const a = await book(c.token, pro, hour, at(12));
    const b = await book(c.token, pro, hour, at(12));
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(b.json().data.id).toBe(a.json().data.id);
    expect(await runWithoutTenant(() => app.prisma.chatRoom.count({ where: { serviceJobId: a.json().data.id } }))).toBe(1);
    expect((await liveJobsOf(pro.providerId)).length).toBe(1);
  });

  it('a customer holds at most two upcoming bookings with one pro (the store caps)', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    expect((await book(c.token, pro, hour, at(9))).statusCode).toBe(201);
    expect((await book(c.token, pro, hour, at(10))).statusCode).toBe(201);
    const third = await book(c.token, pro, hour, at(11));
    expect([third.statusCode, third.json().error.code]).toEqual([409, 'BOOKING_LIMIT_REACHED']);
  });

  it('the pro must be able to take new work (assertProviderCanOperate): a lapsed checklist books nothing', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    await runWithoutTenant(() => app.prisma.verificationDocument.updateMany({ where: { userId: pro.userId }, data: { status: 'EXPIRED' } }));
    const listed = await inject('GET', `/api/v1/services/providers/${pro.providerId}/offerings`, c.token);
    expect([listed.statusCode, listed.json().error.code]).toEqual([409, 'PROVIDER_NOT_VERIFIED']);
    const res = await book(c.token, pro, hour, at(10));
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'PROVIDER_NOT_VERIFIED']);
    expect(await liveJobsOf(pro.providerId)).toEqual([]);
  });

  it('nobody books themselves, and another tenant\'s pro reads as not found', async () => {
    on();
    const pro = await makePro('tutor');
    const hour = await makeOffering(pro.providerId, 60);
    const self = await book(pro.token, pro, hour, at(10));
    expect([self.statusCode, self.json().error.code]).toEqual([400, 'SELF_JOB']);
    const proB = await makePro('tutor', { tenantId: TENANT_B });
    const theirs = await makeOffering(proB.providerId, 60);
    const c = await makeUser();
    expect((await book(c.token, proB, theirs, at(10))).statusCode).toBe(404);
    expect((await inject('GET', `/api/v1/services/providers/${proB.providerId}/offerings`, c.token)).statusCode).toBe(404);
  });

  it('[REVIEW-M S4-2] a customer holds at most five upcoming bookings with pros in all (the store\'s total cap)', async () => {
    on();
    const c = await makeUser();
    const pros = [await makePro('tutor'), await makePro('cleaner'), await makePro('photographer')];
    const hours = await Promise.all(pros.map((p) => makeOffering(p.providerId, 60)));
    // Two with each of the first two pros (their own cap), one with the third: five in all.
    for (const [i, start] of [[0, at(9)], [0, at(10)], [1, at(9)], [1, at(10)], [2, at(9)]] as const) {
      const res = await book(c.token, pros[i]!, hours[i]!, start);
      expect(res.statusCode, res.body).toBe(201);
    }
    // The third pro has room for one more with this customer, but the customer is at five.
    const sixth = await book(c.token, pros[2]!, hours[2]!, at(10));
    expect([sixth.statusCode, sixth.json().error.code]).toEqual([409, 'BOOKING_LIMIT_REACHED']);
    expect(sixth.json().error.message).toContain('5 upcoming bookings with providers');
    expect((await liveJobsOf(pros[2]!.providerId)).length).toBe(1);
  });

  it('[REVIEW-X S4-4 · G1 G5] a blocked pair: the pro reads as not found to the customer (neutral), and a booking is refused 403 USER_BLOCKED', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    expect((await inject('GET', `/api/v1/services/providers/${pro.providerId}/offerings`, c.token)).statusCode).toBe(200);
    // The pro blocked this customer; the customer is never told whose decision it was.
    await runWithoutTenant(() => app.prisma.userBlock.create({ data: { tenantId: 'swift-default', blockerId: pro.userId, blockedId: c.userId, reason: 'test' } }));
    const notFound = { code: 'NOT_FOUND', message: `ServiceProvider with id ${pro.providerId} not found` };
    const listed = await inject('GET', `/api/v1/services/providers/${pro.providerId}/offerings`, c.token);
    expect([listed.statusCode, listed.json().error]).toEqual([404, expect.objectContaining(notFound)]);
    const open = await inject('GET', `/api/v1/services/providers/${pro.providerId}/slots?offeringId=${hour.id}&date=${DATE}`, c.token);
    expect([open.statusCode, open.json().error]).toEqual([404, expect.objectContaining(notFound)]);
    const res = await book(c.token, pro, hour, at(10));
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'USER_BLOCKED']);
    expect(await liveJobsOf(pro.providerId)).toEqual([]);
  });

  it('[REVIEW-G G4] an account that is not active (still verifying) books nothing: 403 CUSTOMER_NOT_ACTIVE', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    await runWithoutTenant(() => app.prisma.user.update({ where: { id: c.userId }, data: { status: 'PENDING_VERIFICATION' } }));
    const res = await book(c.token, pro, hour, at(10));
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'CUSTOMER_NOT_ACTIVE']);
    expect(await liveJobsOf(pro.providerId)).toEqual([]);
  });

  it('[REVIEW-G G3] another pro\'s service is not on this pro\'s menu: 404, nothing booked', async () => {
    on();
    const pro = await makePro('tutor');
    const other = await makePro('tutor');
    const theirs = await makeOffering(other.providerId, 60);
    const c = await makeUser();
    const res = await book(c.token, pro, theirs, at(10));
    expect([res.statusCode, res.json().error.code]).toEqual([404, 'NOT_FOUND']);
    expect(await liveJobsOf(pro.providerId)).toEqual([]);
    expect(await liveJobsOf(other.providerId)).toEqual([]);
  });
});

describe('switch on: cancel (owner B1) — free until two hours before', () => {
  it('a booking ten days ahead cancels free; the time is free again', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const res = await book(c.token, pro, hour, at(10));
    const ok = await cancel(c.token, res.json().data.id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await slots(c.token, pro, hour)).toEqual(['09:00', '10:00', '11:00', '12:00']);
  });

  it('inside two hours the app refuses, in the server\'s words, and the job screen says so first', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const job = await rowAppointment(pro, c.userId, hour, new Date(Date.now() + 90 * MIN));
    const read = await inject('GET', `/api/v1/services/jobs/${job.id}`, c.token);
    expect(read.json().data.appointment).toMatchObject({
      canCancel: false, cancelUnavailable: { code: 'CANCEL_WINDOW_CLOSED' }, canReschedule: false, rescheduleUnavailable: { code: 'RESCHEDULE_WINDOW_CLOSED' },
    });
    const refused = await cancel(c.token, job.id);
    expect([refused.statusCode, refused.json().error.code, refused.json().error.message]).toEqual([
      409, 'CANCEL_WINDOW_CLOSED', 'This booking can no longer be cancelled in the app: it starts in less than 2 hours. Contact the provider to change or cancel it.',
    ]);
    // The pro still cancels.
    expect((await cancel(pro.token, job.id)).statusCode).toBe(200);
  });

  it('a booking made inside two hours still cancels free for its first minute; a pro very late frees it again', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const fresh = await rowAppointment(pro, c.userId, hour, new Date(Date.now() + 60 * MIN), new Date());
    expect((await cancel(c.token, fresh.id)).statusCode).toBe(200);
    const late = await rowAppointment(pro, c.userId, hour, new Date(Date.now() - 40 * MIN), new Date(Date.now() - DAY));
    expect((await cancel(c.token, late.id)).statusCode).toBe(200);
  });

  it('a quote job, once booked, keeps its rule (contact the provider), switch on or not', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const quote = await runWithoutTenant(() => app.prisma.serviceJob.create({
      data: { customerId: c.userId, providerId: pro.providerId, description: 'Please quote this job', status: 'SCHEDULED', quoteAmount: new Prisma.Decimal(5000), scheduledFor: at(12) },
    }));
    const refused = await cancel(c.token, quote.id);
    expect([refused.statusCode, refused.json().error.code]).toEqual([409, 'SERVICE_JOB_BOOKED']);
    expect((await inject('GET', `/api/v1/services/jobs/${quote.id}`, c.token)).json().data).not.toHaveProperty('appointment');
  });
});

describe('switch on: move a booking (owner B2) — its end moves with its start', () => {
  it('the customer moves 10:00 to 12:00: start and end move, 10:00 is free, the pro is told', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const id = (await book(c.token, pro, hour, at(10))).json().data.id as string;
    const res = await reschedule(c.token, id, at(12));
    expect(res.statusCode, res.body).toBe(200);
    const job = await jobRow(id);
    expect([job.scheduledFor!.toISOString(), job.endsAt!.toISOString(), job.status]).toEqual([at(12).toISOString(), at(13).toISOString(), 'SCHEDULED']);
    expect(await slots(c.token, pro, hour)).toEqual(['09:00', '10:00', '11:00']);
    const told = await runWithoutTenant(() => app.prisma.notification.findMany({ where: { userId: pro.userId, data: { path: ['kind'], equals: 'booking_moved' } } }));
    expect(told.map((n) => (n.data as { jobId: string }).jobId)).toEqual([id]);
    const audit = await runWithoutTenant(() => app.prisma.auditLog.findMany({ where: { entity: 'ServiceJob', entityId: id }, orderBy: { createdAt: 'asc' } }));
    expect(audit.map((a) => a.action)).toEqual(['SERVICE_JOB_BOOKED', 'SERVICE_JOB_RESCHEDULED']);
  });

  it('a move keeps the booked length even if the service changed since, and may overlap its own old time', async () => {
    on();
    const pro = await makePro('tutor', { hours: [{ dayOfWeek: WEEKDAY, start: '09:00', end: '15:00' }] });
    const c = await makeUser();
    const two = await makeOffering(pro.providerId, 120);
    const id = (await book(c.token, pro, two, at(9))).json().data.id as string;
    await runWithoutTenant(() => app.prisma.serviceOffering.update({ where: { id: two.id }, data: { durationMinutes: 60 } }));
    // The pro's hours now start at 10:00: 10:00 is on the booked two-hour stride (10, 12) and overlaps
    // the job's own 09:00-11:00, which it leaves.
    await runWithoutTenant(() => app.prisma.serviceProvider.update({ where: { id: pro.providerId }, data: { weeklyHours: [{ dayOfWeek: WEEKDAY, start: '10:00', end: '16:00' }] } }));
    const res = await reschedule(pro.token, id, at(10));
    expect(res.statusCode, res.body).toBe(200);
    const job = await jobRow(id);
    expect([job.scheduledFor!.toISOString(), job.endsAt!.toISOString()]).toEqual([at(10).toISOString(), at(12).toISOString()]);
  });

  it('a move into a time another booking holds is refused (409 SLOT_TAKEN) and changes nothing', async () => {
    on();
    const pro = await makePro('tutor');
    const a = await makeUser();
    const b = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const mine = (await book(a.token, pro, hour, at(9))).json().data.id as string;
    await book(b.token, pro, hour, at(11));
    const res = await reschedule(a.token, mine, at(11));
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'SLOT_TAKEN']);
    expect((await jobRow(mine)).scheduledFor!.toISOString()).toBe(at(9).toISOString());
  });

  it('inside two hours the customer cannot move it; the pro can. A quote job and a stale screen cannot be moved', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const soon = await rowAppointment(pro, c.userId, hour, new Date(Date.now() + 90 * MIN));
    const refused = await reschedule(c.token, soon.id, at(10));
    expect([refused.statusCode, refused.json().error.code]).toEqual([409, 'RESCHEDULE_WINDOW_CLOSED']);
    const byPro = await reschedule(pro.token, soon.id, at(10));
    expect(byPro.statusCode, byPro.body).toBe(200);
    const quote = await runWithoutTenant(() => app.prisma.serviceJob.create({
      data: { customerId: c.userId, providerId: pro.providerId, description: 'Please quote this job', status: 'SCHEDULED', quoteAmount: new Prisma.Decimal(5000), scheduledFor: at(12) },
    }));
    const notMenu = await reschedule(c.token, quote.id, at(9));
    expect([notMenu.statusCode, notMenu.json().error.code]).toEqual([400, 'NOT_RESCHEDULABLE']);
    const job = await jobRow(soon.id);
    const stale = await inject('POST', `/api/v1/services/jobs/${soon.id}/reschedule`, pro.token, {
      scheduledFor: at(11).toISOString(), expectedUpdatedAt: new Date(job.updatedAt.getTime() - 1000).toISOString(), expectedScheduledFor: job.scheduledFor!.toISOString(),
    });
    expect([stale.statusCode, stale.json().error.code]).toEqual([409, 'SERVICE_JOB_CHANGED']);
  });

  it('[REVIEW-X S4-4 · G6] a third account cannot move it, not even to the same time (403, no job row handed back)', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const stranger = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const id = (await book(c.token, pro, hour, at(10))).json().data.id as string;
    const before = await jobRow(id);
    for (const to of [at(12), at(10)]) {
      const res = await reschedule(stranger.token, id, to);
      expect([res.statusCode, res.json().error?.code], res.body).toEqual([403, 'FORBIDDEN']);
      expect(res.body).not.toContain(c.userId);
    }
    const after = await jobRow(id);
    expect([after.scheduledFor!.toISOString(), after.updatedAt.toISOString()]).toEqual([before.scheduledFor!.toISOString(), before.updatedAt.toISOString()]);
  });
});

describe('the build-9 quote flow is unchanged with the switch on', () => {
  it('a tutor with a menu still runs request -> quote -> schedule -> confirm -> complete from the old app (no contract header)', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    await makeOffering(pro.providerId, 60);
    const created = await inject('POST', '/api/v1/services/jobs', c.token, { providerId: pro.providerId, description: 'Help with maths homework please' }, true);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().data.id as string;
    expect((await inject('POST', `/api/v1/services/jobs/${id}/quote`, pro.token, { amount: 4000 }, true)).statusCode).toBe(200);
    // A quote job a minute after a quote job: still booked, as before.
    const slot = new Date(Math.ceil((Date.now() + 5 * MIN) / MIN) * MIN);
    const scheduled = await inject('POST', `/api/v1/services/jobs/${id}/schedule`, c.token, { scheduledFor: slot.toISOString() }, true);
    expect(scheduled.statusCode, scheduled.body).toBe(200);
    expect((await inject('POST', `/api/v1/services/jobs/${id}/confirm`, pro.token, {}, true)).statusCode).toBe(200);
    await runWithoutTenant(() => app.prisma.serviceJob.update({ where: { id }, data: { scheduledFor: new Date(Date.now() - MIN) } }));
    const done = await inject('POST', `/api/v1/services/jobs/${id}/complete`, pro.token, {}, true);
    expect(done.statusCode, done.body).toBe(200);
    const job = await jobRow(id);
    expect([job.status, job.offeringId, job.endsAt, job.quoteAmount!.toString()]).toEqual(['COMPLETED', null, null, '4000']);
    const list = await inject('GET', '/api/v1/services/jobs', c.token, undefined, true);
    expect(list.json().data.find((j: { id: string }) => j.id === id)).not.toHaveProperty('appointment');
  });
});

describe('real Postgres races: one pro, one time', () => {
  it('six customers book the same time at once: exactly one wins, the rest get 409 SLOT_TAKEN', async () => {
    on();
    const pro = await makePro('tutor');
    const hour = await makeOffering(pro.providerId, 60);
    const customers = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
    const results = await Promise.all(customers.map((c) => book(c.token, pro, hour, at(11))));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes, results.map((r) => r.body).join('\n')).toEqual([201, 409, 409, 409, 409, 409]);
    expect(results.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === 'SLOT_TAKEN')).toBe(true);
    expect((await liveJobsOf(pro.providerId)).length).toBe(1);
  });

  it('two different services that overlap, booked at once: exactly one wins', async () => {
    on();
    const pro = await makePro('cleaner');
    const hour = await makeOffering(pro.providerId, 60);
    const half = await makeOffering(pro.providerId, 30, 1500);
    for (let round = 0; round < 3; round += 1) {
      const [a, b] = await Promise.all([makeUser(), makeUser()]);
      const start = at(9 + round);
      const results = await Promise.all([book(a.token, pro, hour, start), book(b.token, pro, half, new Date(start.getTime() + 30 * MIN))]);
      expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join('\n')).toEqual([201, 409]);
    }
    const live = await liveJobsOf(pro.providerId);
    expect(live.length).toBe(3);
    for (let i = 1; i < live.length; i += 1) expect(live[i]!.scheduledFor!.getTime()).toBeGreaterThanOrEqual(live[i - 1]!.endsAt!.getTime());
  });

  it('one customer\'s booking sent five times at once is one job', async () => {
    on();
    const pro = await makePro('photographer');
    const hour = await makeOffering(pro.providerId, 60);
    const c = await makeUser();
    const results = await Promise.all(Array.from({ length: 5 }, () => book(c.token, pro, hour, at(10))));
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.json().data.id)).size).toBe(1);
    expect((await liveJobsOf(pro.providerId)).length).toBe(1);
  });

  it('a write the time check could not see (another path, not yet committed) loses to the database: 409 SLOT_TAKEN, never a 500', async () => {
    on();
    const pro = await makePro('tutor');
    const hour = await makeOffering(pro.providerId, 60);
    const [other, c] = await Promise.all([makeUser(), makeUser()]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let inserted!: () => void;
    const ready = new Promise<void>((resolve) => { inserted = resolve; });
    // A quote job scheduled at 10:30 by the quote flow (which takes no pro-time lock), still uncommitted.
    const quoteTx = runWithoutTenant(() => app.prisma.$transaction(async (tx) => {
      await tx.serviceJob.create({
        data: { customerId: other.userId, providerId: pro.providerId, description: 'Please quote this job', status: 'SCHEDULED', quoteAmount: new Prisma.Decimal(5000), scheduledFor: at(10, 30) },
      });
      inserted();
      await held;
    }, { timeout: 20_000 }));
    await ready;
    const booking = book(c.token, pro, hour, at(10));
    await new Promise((resolve) => setTimeout(resolve, 600));
    release();
    await quoteTx;
    const res = await booking;
    expect([res.statusCode, res.json().error?.code], res.body).toEqual([409, 'SLOT_TAKEN']);
    expect((await liveJobsOf(pro.providerId)).map((j) => hhmm(j.scheduledFor!))).toEqual(['10:30']);
  });

  it('a move and a new booking racing for the same time: exactly one holds it', async () => {
    on();
    const pro = await makePro('tutor');
    const hour = await makeOffering(pro.providerId, 60);
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const mine = (await book(a.token, pro, hour, at(9))).json().data.id as string;
    const [moved, booked] = await Promise.all([reschedule(a.token, mine, at(12)), book(b.token, pro, hour, at(12))]);
    expect([moved.statusCode === 200, booked.statusCode === 201].filter(Boolean).length, `${moved.body}\n${booked.body}`).toBe(1);
    expect([moved, booked].find((r) => r.statusCode === 409)?.json().error.code).toBe('SLOT_TAKEN');
    const at12 = (await liveJobsOf(pro.providerId)).filter((j) => j.scheduledFor!.getTime() === at(12).getTime());
    expect(at12.length).toBe(1);
  });
});
