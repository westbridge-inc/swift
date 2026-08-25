import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { servicesRoutes } from '../modules/services/services.routes';
import { providerChecklist } from '../modules/services/services.service';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [S0] A service provider has ONE body. Two customers must never hold the same
// provider for the same time — "if that time doesn't work it's booked".
//
// The guarantee is the DATABASE's: a partial unique index on
// ("providerId", "scheduledFor") over live jobs (SCHEDULED / IN_PROGRESS)
// means concurrent schedules resolve to exactly one winner however they
// interleave, and the loser is told 409 instead of being quietly stood up.
// Same doctrine as bookings_item_slot_live_key on the appointment side
// (catalogue.test.ts — "double-booking is impossible at the data layer").
//
// Second S0 covered here: closing a job used to be SILENT. A provider who
// blocked their Tuesday was never told the customer cancelled — they showed up.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** Phone prefix owned by this file alone (grepped: nothing else uses +59200421). */
const PHONE_PREFIX = '+59200421';

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;
let slotSeq = 0;

/** A fresh future instant per case — the unique key is provider-wide, so cases
 *  must not silently lean on each other's slots. */
function nextSlot(): Date {
  slotSeq += 1;
  const base = new Date(Date.now() + 7 * DAY + slotSeq * HOUR);
  base.setUTCMinutes(0, 0, 0);
  return base;
}

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
        firstName: 'Slot', lastName: `User${seq}`, roles, activeRole,
        isPhoneVerified: true, selfieCapturedAt: new Date(),
        avatar: 'storage://test/provider-selfie.jpg',
        ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      },
    });
    createdUserIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'slot-excl', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
    });
    return { userId: user.id, token };
  });
}

function inject(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

/** A verified provider: profile first (so the canonical checklist knows the
 *  trade), then its documents, then a re-save to project verification. */
async function makeVerifiedProvider(trade = 'carpenter') {
  const u = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
  await inject('POST', '/api/v1/services/providers', { trade, bio: 'Experienced' }, u.token);
  const checklist = await runWithoutTenant(() => providerChecklist(app.prisma, u.userId));
  expect(checklist.length).toBeGreaterThan(0);
  for (const docType of checklist) {
    await runWithoutTenant(() => app.prisma.verificationDocument.create({
      data: { userId: u.userId, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}.jpg`, status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
    }));
  }
  const res = await inject('POST', '/api/v1/services/providers', { trade, bio: 'Experienced' }, u.token);
  expect(res.json().data.isVerified).toBe(true);
  return { ...u, providerId: res.json().data.id as string };
}

/** request → quote: a job sitting at QUOTED, ready to be scheduled. */
async function quotedJob(
  provider: { providerId: string; token: string },
  customer: { token: string },
): Promise<string> {
  const created = await inject('POST', '/api/v1/services/jobs', {
    providerId: provider.providerId,
    description: 'Rehang the back door and fit a new lock',
  }, customer.token);
  expect(created.statusCode).toBe(201);
  const jobId = created.json().data.id as string;
  const quoted = await inject('POST', `/api/v1/services/jobs/${jobId}/quote`, { amount: 15000 }, provider.token);
  expect(quoted.statusCode).toBe(200);
  return jobId;
}

function schedule(jobId: string, when: Date, token: string) {
  return inject('POST', `/api/v1/services/jobs/${jobId}/schedule`, { scheduledFor: when.toISOString() }, token);
}

function liveJobsAt(providerId: string, when: Date) {
  return runWithoutTenant(() => app.prisma.serviceJob.count({
    where: { providerId, scheduledFor: when, status: { in: ['SCHEDULED', 'IN_PROGRESS'] } },
  }));
}

function jobRow(jobId: string) {
  return runWithoutTenant(() => app.prisma.serviceJob.findUniqueOrThrow({ where: { id: jobId } }));
}

/** The inbox row for one job event — the notification IS the delivery record. */
function notificationFor(userId: string, kind: string, jobId: string) {
  return runWithoutTenant(() => app.prisma.notification.findFirst({
    where: {
      userId,
      AND: [
        { data: { path: ['kind'], equals: kind } },
        { data: { path: ['jobId'], equals: jobId } },
      ],
    },
  }));
}

async function purgeFixtures() {
  await runWithoutTenant(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const userIds = [...new Set([...createdUserIds, ...users.map((u) => u.id)])];
    createdUserIds.length = 0;
    if (userIds.length === 0) return;
    const jobs = await app.prisma.serviceJob.findMany({
      where: { OR: [{ customerId: { in: userIds } }, { provider: { userId: { in: userIds } } }] },
      select: { id: true },
    });
    const jobIds = jobs.map((j) => j.id);
    await app.prisma.rating.deleteMany({ where: { OR: [{ raterId: { in: userIds } }, { orderId: { in: jobIds } }] } });
    await app.prisma.chatRoom.deleteMany({ where: { serviceJobId: { in: jobIds } } });
    await app.prisma.serviceJob.deleteMany({ where: { id: { in: jobIds } } });
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.ready();

  // The partial unique lives in SQL (Prisma cannot express it). Migrated
  // databases get it from 20260826000000_service_job_slot_exclusivity; CI and
  // dev run `db push`, which does not carry raw indexes — ensure it here, the
  // same way the scheduling suites ensure bookings_item_slot_live_key.
  await app.prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "service_jobs_provider_slot_live_key"
       ON "service_jobs" ("providerId", "scheduledFor")
     WHERE "scheduledFor" IS NOT NULL AND "status" IN ('SCHEDULED', 'IN_PROGRESS')`,
  );
  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('Services — double-booking a provider is impossible at the data layer', () => {
  it('the guard is a partial unique index, not application code', async () => {
    const rows = await app.prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'service_jobs' AND indexname = 'service_jobs_provider_slot_live_key'
    `;
    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    expect(def).toContain('UNIQUE');
    expect(def).toContain('providerId');
    expect(def).toContain('scheduledFor');
    // Live rows only — a cancelled or completed job must release its slot.
    expect(def).toContain('WHERE');
    expect(def).toContain('SCHEDULED');
  });

  it('two customers firing at the same provider and slot resolve to exactly ONE winner', async () => {
    const provider = await makeVerifiedProvider();
    const first = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const second = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const jobA = await quotedJob(provider, first);
    const jobB = await quotedJob(provider, second);
    const slot = nextSlot();

    const [a, b] = await Promise.all([
      schedule(jobA, slot, first.token),
      schedule(jobB, slot, second.token),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error.code).toBe('SLOT_TAKEN');

    // The database is the judge: one job holds that hour, and the loser's job
    // is untouched — still QUOTED, no slot, so its customer can pick again.
    expect(await liveJobsAt(provider.providerId, slot)).toBe(1);
    const loserJobId = a.statusCode === 409 ? jobA : jobB;
    const loserRow = await jobRow(loserJobId);
    expect(loserRow.status).toBe('QUOTED');
    expect(loserRow.scheduledFor).toBeNull();

    const winnerJobId = a.statusCode === 409 ? jobB : jobA;
    const winnerRow = await jobRow(winnerJobId);
    expect(winnerRow.status).toBe('SCHEDULED');
    expect(winnerRow.scheduledFor?.toISOString()).toBe(slot.toISOString());
    // The provider still has to accept it (§4.3) — and it blocks the slot
    // from the moment it is taken, not from confirmation.
    expect(winnerRow.providerConfirmedAt).toBeNull();
  });

  it('an unconfirmed booking already blocks the hour for the next customer', async () => {
    const provider = await makeVerifiedProvider();
    const holder = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const latecomer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const held = await quotedJob(provider, holder);
    const late = await quotedJob(provider, latecomer);
    const slot = nextSlot();

    expect((await schedule(held, slot, holder.token)).statusCode).toBe(200);
    const blocked = await schedule(late, slot, latecomer.token);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('SLOT_TAKEN');
    expect(await liveJobsAt(provider.providerId, slot)).toBe(1);

    // A different hour with the same provider is still bookable.
    const otherSlot = nextSlot();
    expect((await schedule(late, otherSlot, latecomer.token)).statusCode).toBe(200);
  });

  it('declining the slot frees it for someone else', async () => {
    const provider = await makeVerifiedProvider();
    const first = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const second = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const jobA = await quotedJob(provider, first);
    const jobB = await quotedJob(provider, second);
    const slot = nextSlot();

    expect((await schedule(jobA, slot, first.token)).statusCode).toBe(200);
    expect((await schedule(jobB, slot, second.token)).statusCode).toBe(409);

    const declined = await inject('POST', `/api/v1/services/jobs/${jobA}/decline-slot`, undefined, provider.token);
    expect(declined.statusCode).toBe(200);

    expect((await schedule(jobB, slot, second.token)).statusCode).toBe(200);
    expect(await liveJobsAt(provider.providerId, slot)).toBe(1);
  });

  it('cancelling a booked job frees the slot (released by status, never by deletion)', async () => {
    const provider = await makeVerifiedProvider();
    const first = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const second = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const jobA = await quotedJob(provider, first);
    const jobB = await quotedJob(provider, second);
    const slot = nextSlot();

    expect((await schedule(jobA, slot, first.token)).statusCode).toBe(200);
    expect((await schedule(jobB, slot, second.token)).statusCode).toBe(409);

    expect((await inject('POST', `/api/v1/services/jobs/${jobA}/cancel`, undefined, first.token)).statusCode).toBe(200);
    expect((await schedule(jobB, slot, second.token)).statusCode).toBe(200);

    expect(await liveJobsAt(provider.providerId, slot)).toBe(1);
    // The cancelled job is still there, with its history intact.
    const cancelled = await jobRow(jobA);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.scheduledFor?.toISOString()).toBe(slot.toISOString());
  });

  it('a completed job releases its hour rather than owning it forever', async () => {
    const provider = await makeVerifiedProvider();
    const first = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const second = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const jobA = await quotedJob(provider, first);
    const jobB = await quotedJob(provider, second);
    const slot = nextSlot();

    expect((await schedule(jobA, slot, first.token)).statusCode).toBe(200);
    expect((await inject('POST', `/api/v1/services/jobs/${jobA}/complete`, undefined, provider.token)).statusCode).toBe(200);
    expect((await schedule(jobB, slot, second.token)).statusCode).toBe(200);
    expect(await liveJobsAt(provider.providerId, slot)).toBe(1);
  });

  it('two schedules of the SAME job resolve by compare-and-swap, never a silent overwrite', async () => {
    const provider = await makeVerifiedProvider();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const jobId = await quotedJob(provider, customer);
    const morning = nextSlot();
    const afternoon = nextSlot();

    const [a, b] = await Promise.all([
      schedule(jobId, morning, customer.token),
      schedule(jobId, afternoon, customer.token),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const loser = a.statusCode === 400 ? a : b;
    expect(loser.json().error.code).toBe('BAD_STATE');

    // Exactly one of the two times is held, and it is the winner's.
    const held = await jobRow(jobId);
    expect(held.status).toBe('SCHEDULED');
    const winnerSlot = a.statusCode === 200 ? morning : afternoon;
    expect(held.scheduledFor?.toISOString()).toBe(winnerSlot.toISOString());
    expect(await liveJobsAt(provider.providerId, morning) + await liveJobsAt(provider.providerId, afternoon)).toBe(1);
  });
});

describe('Services — closing a job is never silent', () => {
  it('a customer cancelling tells the provider, and says which hour is free again', async () => {
    const provider = await makeVerifiedProvider();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const jobId = await quotedJob(provider, customer);
    const slot = nextSlot();
    expect((await schedule(jobId, slot, customer.token)).statusCode).toBe(200);
    expect((await inject('POST', `/api/v1/services/jobs/${jobId}/confirm`, undefined, provider.token)).statusCode).toBe(200);

    expect((await inject('POST', `/api/v1/services/jobs/${jobId}/cancel`, undefined, customer.token)).statusCode).toBe(200);

    const told = await notificationFor(provider.userId, 'booking_cancelled', jobId);
    expect(told).not.toBeNull();
    expect(told!.body).toContain('free again');
    // The hour the provider had blocked is named, in the same spelling the
    // booking notification used.
    expect(told!.body).toContain(slot.toLocaleString('en-GY', { weekday: 'short', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' }));
    // The canceller is not notified about their own action.
    expect(await notificationFor(customer.userId, 'booking_cancelled', jobId)).toBeNull();
  });

  it('a provider cancelling tells the customer', async () => {
    const provider = await makeVerifiedProvider();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const jobId = await quotedJob(provider, customer);
    const slot = nextSlot();
    expect((await schedule(jobId, slot, customer.token)).statusCode).toBe(200);

    expect((await inject('POST', `/api/v1/services/jobs/${jobId}/cancel`, undefined, provider.token)).statusCode).toBe(200);

    const told = await notificationFor(customer.userId, 'booking_cancelled', jobId);
    expect(told).not.toBeNull();
    expect(told!.body).toContain('Your provider cancelled');
    expect(await notificationFor(provider.userId, 'booking_cancelled', jobId)).toBeNull();
  });

  it('cancelling before any time was agreed never invents a slot in the message', async () => {
    const provider = await makeVerifiedProvider();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const jobId = await quotedJob(provider, customer);

    expect((await inject('POST', `/api/v1/services/jobs/${jobId}/cancel`, undefined, customer.token)).statusCode).toBe(200);

    const told = await notificationFor(provider.userId, 'booking_cancelled', jobId);
    expect(told).not.toBeNull();
    expect(told!.body).not.toContain('booked for');
    expect(told!.body).toContain('no visit is happening');
  });

  it('completion nudges BOTH sides to rate', async () => {
    const provider = await makeVerifiedProvider();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const jobId = await quotedJob(provider, customer);
    const slot = nextSlot();
    expect((await schedule(jobId, slot, customer.token)).statusCode).toBe(200);
    expect((await inject('POST', `/api/v1/services/jobs/${jobId}/confirm`, undefined, provider.token)).statusCode).toBe(200);

    expect((await inject('POST', `/api/v1/services/jobs/${jobId}/complete`, undefined, provider.token)).statusCode).toBe(200);

    const customerNudge = await notificationFor(customer.userId, 'booking_completed', jobId);
    const providerNudge = await notificationFor(provider.userId, 'booking_completed', jobId);
    expect(customerNudge).not.toBeNull();
    expect(providerNudge).not.toBeNull();
    // Swift never holds the money: the customer pays the provider directly.
    expect(customerNudge!.body).toContain('Pay cash directly');
    expect(providerNudge!.body).toContain('Rate your customer');
  });
});
