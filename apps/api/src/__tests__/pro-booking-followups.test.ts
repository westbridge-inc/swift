import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// The agreement version with the advance-acceptance clause: none exists on main yet (fail-closed, pinned in
// pro-booking.unit.test.ts), so this suite names one.
vi.mock('../modules/services/pro-menu-agreement-version', () => ({
  PRO_MENU_AGREEMENT: { documentType: 'vendor_agreement', sinceVersion: '2026-10-29' },
}));
const AGREEMENT_VERSION = '2026-10-29';

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
import { formatGuyanaTime, guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';
import { testPhone } from './helpers/fixture-ids';
import { installDdl } from './helpers/install-ddl';
import { runWithoutTenant } from '../plugins/tenant-context';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { lockProviderTime } from '../modules/services/provider-calendar';

// The heal below is raw DDL (idempotent; a no-op on a migrated database).
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [BOOK-P3] The #2209 follow-ups:
//  - COORD 16:13Z: a pro is bookable from their list only after accepting the
//    agreement version with the advance-acceptance clause; work already booked
//    is never gated;
//  - X S4-1: a closed job booked from the list shows no 'booked' block;
//  - X S4-2: the times to move a booking to come from its BOOKED length, its own
//    time not counted (GET /jobs/:id/slots), so the picker and the move agree;
//  - M S4-3: the pro's hours and time off queue on the pro-time lock, and a move
//    reads the hours under it;
//  - G S4-3: nothing is booked more than a year ahead;
//  - X S4-3 (a): the pro's move notice names the real end of the free cancel.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60_000;
let app: FastifyInstance;
const userIds: string[] = [];
const providerIds: string[] = [];
const TENANT_B = `pro-p3-tenant-${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, '0')}`;

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
      data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'book-p3', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
    });
    return { userId: user.id, token };
  });
}

/** A pro whose whole checklist a person approved (live verification), with weekly hours. */
async function makePro(trade = 'tutor', opts: { hours?: unknown; tenantId?: string; agreed?: string | null } = {}) {
  const u = await makeUser(opts.tenantId);
  const provider = await runWithoutTenant(() => app.prisma.serviceProvider.create({
    data: { userId: u.userId, trade, isVerified: true, weeklyHours: opts.hours === null ? Prisma.DbNull : ((opts.hours ?? HOURS_9_TO_13) as Prisma.InputJsonValue) },
  }));
  providerIds.push(provider.id);
  const checklist = await runWithoutTenant(() => providerChecklist(app.prisma, u.userId));
  for (const docType of checklist) {
    await runWithoutTenant(() => app.prisma.verificationDocument.create({
      data: { userId: u.userId, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}.jpg`, status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
    }));
  }
  const agreed = opts.agreed === undefined ? AGREEMENT_VERSION : opts.agreed;
  if (agreed) await consent(u.userId, agreed, 'granted');
  return { ...u, providerId: provider.id, checklist };
}

async function makeOffering(providerId: string, durationMinutes: number, price = 3000, active = true) {
  return runWithoutTenant(() => app.prisma.serviceOffering.create({
    data: { providerId, name: `Lesson ${durationMinutes}`, durationMinutes, price: new Prisma.Decimal(price), active },
  }));
}

function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, legacy = false) {
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

async function consent(userId: string, version: string, action: 'granted' | 'withdrawn' | 're_granted') {
  await runWithoutTenant(() => app.prisma.consentRecord.create({
    data: { subjectType: 'vendor_user', subjectId: userId, documentType: 'vendor_agreement', documentVersion: version, documentContentHash: 'book-p3-test', action, surface: 'ios' },
  }));
  // capturedAt orders the rows: keep them apart.
  await new Promise((r) => setTimeout(r, 5));
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
    await purgeAuditLogs(app.prisma, { userId: { in: ids } }, 'test-cleanup:book-p3');
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
  await runWithoutTenant(() => app.prisma.tenant.upsert({ where: { id: TENANT_B }, update: {}, create: { id: TENANT_B, name: 'Pro P3 Tenant B', slug: TENANT_B } }));
});

afterEach(() => { delete process.env['INSTANT_BOOKING']; });

afterAll(async () => {
  await purge();
  await runWithoutTenant(() => app.prisma.tenant.deleteMany({ where: { id: TENANT_B } }));
  await app.close();
});

const on = () => { process.env['INSTANT_BOOKING'] = '1'; };
const errorOf = (res: { statusCode: number; json(): { error?: { code?: string } } }) => [res.statusCode, res.json().error?.code];

describe('[COORD 16:13Z] a pro is bookable from their list only after accepting the agreement with the advance-acceptance clause', () => {
  it('a pro who never accepted it: the list, the free times and the booking are refused (409), nothing is written; the pro is told', async () => {
    on();
    const pro = await makePro('tutor', { agreed: null });
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    expect(errorOf(await inject('GET', `/api/v1/services/providers/${pro.providerId}/offerings`, c.token))).toEqual([409, 'PROVIDER_AGREEMENT_PENDING']);
    expect(errorOf(await inject('GET', `/api/v1/services/providers/${pro.providerId}/slots?offeringId=${hour.id}&date=${DATE}`, c.token))).toEqual([409, 'PROVIDER_AGREEMENT_PENDING']);
    const refused = await book(c.token, pro, hour, at(10));
    expect(errorOf(refused)).toEqual([409, 'PROVIDER_AGREEMENT_PENDING']);
    expect(refused.json().error.message).toBe('This provider isn’t taking bookings from their list of services yet. Ask them for a quote instead.');
    expect(await liveJobsOf(pro.providerId)).toEqual([]);
    const mine = await inject('GET', '/api/v1/services/providers/me/bookable', pro.token);
    expect(mine.json().data).toMatchObject({ bookable: true, agreementAccepted: false });
  });

  it('the latest acceptance decides: an older version no; the clause version yes; withdrawn no; a later version yes', async () => {
    on();
    const pro = await makePro('tutor', { agreed: '2026-10-28.1' });
    const c = await makeUser();
    await makeOffering(pro.providerId, 60);
    const list = () => inject('GET', `/api/v1/services/providers/${pro.providerId}/offerings`, c.token);
    const mine = async () => (await inject('GET', '/api/v1/services/providers/me/bookable', pro.token)).json().data.agreementAccepted;
    expect(errorOf(await list())).toEqual([409, 'PROVIDER_AGREEMENT_PENDING']);
    expect(await mine()).toBe(false);
    await consent(pro.userId, AGREEMENT_VERSION, 're_granted');
    expect((await list()).statusCode).toBe(200);
    expect(await mine()).toBe(true);
    await consent(pro.userId, AGREEMENT_VERSION, 'withdrawn');
    expect(errorOf(await list())).toEqual([409, 'PROVIDER_AGREEMENT_PENDING']);
    await consent(pro.userId, '2026-11-02', 'granted');
    expect((await list()).statusCode).toBe(200);
  });

  it('work already booked is never gated: after the pro withdraws, the customer still moves and cancels it', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const id = (await book(c.token, pro, hour, at(10))).json().data.id as string;
    await consent(pro.userId, AGREEMENT_VERSION, 'withdrawn');
    const moved = await reschedule(c.token, id, at(12));
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await cancel(c.token, id)).statusCode).toBe(200);
  });
});

describe('[X S4-1] a closed job booked from the list shows no "booked, contact your provider" block', () => {
  it('completed and cancelled: nothing offered, nothing blocked', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    for (const status of ['COMPLETED', 'CANCELLED'] as const) {
      const job = await rowAppointment(pro, c.userId, hour, new Date(Date.now() - 3 * DAY));
      await runWithoutTenant(() => app.prisma.serviceJob.update({
        where: { id: job.id }, data: { status, ...(status === 'COMPLETED' ? { completedAt: new Date() } : { cancelledAt: new Date() }) },
      }));
      const read = await inject('GET', `/api/v1/services/jobs/${job.id}`, c.token);
      expect(read.json().data.appointment, status).toEqual({
        canCancel: false, freeCancellationExpiresAt: null, cancellationMessage: null, cancelUnavailable: null, canReschedule: false, rescheduleUnavailable: null,
      });
      const list = await inject('GET', '/api/v1/services/jobs', c.token);
      const listed = (list.json().data as Array<{ id: string; appointment?: { cancelUnavailable: unknown } }>).find((j) => j.id === job.id);
      expect(listed?.appointment?.cancelUnavailable, status).toBeNull();
    }
  });
});

describe('[X S4-2] the times to move a booking to: its booked length, its own time not counted', () => {
  it('after the service grows to two hours, the move list keeps the booked hour; every time listed is a time the move takes', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const id = (await book(c.token, pro, hour, at(10))).json().data.id as string;
    await runWithoutTenant(() => app.prisma.serviceOffering.update({ where: { id: hour.id }, data: { durationMinutes: 120 } }));
    // The list for a NEW booking now reads two hours (and 10:00-11:00 is held): only 11:00.
    expect(await slots(c.token, pro, hour)).toEqual(['11:00']);
    const res = await inject('GET', `/api/v1/services/jobs/${id}/slots?date=${DATE}`, c.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ jobId: id, durationMinutes: 60, currentStart: at(10).toISOString(), horizonDays: 366 });
    // Booked hour, own 10:00 not counted as taken (and not offered: it is where the job is).
    expect((res.json().data.slots as string[]).map(hhmm)).toEqual(['09:00', '11:00', '12:00']);
    const byPro = await inject('GET', `/api/v1/services/jobs/${id}/slots?date=${DATE}`, pro.token);
    expect((byPro.json().data.slots as string[]).map(hhmm)).toEqual(['09:00', '11:00', '12:00']);
    // 12:00 is not on the new-booking list (a two-hour service would end after 13:00) but the move takes it.
    const moved = await reschedule(c.token, id, at(12));
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await jobRow(id)).endsAt!.toISOString()).toBe(at(13).toISOString());
  });

  it('a move may overlap the job\'s own old time: the list offers it (the job does not hold the time it leaves)', async () => {
    on();
    const pro = await makePro('tutor', { hours: [{ dayOfWeek: WEEKDAY, start: '09:00', end: '15:00' }] });
    const c = await makeUser();
    const two = await makeOffering(pro.providerId, 120);
    const id = (await book(c.token, pro, two, at(9))).json().data.id as string;
    // The hours now start at 10:00: the two-hour stride is 10, 12; 10:00-12:00 overlaps the job's own 09:00-11:00.
    await runWithoutTenant(() => app.prisma.serviceProvider.update({ where: { id: pro.providerId }, data: { weeklyHours: [{ dayOfWeek: WEEKDAY, start: '10:00', end: '16:00' }] } }));
    const res = await inject('GET', `/api/v1/services/jobs/${id}/slots?date=${DATE}`, c.token);
    expect((res.json().data.slots as string[]).map(hhmm)).toEqual(['10:00', '12:00', '14:00']);
    expect((await reschedule(c.token, id, at(10))).statusCode).toBe(200);
  });

  it('refused to a third account (403), for a quote job (400), to the customer inside two hours (409, the move\'s own words), with the switch off (404), for a bad date (400)', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const stranger = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const id = (await book(c.token, pro, hour, at(10))).json().data.id as string;
    const url = (jobId: string, date = DATE) => `/api/v1/services/jobs/${jobId}/slots?date=${date}`;
    const third = await inject('GET', url(id), stranger.token);
    expect(errorOf(third)).toEqual([403, 'FORBIDDEN']);
    expect(third.body).not.toContain(c.userId);
    const quote = await runWithoutTenant(() => app.prisma.serviceJob.create({
      data: { customerId: c.userId, providerId: pro.providerId, description: 'Please quote this job', status: 'SCHEDULED', quoteAmount: new Prisma.Decimal(5000), scheduledFor: at(12) },
    }));
    expect(errorOf(await inject('GET', url(quote.id), c.token))).toEqual([400, 'NOT_RESCHEDULABLE']);
    const soon = await rowAppointment(pro, c.userId, hour, new Date(Date.now() + 90 * MIN));
    expect(errorOf(await inject('GET', url(soon.id), c.token))).toEqual([409, 'RESCHEDULE_WINDOW_CLOSED']);
    expect((await inject('GET', url(soon.id), pro.token)).statusCode).toBe(200);
    expect(errorOf(await inject('GET', url(id, '2026-02-30'), c.token))).toEqual([400, 'BAD_DATE']);
    delete process.env['INSTANT_BOOKING'];
    expect(errorOf(await inject('GET', url(id), c.token))).toEqual([404, 'PRO_BOOKING_OFF']);
  });
});

describe('[G S4-3] nothing is booked more than a year ahead (the time off horizon)', () => {
  it('a date past 366 days lists no times; a booking or a move there is refused 409 TOO_FAR_AHEAD', async () => {
    on();
    const everyDay = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, start: '09:00', end: '13:00' }));
    const pro = await makePro('tutor', { hours: everyDay });
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const far = guyanaDayKey(new Date(Date.now() + 368 * DAY));
    const near = guyanaDayKey(new Date(Date.now() + 300 * DAY));
    expect(await slots(c.token, pro, hour, far)).toEqual([]);
    expect(await slots(c.token, pro, hour, near)).toEqual(['09:00', '10:00', '11:00', '12:00']);
    const [y, m, d] = far.split('-').map(Number) as [number, number, number];
    const farTen = instantOfGuyanaWallClock(new Date(Date.UTC(y, m - 1, d, 10)));
    expect(errorOf(await book(c.token, pro, hour, farTen))).toEqual([409, 'TOO_FAR_AHEAD']);
    const id = (await book(c.token, pro, hour, at(10))).json().data.id as string;
    expect(errorOf(await reschedule(pro.token, id, farTen))).toEqual([409, 'TOO_FAR_AHEAD']);
    expect(await liveJobsOf(pro.providerId)).toHaveLength(1);
    const offered = await inject('GET', `/api/v1/services/providers/${pro.providerId}/offerings`, c.token);
    expect(offered.json().data.horizonDays).toBe(366);
  });
});

/** Hold the pro-time lock in a transaction of our own until `release` is called; `ready` resolves once it is held. */
function holdProTime(providerId: string, inside?: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let release!: () => void;
  let held!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ready = new Promise<void>((r) => { held = r; });
  const done = runWithoutTenant(() => app.prisma.$transaction(async (tx) => {
    await lockProviderTime(tx, providerId);
    if (inside) await inside(tx);
    held();
    await gate;
  }, { timeout: 20_000 }));
  return { ready, release, done };
}

const stillWaiting = async (p: Promise<unknown>, ms = 600) => Promise.race([p.then(() => 'done'), new Promise((r) => setTimeout(() => r('waiting'), ms))]);

describe('[M S4-3] the pro\'s own time edits queue with bookings and moves (pro-time lock)', () => {
  it('weekly hours, a day off and taking a day off back each wait for a booking or move holding the pro\'s time', async () => {
    on();
    const pro = await makePro('tutor');
    const off = await inject('POST', '/api/v1/services/providers/me/time-off', pro.token, { date: DATE, start: '12:00', end: '13:00' });
    expect(off.statusCode, off.body).toBe(200);
    const writes: Array<() => ReturnType<typeof inject>> = [
      () => inject('PUT', '/api/v1/services/providers/me/hours', pro.token, { slots: HOURS_9_TO_13 }),
      () => inject('POST', '/api/v1/services/providers/me/time-off', pro.token, { date: DATE }),
      () => inject('DELETE', `/api/v1/services/providers/me/time-off/${off.json().data.id}`, pro.token),
    ];
    for (const [i, write] of writes.entries()) {
      const hold = holdProTime(pro.providerId);
      await hold.ready;
      const pending = write();
      expect(await stillWaiting(pending), `write ${i}`).toBe('waiting');
      hold.release();
      await hold.done;
      const res = await pending;
      expect(res.statusCode, `write ${i} ${res.body}`).toBe(200);
    }
  });

  it('a move reads the pro\'s hours under the lock: hours cut while it waited refuse the time (409 SLOT_UNAVAILABLE)', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const id = (await book(c.token, pro, hour, at(10))).json().data.id as string;
    // Another writer of the pro's time cuts the day to 09:00-11:00 and commits after the move has read the job.
    const hold = holdProTime(pro.providerId, (tx) => tx.serviceProvider.update({
      where: { id: pro.providerId }, data: { weeklyHours: [{ dayOfWeek: WEEKDAY, start: '09:00', end: '11:00' }] },
    }));
    await hold.ready;
    const pending = reschedule(c.token, id, at(12));
    expect(await stillWaiting(pending)).toBe('waiting');
    hold.release();
    await hold.done;
    expect(errorOf(await pending)).toEqual([409, 'SLOT_UNAVAILABLE']);
    expect((await jobRow(id)).scheduledFor!.toISOString()).toBe(at(10).toISOString());
  });

  it('a day off never cancels a booking: the pro is told how many booked jobs it overlaps', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    await book(c.token, pro, hour, at(10));
    const whole = await inject('POST', '/api/v1/services/providers/me/time-off', pro.token, { date: DATE });
    expect(whole.json().data.clashingBookings).toBe(1);
    const window = await inject('POST', '/api/v1/services/providers/me/time-off', pro.token, { date: DATE, start: '11:00', end: '12:00' });
    expect(window.json().data.clashingBookings).toBe(0);
    expect(await liveJobsOf(pro.providerId)).toHaveLength(1);
  });
});

describe('[X S4-3 (a)] the pro\'s move notice names the real end of the customer\'s free cancel', () => {
  it('"cancel it free in the app until <two hours before the new start>", never a bare "or cancel it"', async () => {
    on();
    const pro = await makePro('tutor');
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const id = (await book(c.token, pro, hour, at(10))).json().data.id as string;
    expect((await reschedule(pro.token, id, at(12))).statusCode).toBe(200);
    const told = await runWithoutTenant(() => app.prisma.notification.findMany({ where: { userId: c.userId, data: { path: ['kind'], equals: 'booking_moved' } } }));
    expect(told).toHaveLength(1);
    const until = formatGuyanaTime(at(10), { weekday: 'short', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short', hour12: true }, 'en-US');
    expect(told[0]!.body).toContain(`cancel it free in the app until ${until}, or contact them.`);
    expect(told[0]!.body).not.toContain('contact them or cancel it');
  });
});

describe('[BOOK-P3] browse says which pros take bookings from their list (the phone\'s Book button)', () => {
  it('only a pro with hours, an active service and the agreement; nobody with the switch off', async () => {
    on();
    const ready = await makePro('cleaner');
    await makeOffering(ready.providerId, 60);
    const noAgreement = await makePro('cleaner', { agreed: null });
    await makeOffering(noAgreement.providerId, 60);
    const noService = await makePro('cleaner');
    await makeOffering(noService.providerId, 60, 3000, false);
    const noHours = await makePro('cleaner', { hours: null });
    await makeOffering(noHours.providerId, 60);
    const c = await makeUser();
    const read = async () => {
      const res = await inject('GET', '/api/v1/services/providers?trade=cleaner&limit=50', c.token);
      expect(res.statusCode, res.body).toBe(200);
      const rows = res.json().data.providers as Array<{ id: string; bookableFromList: boolean }>;
      return Object.fromEntries([ready, noAgreement, noService, noHours].map((p) => [p.providerId, rows.find((r) => r.id === p.providerId)?.bookableFromList]));
    };
    expect(await read()).toEqual({ [ready.providerId]: true, [noAgreement.providerId]: false, [noService.providerId]: false, [noHours.providerId]: false });
    delete process.env['INSTANT_BOOKING'];
    expect(Object.values(await read())).toEqual([false, false, false, false]);
  });
});
