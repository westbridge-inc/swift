import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
import { registerErrorHandler } from '../middleware/error-handler';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { rlsDdlFor, tenantLineageDdl } from '../lib/tenant-rls';
import { providerTimeDdl, isServiceJobExclusionViolation } from '../modules/services/provider-time';
import { providerDaySlots } from '../modules/services/provider-calendar';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';
import { testPhone } from './helpers/fixture-ids';
import { installDdl } from './helpers/install-ddl';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { deidentifyProfiles } from '../modules/user/erasure-coverage';
import { grantSuiteCapability } from '../lib/test-target-lock';

// The heal below is raw DDL (idempotent; a no-op on a migrated database).
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [BOOK-P1 Track P] ONE PRO, ONE TIME, and a pro's own bookable services,
// weekly hours and time off.
//
// A live job holds the provider from its start to its end (a booked service)
// or for its minimum block (a quote job: the minute it starts in), and no two
// live jobs of one provider overlap: the schedule route refuses, and the
// database refuses a write that skips it. A slot is minute-grained. The
// provider's day slots come from the one booking engine. The settings routes
// are the provider's own, behind INSTANT_BOOKING, for the first bookable
// categories only, and walled per tenant like the jobs they book.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60_000;
let app: FastifyInstance;
const userIds: string[] = [];
const providerIds: string[] = [];
const TENANT_B = `pro-p1-tenant-${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, '0')}`;

/** A date 10 days ahead (Guyana), and true instants on it. */
const DATE = guyanaDayKey(new Date(Date.now() + 10 * DAY));
const [YY, MM, DD] = DATE.split('-').map(Number) as [number, number, number];
const at = (hh: number, mm = 0, ss = 0) => instantOfGuyanaWallClock(new Date(Date.UTC(YY, MM - 1, DD, hh, mm, ss)));
const hhmm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Guyana', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const WEEKDAY = new Date(Date.UTC(YY, MM - 1, DD)).getUTCDay();

async function makeUser(tenantId = 'swift-default') {
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: testPhone(), firstName: 'Pro', lastName: 'P1', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId,
        isPhoneVerified: true, customer: { create: {} },
      },
    });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'book-p1', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
    });
    return { userId: user.id, token };
  });
}

async function makeProvider(trade = 'tutor', tenantId = 'swift-default') {
  const u = await makeUser(tenantId);
  const provider = await runWithoutTenant(() => app.prisma.serviceProvider.create({ data: { userId: u.userId, trade, isVerified: true } }));
  providerIds.push(provider.id);
  return { ...u, providerId: provider.id };
}

async function makeOffering(providerId: string, durationMinutes: number, price = 3000) {
  return runWithoutTenant(() => app.prisma.serviceOffering.create({ data: { providerId, name: `Lesson ${durationMinutes}`, durationMinutes, price: new Prisma.Decimal(price) } }));
}

/** A job booked from the provider's menu (P2 writes these; here the row is made directly). */
async function bookedJob(p: { providerId: string }, customerId: string, offering: { id: string; durationMinutes: number }, start: Date) {
  return runWithoutTenant(() => app.prisma.serviceJob.create({
    data: {
      customerId, providerId: p.providerId, description: 'Booked from the menu', status: 'SCHEDULED',
      quoteAmount: new Prisma.Decimal(3000), scheduledFor: start, endsAt: new Date(start.getTime() + offering.durationMinutes * MIN),
      offeringId: offering.id, providerConfirmedAt: new Date(),
    },
  }));
}

/** A quoted job waiting for the customer to pick a time (the quote flow, before /schedule). */
async function quotedJob(p: { providerId: string }, customerId: string) {
  return runWithoutTenant(() => app.prisma.serviceJob.create({
    data: { customerId, providerId: p.providerId, description: 'Please quote this job', status: 'QUOTED', quoteAmount: new Prisma.Decimal(5000) },
  }));
}

function inject(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
      [SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER]: SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION,
    },
  });
}

async function schedule(jobId: string, token: string, scheduledFor: Date) {
  const job = await runWithoutTenant(() => app.prisma.serviceJob.findUniqueOrThrow({ where: { id: jobId } }));
  return inject('POST', `/api/v1/services/jobs/${jobId}/schedule`, token, {
    scheduledFor: scheduledFor.toISOString(), expectedUpdatedAt: job.updatedAt.toISOString(), expectedQuoteAmount: Number(job.quoteAmount),
  });
}

async function purge() {
  await runWithoutTenant(async () => {
    const ids = [...userIds];
    if (ids.length === 0) return;
    await app.prisma.serviceJob.deleteMany({ where: { providerId: { in: providerIds } } });
    await app.prisma.serviceJob.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.serviceProviderTimeOff.deleteMany({ where: { providerId: { in: providerIds } } });
    await app.prisma.serviceOffering.deleteMany({ where: { providerId: { in: providerIds } } });
    await app.prisma.serviceProvider.deleteMany({ where: { id: { in: providerIds } } });
    await purgeAuditLogs(app.prisma, { userId: { in: ids } }, 'test-cleanup:book-p1');
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
  await app.ready();
  // A db-push database lacks the raw SQL: heal it with the migration's own statements (a no-op on a migrated one).
  await installDdl(app.prisma, [
    ...providerTimeDdl(),
    ...['service_offerings', 'service_provider_time_off'].flatMap((t) => rlsDdlFor(t)),
    ...tenantLineageDdl().filter((s) => s.includes('_tenant_matches_provider')),
  ]);
  await runWithoutTenant(() => app.prisma.tenant.upsert({ where: { id: TENANT_B }, update: {}, create: { id: TENANT_B, name: 'Pro P1 Tenant B', slug: TENANT_B } }));
});

afterEach(() => { delete process.env['INSTANT_BOOKING']; });

afterAll(async () => {
  await purge();
  await runWithoutTenant(() => app.prisma.tenant.deleteMany({ where: { id: TENANT_B } }));
  await app.close();
});

describe('one pro, one time: a live job holds the provider until it ends', () => {
  it('a 09:00 three-hour booked job: another customer cannot schedule the pro at 10:00 (409 SLOT_TAKEN)', async () => {
    const pro = await makeProvider();
    const first = await makeUser();
    const second = await makeUser();
    const threeHours = await makeOffering(pro.providerId, 180);
    await bookedJob(pro, first.userId, threeHours, at(9));
    const job = await quotedJob(pro, second.userId);
    const res = await schedule(job.id, second.token, at(10));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('SLOT_TAKEN');
    const after = await runWithoutTenant(() => app.prisma.serviceJob.findUniqueOrThrow({ where: { id: job.id } }));
    expect([after.status, after.scheduledFor]).toEqual(['QUOTED', null]);
  });

  it('back to back is not an overlap: 12:00, when the three hours end, is free', async () => {
    const pro = await makeProvider();
    const first = await makeUser();
    const second = await makeUser();
    await bookedJob(pro, first.userId, await makeOffering(pro.providerId, 180), at(9));
    const res = await schedule((await quotedJob(pro, second.userId)).id, second.token, at(12));
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a slot is minute-grained: 09:00:01 is the 09:00 slot, refused once 09:00 is held, and stored on its minute', async () => {
    const pro = await makeProvider();
    const a = await makeUser();
    const b = await makeUser();
    const held = await schedule((await quotedJob(pro, a.userId)).id, a.token, at(9, 0, 30));
    expect(held.statusCode, held.body).toBe(200);
    expect(new Date(held.json().data.scheduledFor).toISOString()).toBe(at(9).toISOString());
    const seconds = await schedule((await quotedJob(pro, b.userId)).id, b.token, at(9, 0, 1));
    expect(seconds.statusCode, seconds.body).toBe(409);
    expect(seconds.json().error.code).toBe('SLOT_TAKEN');
  });

  it('the quote flow keeps what it had: two quote jobs a minute apart are both booked', async () => {
    const pro = await makeProvider();
    const a = await makeUser();
    const b = await makeUser();
    expect((await schedule((await quotedJob(pro, a.userId)).id, a.token, at(14))).statusCode).toBe(200);
    expect((await schedule((await quotedJob(pro, b.userId)).id, b.token, at(14, 1))).statusCode).toBe(200);
  });

  it('the database itself refuses a second live job that overlaps; a cancelled or finished job holds nothing', async () => {
    const pro = await makeProvider();
    const c = await makeUser();
    const hour = await makeOffering(pro.providerId, 60);
    const first = await bookedJob(pro, c.userId, hour, at(15));
    const overlap = await bookedJob(pro, c.userId, hour, at(15, 30)).then(() => null, (e: unknown) => e);
    expect(isServiceJobExclusionViolation(overlap), String(overlap)).toBe(true);
    await runWithoutTenant(() => app.prisma.serviceJob.update({ where: { id: first.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } }));
    const second = await bookedJob(pro, c.userId, hour, at(15, 30));
    await runWithoutTenant(() => app.prisma.serviceJob.update({ where: { id: second.id }, data: { status: 'COMPLETED', completedAt: new Date() } }));
    await expect(bookedJob(pro, c.userId, hour, at(15))).resolves.toMatchObject({ status: 'SCHEDULED' });
  });

  it('a job names only a service of its own provider, and an end comes after its start', async () => {
    const pro = await makeProvider();
    const other = await makeProvider();
    const c = await makeUser();
    const theirs = await makeOffering(other.providerId, 60);
    await expect(bookedJob(pro, c.userId, theirs, at(16))).rejects.toThrow(/belongs to provider/);
    const mine = await makeOffering(pro.providerId, 60);
    await expect(runWithoutTenant(() => app.prisma.serviceJob.create({
      data: { customerId: c.userId, providerId: pro.providerId, description: 'Ends before it starts', status: 'SCHEDULED', scheduledFor: at(16), endsAt: at(16), offeringId: mine.id },
    }))).rejects.toThrow(/service_jobs_ends_after_start/);
  });

  it('declining the time frees it: the job keeps no start and no end', async () => {
    const pro = await makeProvider();
    const c = await makeUser();
    const job = await bookedJob(pro, c.userId, await makeOffering(pro.providerId, 60), at(11));
    await runWithoutTenant(() => app.prisma.serviceJob.update({ where: { id: job.id }, data: { providerConfirmedAt: null } }));
    const fresh = await runWithoutTenant(() => app.prisma.serviceJob.findUniqueOrThrow({ where: { id: job.id } }));
    const res = await inject('POST', `/api/v1/services/jobs/${job.id}/decline-slot`, pro.token, {
      expectedUpdatedAt: fresh.updatedAt.toISOString(), expectedScheduledFor: fresh.scheduledFor!.toISOString(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await runWithoutTenant(() => app.prisma.serviceJob.findUniqueOrThrow({ where: { id: job.id } }));
    expect([after.status, after.scheduledFor, after.endsAt]).toEqual(['QUOTED', null, null]);
  });
});

describe('one engine: a pro day comes from the same calendar computation as a listing', () => {
  // [BOOK-P2 · P1 S4-4 ruling] For a booking from the menu a quote job holds two hours of the pro's day
  // (QUOTE_JOB_PICKER_BLOCK_MINUTES); the database still holds its minute (the quote-flow tests above).
  it('subtracts every live job of the provider (a booked service its length, a quote job two hours) and their time off', async () => {
    const pro = await makeProvider();
    const c = await makeUser();
    const hours = [{ dayOfWeek: WEEKDAY, start: '09:00', end: '15:00' }];
    const hour = await makeOffering(pro.providerId, 60);
    await bookedJob(pro, c.userId, await makeOffering(pro.providerId, 120), at(9));
    const quote = await quotedJob(pro, c.userId);
    await runWithoutTenant(() => app.prisma.serviceJob.update({ where: { id: quote.id }, data: { status: 'SCHEDULED', scheduledFor: at(12, 30) } }));
    await runWithoutTenant(() => app.prisma.serviceProviderTimeOff.create({ data: { providerId: pro.providerId, date: new Date(Date.UTC(YY, MM - 1, DD)), start: '14:00', end: '15:00' } }));
    // A cancelled job holds nothing: 11:00 stays free (the quote job at 12:30 holds 12:30-14:30).
    const cancelled = await bookedJob(pro, c.userId, hour, at(11));
    await runWithoutTenant(() => app.prisma.serviceJob.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } }));
    const slots = await runWithoutTenant(() => providerDaySlots(app.prisma, { providerId: pro.providerId, weeklyHours: hours, offering: hour, date: DATE }));
    expect(slots.map(hhmm)).toEqual(['11:00']);
  });
});

describe('a pro sets up bookable services, weekly hours and time off', () => {
  it('while INSTANT_BOOKING is off every route answers 404 PRO_BOOKING_OFF and writes nothing', async () => {
    const pro = await makeProvider();
    const mine = await makeOffering(pro.providerId, 60);
    const calls: Array<[Parameters<typeof inject>[0], string, unknown?]> = [
      ['GET', '/api/v1/services/providers/me/bookable'],
      ['POST', '/api/v1/services/providers/me/offerings', { name: 'Maths lesson', durationMinutes: 60, price: 3000 }],
      ['PATCH', `/api/v1/services/providers/me/offerings/${mine.id}`, { active: false }],
      ['PUT', '/api/v1/services/providers/me/hours', { slots: [{ dayOfWeek: 1, start: '09:00', end: '12:00' }] }],
      ['POST', '/api/v1/services/providers/me/time-off', { date: DATE }],
      ['DELETE', '/api/v1/services/providers/me/time-off/none'],
      // [REVIEW-X S4-5] Off is off before the body is read: a malformed body is not a 400.
      ['POST', '/api/v1/services/providers/me/offerings', { name: 'x', durationMinutes: 1, price: -1 }],
      ['PUT', '/api/v1/services/providers/me/hours', { slots: 'junk' }],
      ['POST', '/api/v1/services/providers/me/time-off', { date: 'not a date' }],
    ];
    for (const [method, url, body] of calls) {
      const res = await inject(method, url, pro.token, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().error.code, `${method} ${url}`).toBe('PRO_BOOKING_OFF');
    }
    const stored = await runWithoutTenant(async () => ({
      offerings: await app.prisma.serviceOffering.findMany({ where: { providerId: pro.providerId } }),
      timeOff: await app.prisma.serviceProviderTimeOff.count({ where: { providerId: pro.providerId } }),
      provider: await app.prisma.serviceProvider.findUniqueOrThrow({ where: { id: pro.providerId } }),
    }));
    expect(stored.offerings.map((o) => [o.id, o.active])).toEqual([[mine.id, true]]);
    expect(stored.timeOff).toBe(0);
    expect(stored.provider.weeklyHours).toBeNull();
  });

  it('with it on: a tutor adds a service, changes it, sets hours and a day off, and reads them back', async () => {
    process.env['INSTANT_BOOKING'] = '1';
    const pro = await makeProvider('tutor');
    const added = await inject('POST', '/api/v1/services/providers/me/offerings', pro.token, { name: 'Maths lesson', durationMinutes: 60, price: 3000 });
    expect(added.statusCode, added.body).toBe(200);
    const id = added.json().data.id as string;
    expect(added.json().data).toMatchObject({ name: 'Maths lesson', durationMinutes: 60, price: 3000, active: true });
    const changed = await inject('PATCH', `/api/v1/services/providers/me/offerings/${id}`, pro.token, { price: 3500.5, durationMinutes: 90 });
    expect(changed.json().data).toMatchObject({ price: 3500.5, durationMinutes: 90 });
    const hours = await inject('PUT', '/api/v1/services/providers/me/hours', pro.token, {
      slots: [{ dayOfWeek: 3, start: '13:00', end: '17:00' }, { dayOfWeek: 1, start: '09:00', end: '12:00' }],
    });
    expect(hours.statusCode, hours.body).toBe(200);
    const off = await inject('POST', '/api/v1/services/providers/me/time-off', pro.token, { date: DATE, start: '10:00', end: '11:00' });
    expect(off.statusCode, off.body).toBe(200);
    const read = await inject('GET', '/api/v1/services/providers/me/bookable', pro.token);
    expect(read.json().data).toMatchObject({
      bookable: true,
      offerings: [{ id, name: 'Maths lesson', durationMinutes: 90, price: 3500.5, active: true }],
      weeklyHours: [{ dayOfWeek: 1, start: '09:00', end: '12:00' }, { dayOfWeek: 3, start: '13:00', end: '17:00' }],
      timeOff: [{ id: off.json().data.id, date: DATE, start: '10:00', end: '11:00' }],
    });
    const removed = await inject('DELETE', `/api/v1/services/providers/me/time-off/${off.json().data.id}`, pro.token);
    expect(removed.statusCode).toBe(200);
    const stored = await runWithoutTenant(() => app.prisma.serviceOffering.findUniqueOrThrow({ where: { id } }));
    expect(stored.price.toString()).toBe('3500.5');
  });

  it('refuses what is not allowed: overlapping hours, a past day, a trade without a bookable menu', async () => {
    process.env['INSTANT_BOOKING'] = '1';
    const pro = await makeProvider('cleaner');
    const overlap = await inject('PUT', '/api/v1/services/providers/me/hours', pro.token, {
      slots: [{ dayOfWeek: 2, start: '09:00', end: '12:00' }, { dayOfWeek: 2, start: '11:00', end: '13:00' }],
    });
    expect([overlap.statusCode, overlap.json().error.code]).toEqual([400, 'OVERLAPPING_HOURS']);
    const past = await inject('POST', '/api/v1/services/providers/me/time-off', pro.token, { date: guyanaDayKey(new Date(Date.now() - 2 * DAY)) });
    expect([past.statusCode, past.json().error.code]).toEqual([400, 'DATE_IN_PAST']);
    const carpenter = await makeProvider('carpenter');
    const refused = await inject('POST', '/api/v1/services/providers/me/offerings', carpenter.token, { name: 'Shelf fitting', durationMinutes: 60, price: 3000 });
    expect([refused.statusCode, refused.json().error.code]).toEqual([409, 'TRADE_NOT_BOOKABLE']);
    const read = await inject('GET', '/api/v1/services/providers/me/bookable', carpenter.token);
    expect(read.json().data.bookable).toBe(false);
    expect(await runWithoutTenant(() => app.prisma.serviceOffering.count({ where: { providerId: carpenter.providerId } }))).toBe(0);
  });

  it('a provider changes only their own: another provider cannot change my service or take back my time off', async () => {
    process.env['INSTANT_BOOKING'] = '1';
    const me = await makeProvider('photographer');
    const them = await makeProvider('photographer');
    const mine = await makeOffering(me.providerId, 60);
    const myDay = await runWithoutTenant(() => app.prisma.serviceProviderTimeOff.create({ data: { providerId: me.providerId, date: new Date(Date.UTC(YY, MM - 1, DD)) } }));
    const patch = await inject('PATCH', `/api/v1/services/providers/me/offerings/${mine.id}`, them.token, { active: false });
    expect(patch.statusCode).toBe(404);
    const del = await inject('DELETE', `/api/v1/services/providers/me/time-off/${myDay.id}`, them.token);
    expect(del.statusCode).toBe(404);
    const stored = await runWithoutTenant(async () => [
      (await app.prisma.serviceOffering.findUniqueOrThrow({ where: { id: mine.id } })).active,
      await app.prisma.serviceProviderTimeOff.count({ where: { id: myDay.id } }),
    ]);
    expect(stored).toEqual([true, 1]);
  });
});

describe('the tenant wall on a pro bookable services and time off', () => {
  it('a service and a time off take the provider tenant, are read only inside it, and refuse another tenant', async () => {
    const proB = await makeProvider('tutor', TENANT_B);
    const offering = await makeOffering(proB.providerId, 60);
    const day = await runWithoutTenant(() => app.prisma.serviceProviderTimeOff.create({ data: { providerId: proB.providerId, date: new Date(Date.UTC(YY, MM - 1, DD)) } }));
    // Unstamped rows inherit the provider's tenant (lineage).
    expect([offering.tenantId, day.tenantId]).toEqual([TENANT_B, TENANT_B]);
    expect(await runWithTenant('swift-default', () => app.prisma.serviceOffering.findMany({ where: { id: offering.id } }))).toEqual([]);
    expect(await runWithTenant('swift-default', () => app.prisma.serviceProviderTimeOff.findMany({ where: { id: day.id } }))).toEqual([]);
    expect((await runWithTenant(TENANT_B, () => app.prisma.serviceOffering.findMany({ where: { id: offering.id } }))).map((o) => o.id)).toEqual([offering.id]);
    // A row naming another tenant than its provider's is refused by the database ('swift-default' means unstamped).
    const proA = await makeProvider('tutor');
    await expect(runWithoutTenant(() => app.prisma.serviceOffering.create({
      data: { providerId: proA.providerId, tenantId: TENANT_B, name: 'Wrong tenant', durationMinutes: 60, price: new Prisma.Decimal(1000) },
    }))).rejects.toThrow(/STA-1 lineage/);
    await expect(runWithoutTenant(() => app.prisma.serviceProviderTimeOff.create({
      data: { providerId: proA.providerId, tenantId: TENANT_B, date: new Date(Date.UTC(YY, MM - 1, DD)) },
    }))).rejects.toThrow(/STA-1 lineage/);
    // The wall is forced on both tables.
    const forced = await runWithoutTenant(() => app.prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('service_offerings', 'service_provider_time_off') ORDER BY relname`);
    expect(forced).toEqual([
      { relname: 'service_offerings', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'service_provider_time_off', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });
});

describe('a closed account: its services are switched off and its hours cleared', () => {
  it('the erasure keeps the services a kept job names, switched off, clears the weekly hours and deletes the time off', async () => {
    const pro = await makeProvider('tutor');
    const c = await makeUser();
    const offering = await makeOffering(pro.providerId, 60);
    await bookedJob(pro, c.userId, offering, at(10));
    await runWithoutTenant(() => app.prisma.serviceProvider.update({ where: { id: pro.providerId }, data: { weeklyHours: [{ dayOfWeek: 1, start: '09:00', end: '12:00' }] } }));
    await runWithoutTenant(() => app.prisma.serviceProviderTimeOff.create({ data: { providerId: pro.providerId, date: new Date(Date.UTC(YY, MM - 1, DD)) } }));
    await runWithoutTenant(() => deidentifyProfiles(app.prisma, pro.userId));
    const after = await runWithoutTenant(async () => ({
      provider: await app.prisma.serviceProvider.findUniqueOrThrow({ where: { id: pro.providerId } }),
      offering: await app.prisma.serviceOffering.findUniqueOrThrow({ where: { id: offering.id } }),
    }));
    expect(after.provider.weeklyHours).toBeNull();
    expect([after.offering.active, after.offering.name]).toEqual([false, offering.name]);
    expect(await runWithoutTenant(() => app.prisma.serviceProviderTimeOff.count({ where: { providerId: pro.providerId } }))).toBe(0);
  });
});
