import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { servicesRoutes } from '../../modules/services/services.routes';
import { verificationRoutes } from '../../modules/verification/verification.routes';
import { registerErrorHandler } from '../../middleware/error-handler';
import { providerChecklist, sendBookingReminders } from '../../modules/services/services.service';
import { NotificationService } from '../../modules/notification/notification.service';
import { VerificationService, docTypeExpires } from '../../modules/verification/verification.service';
import { getKycProvider } from '../../providers/kyc/kyc-provider';
import { purgeAuditLogs } from '../../lib/audit-immutability';
import { ownedVerificationFixture } from '../helpers/verification-object';

// ---------------------------------------------------------------------------
// GOLD-4 · SERV-02 — the professional-services golden journey.
//
// Real mounted services + verification routes, real role sessions, a real
// database; every step is asserted on DURABLE rows, not only HTTP codes:
//   · request → quote → schedule → confirm → reminder → complete, with the
//     wrong party refused at every state-changing step
//   · in America/Guyana: a 13:00Z slot must read "9:00 AM" in the booking
//     notice AND the 24h reminder, whatever zone the server runs in
//     (E21: fixed by PR #1273, which flipped this from it.fails)
//   · expired credentials deny quote AND confirm; renewal through the real
//     verification route restores both
//   · two customers racing one provider slot produce exactly one winner, and
//     the loser recovers with another time
//   · a request that fails leaves nothing behind, and one retry after the
//     cause is fixed mints exactly one job
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
let notifications: NotificationService;
const createdUserIds: string[] = [];
let seq = 0;
// This file's own fixture range (+59202165nnn): audited against every phone
// literal, purge prefix and random phone range under apps/api/src.
const PHONE_PREFIX = '+59202165';

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await runWithoutTenant(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Gol4',
      lastName: `Serv${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await runWithoutTenant(() => app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: 'gold4-serv02',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  }));
  return { userId: user.id, token };
}

function inject(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

/** Submit documents through the REAL verification route, then a person decides
 *  each one. [NO-AI · #1276] Nothing is approved on submission: the route
 *  answers PENDING and a reviewer approves it (keying the printed expiry where
 *  the type carries one) through the same service method the review console
 *  calls — the human path services.test.ts walks. */
let reviewerAdmin: { userId: string; token: string } | undefined;
async function submitDocs(owner: { userId: string; token: string }, docTypes: string[]) {
  reviewerAdmin ??= await makeUserWithSession(['ADMIN'], 'ADMIN');
  const reviewer = new VerificationService(app.prisma, notifications, getKycProvider());
  for (const docType of docTypes) {
    const submitted = await inject('POST', '/api/v1/verification/documents', {
      role: 'SERVICE_PROVIDER',
      docType,
      fileUrl: await ownedVerificationFixture(app.prisma, owner.userId, docType),
      consent: true,
      privacyNoticeVersion: 'v1',
    }, owner.token);
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().data.status).toBe('PENDING');
    const approver = reviewerAdmin.userId;
    await runWithoutTenant(() => reviewer.approveDocument(
      submitted.json().data.id,
      approver,
      docTypeExpires(docType) ? new Date(Date.now() + 200 * DAY) : undefined,
    ), 'gold-4-serv-02-reviewer');
  }
}

/** A provider verified through the real routes: profile, then the full
 *  country checklist (each document decided by a person), then the profile
 *  read back as verified. */
async function makeVerifiedProvider(trade: string) {
  const owner = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
  const first = await inject('POST', '/api/v1/services/providers', { trade, bio: 'Golden journey provider' }, owner.token);
  expect(first.statusCode).toBe(200);
  expect(first.json().data.isVerified).toBe(false);
  const checklist = await providerChecklist(app.prisma, owner.userId);
  expect(checklist.length).toBeGreaterThan(0);
  await submitDocs(owner, checklist);
  const refreshed = await inject('POST', '/api/v1/services/providers', { trade, bio: 'Golden journey provider' }, owner.token);
  expect(refreshed.statusCode).toBe(200);
  expect(refreshed.json().data.isVerified).toBe(true);
  return { ...owner, providerId: first.json().data.id as string };
}

/** Time passes the printed expiry of the provider's LIVE evidence for one
 *  document type. The write lands on the committed submission; the
 *  verification_documents_keep_record trigger carries it into document_record,
 *  the table the live gates read. Nothing refreshes the cached
 *  ServiceProvider.isVerified projection here: the expiry sweep has not run
 *  yet, which is exactly the window the live gates exist for. */
async function lapseLiveEvidence(userId: string, docType: string) {
  const lapsed = await runWithoutTenant(() => app.prisma.verificationDocument.updateMany({
    where: { userId, docType, state: 'COMMITTED' },
    data: { expiresAt: new Date(Date.now() - 3600_000) },
  }));
  expect(lapsed.count).toBe(1);
}

const jobRow = (id: string) => runWithoutTenant(() => app.prisma.serviceJob.findUniqueOrThrow({ where: { id } }));

/** Inbox rows of one kind for one user, optionally bound to one job. */
function inbox(userId: string, kind: string, jobId?: string, idKey: 'jobId' | 'refId' = 'jobId') {
  return runWithoutTenant(() => app.prisma.notification.findMany({
    where: {
      userId,
      AND: [
        { data: { path: ['kind'], equals: kind } },
        ...(jobId ? [{ data: { path: [idKey], equals: jobId } }] : []),
      ],
    },
    orderBy: { createdAt: 'asc' },
  }));
}

/** One tick of the booking-reminder job, composed exactly as the production
 *  worker composes it (jobs/queue.ts 'booking-reminders': sendBookingReminders
 *  delivering through NotificationService.send as ORDER_UPDATE). The sweep is
 *  global; only this file's parties are delivered, so a shared test database
 *  never gains inbox rows for another suite's users. */
async function runReminderTick() {
  const mine = new Set(createdUserIds);
  await sendBookingReminders(app.prisma, async (n) => {
    if (!mine.has(n.userId)) return;
    await notifications.send({ ...n, type: 'ORDER_UPDATE' });
  });
}

/** Guyana is UTC−4 all year (no DST), so a true instant's local wall clock is
 *  known in advance: 13:00Z is 09:00 in Georgetown. The slot must sit inside
 *  the reminder window (now, now + 24h]. In the five minutes a day when the
 *  next 13:00Z is too close to use, 14:00Z (10:00 local) stands in, so the
 *  journey never flakes on the wall clock. */
const GUYANA_SLOTS = [
  { utcHour: 13, reads: '9:00 AM' },
  { utcHour: 14, reads: '10:00 AM' },
] as const;
function nextGuyanaSlot(minLeadMs = 5 * 60_000) {
  const now = Date.now();
  for (const slot of GUYANA_SLOTS) {
    const at = new Date(now);
    at.setUTCHours(slot.utcHour, 0, 0, 0);
    if (at.getTime() - now < minLeadMs) at.setUTCDate(at.getUTCDate() + 1);
    if (at.getTime() - now <= DAY) return { at, reads: slot.reads };
  }
  throw new Error('no Guyana slot inside the reminder window');
}
/** ICU may print a narrow no-break space before AM/PM; the assertion is about
 *  the wall clock and the meridiem, not the space's code point. */
const face = (text: string) => text.replace(/\s+/g, ' ');

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
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:gold-4-serv-02');
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  // The production composition root (app.ts) gives every request a fresh
  // tenant store before auth — replicate it so guest reads never inherit a
  // leaked tenant from an earlier request.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  notifications = new NotificationService(app.prisma, app.io);

  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('GOLD-4 · SERV-02 — the professional-services golden journey', () => {
  it('request → quote → schedule → confirm → reminder → complete, with the wrong party refused at every step', async () => {
    const provider = await makeVerifiedProvider('carpenter');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const stranger = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');

    // 1. REQUEST — a job and a two-party chat room, and the provider is told.
    const request = await inject('POST', '/api/v1/services/jobs', {
      providerId: provider.providerId,
      description: 'Repair the garden gate and repaint both panels',
    }, customer.token);
    expect(request.statusCode).toBe(201);
    const jobId = request.json().data.id as string;
    const requested = await jobRow(jobId);
    expect(requested.status).toBe('REQUESTED');
    expect(requested.tenantId).toBe('swift-default');
    expect(requested.customerId).toBe(customer.userId);
    expect(requested.providerId).toBe(provider.providerId);
    const room = await runWithoutTenant(() => app.prisma.chatRoom.findUniqueOrThrow({
      where: { id: requested.chatRoomId! },
      include: { participants: true },
    }));
    expect(room.isActive).toBe(true);
    expect(room.participants.map((p) => p.userId).sort()).toEqual([customer.userId, provider.userId].sort());
    expect(await inbox(provider.userId, 'booking_requested', jobId)).toHaveLength(1);

    // A stranger can neither read nor act on the job.
    const strangerRead = await inject('GET', `/api/v1/services/jobs/${jobId}`, undefined, stranger.token);
    expect(strangerRead.statusCode).toBe(403);
    expect(strangerRead.json().error.code).toBe('FORBIDDEN');
    expect((await inject('POST', `/api/v1/services/jobs/${jobId}/quote`, { amount: 1 }, stranger.token)).statusCode).toBe(403);

    // 2. QUOTE — the provider only.
    const customerQuote = await inject('POST', `/api/v1/services/jobs/${jobId}/quote`, { amount: 1 }, customer.token);
    expect(customerQuote.statusCode).toBe(403);
    expect(customerQuote.json().error.code).toBe('PROVIDER_ONLY');
    expect((await jobRow(jobId)).quoteAmount).toBeNull();

    const quote = await inject('POST', `/api/v1/services/jobs/${jobId}/quote`, { amount: 45000 }, provider.token);
    expect(quote.statusCode).toBe(200);
    const quoted = await jobRow(jobId);
    expect(quoted.status).toBe('QUOTED');
    expect(Number(quoted.quoteAmount)).toBe(45000);

    // 3. SCHEDULE — the customer only; the provider is asked to confirm.
    const providerSchedule = await inject('POST', `/api/v1/services/jobs/${jobId}/schedule`, {
      scheduledFor: new Date(Date.now() + 4 * 3600_000).toISOString(),
    }, provider.token);
    expect(providerSchedule.statusCode).toBe(403);
    expect(providerSchedule.json().error.code).toBe('CUSTOMER_ONLY');
    expect((await jobRow(jobId)).scheduledFor).toBeNull();

    const scheduledFor = new Date(Date.now() + 2 * 3600_000);
    const schedule = await inject('POST', `/api/v1/services/jobs/${jobId}/schedule`, { scheduledFor: scheduledFor.toISOString() }, customer.token);
    expect(schedule.statusCode).toBe(200);
    const scheduled = await jobRow(jobId);
    expect(scheduled.status).toBe('SCHEDULED');
    expect(scheduled.scheduledFor!.toISOString()).toBe(scheduledFor.toISOString());
    expect(scheduled.providerConfirmedAt).toBeNull();
    expect(await inbox(provider.userId, 'booking_to_confirm', jobId)).toHaveLength(1);

    // 4. CONFIRM — the provider only; the customer is told.
    const customerConfirm = await inject('POST', `/api/v1/services/jobs/${jobId}/confirm`, {}, customer.token);
    expect(customerConfirm.statusCode).toBe(403);
    expect(customerConfirm.json().error.code).toBe('PROVIDER_ONLY');
    expect((await jobRow(jobId)).providerConfirmedAt).toBeNull();

    const confirm = await inject('POST', `/api/v1/services/jobs/${jobId}/confirm`, {}, provider.token);
    expect(confirm.statusCode).toBe(200);
    expect((await jobRow(jobId)).providerConfirmedAt).toBeInstanceOf(Date);
    expect(await inbox(customer.userId, 'booking_confirmed', jobId)).toHaveLength(1);

    // 5. REMINDER — one nudge per party inside the 24h window; a second tick
    //    of the job adds nothing (the dedupe rides the inbox log).
    await runReminderTick();
    expect(await inbox(customer.userId, 'booking_reminder', jobId, 'refId')).toHaveLength(1);
    expect(await inbox(provider.userId, 'booking_reminder', jobId, 'refId')).toHaveLength(1);
    await runReminderTick();
    expect(await inbox(customer.userId, 'booking_reminder', jobId, 'refId')).toHaveLength(1);
    expect(await inbox(provider.userId, 'booking_reminder', jobId, 'refId')).toHaveLength(1);

    // 6. COMPLETE — the provider only; the chat closes; both sides are asked
    //    to rate; completion is terminal.
    const customerComplete = await inject('POST', `/api/v1/services/jobs/${jobId}/complete`, {}, customer.token);
    expect(customerComplete.statusCode).toBe(403);
    expect(customerComplete.json().error.code).toBe('PROVIDER_ONLY');
    expect((await jobRow(jobId)).status).toBe('SCHEDULED');

    const complete = await inject('POST', `/api/v1/services/jobs/${jobId}/complete`, {}, provider.token);
    expect(complete.statusCode).toBe(200);
    const finished = await jobRow(jobId);
    expect(finished.status).toBe('COMPLETED');
    expect(finished.completedAt).toBeInstanceOf(Date);
    expect((await runWithoutTenant(() => app.prisma.chatRoom.findUniqueOrThrow({ where: { id: requested.chatRoomId! } }))).isActive).toBe(false);
    expect(await inbox(customer.userId, 'booking_completed', jobId)).toHaveLength(1);
    expect(await inbox(provider.userId, 'booking_completed', jobId)).toHaveLength(1);

    const again = await inject('POST', `/api/v1/services/jobs/${jobId}/complete`, {}, provider.token);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('BAD_STATE');
    expect((await jobRow(jobId)).completedAt!.getTime()).toBe(finished.completedAt!.getTime());
  });

  describe('in America/Guyana — a booked slot reads its Georgetown wall clock', () => {
    const guyana = { reads: '', slotIso: '', storedIso: '', bookingNotice: '', reminders: [] as string[] };

    // The whole booking runs HERE, through the mounted routes and the real
    // reminder tick: if any of it breaks, this hook fails the suite loudly, so
    // the time-of-day test below only ever judges the time of day.
    beforeAll(async () => {
      const provider = await makeVerifiedProvider('painter');
      const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
      const slot = nextGuyanaSlot();

      const request = await inject('POST', '/api/v1/services/jobs', {
        providerId: provider.providerId,
        description: 'Paint the front verandah and the rails',
      }, customer.token);
      expect(request.statusCode).toBe(201);
      const jobId = request.json().data.id as string;
      expect((await inject('POST', `/api/v1/services/jobs/${jobId}/quote`, { amount: 30000 }, provider.token)).statusCode).toBe(200);
      expect((await inject('POST', `/api/v1/services/jobs/${jobId}/schedule`, { scheduledFor: slot.at.toISOString() }, customer.token)).statusCode).toBe(200);
      expect((await inject('POST', `/api/v1/services/jobs/${jobId}/confirm`, {}, provider.token)).statusCode).toBe(200);
      await runReminderTick();

      const [notice] = await inbox(provider.userId, 'booking_to_confirm', jobId);
      expect(notice).toBeDefined();
      const reminders = [
        ...(await inbox(customer.userId, 'booking_reminder', jobId, 'refId')),
        ...(await inbox(provider.userId, 'booking_reminder', jobId, 'refId')),
      ];
      expect(reminders).toHaveLength(2);

      guyana.reads = slot.reads;
      guyana.slotIso = slot.at.toISOString();
      guyana.storedIso = (await jobRow(jobId)).scheduledFor!.toISOString();
      guyana.bookingNotice = notice!.body;
      guyana.reminders = reminders.map((r) => r.body);
    });

    it('the slot travels and is stored as the true instant', () => {
      expect(guyana.storedIso).toBe(guyana.slotIso);
    });

    // E21 (S1, ledger): the booking notice and the reminder used to format with
    // toLocaleString('en-GY') in the PROCESS time zone, so the same 13:00Z slot
    // read "1:00 pm" on a UTC server and "9:00 am" on a Georgetown host. PR
    // #1273 formats both explicitly in America/Guyana; this ran as it.fails
    // until it landed.
    it('[E21 · fixed by PR #1273] the booking notice and the 24h reminder read "9:00 AM" for a 13:00Z slot on any host zone', () => {
      expect(face(guyana.bookingNotice)).toContain(guyana.reads);
      for (const body of guyana.reminders) expect(face(body)).toContain(guyana.reads);
    });
  });

  it('expired credentials deny quote AND confirm; renewal through the real verification route restores both', async () => {
    const provider = await makeVerifiedProvider('mechanic');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');

    const request = await inject('POST', '/api/v1/services/jobs', {
      providerId: provider.providerId,
      description: 'Service the delivery van brakes and replace the pads',
    }, customer.token);
    expect(request.statusCode).toBe(201);
    const jobId = request.json().data.id as string;

    // The identity evidence lapses AFTER the request was accepted.
    await lapseLiveEvidence(provider.userId, 'national_id');
    const quoteDenied = await inject('POST', `/api/v1/services/jobs/${jobId}/quote`, { amount: 25000 }, provider.token);
    expect(quoteDenied.statusCode).toBe(409);
    expect(quoteDenied.json().error.code).toBe('PROVIDER_NOT_VERIFIED');
    const unquoted = await jobRow(jobId);
    expect(unquoted.status).toBe('REQUESTED');
    expect(unquoted.quoteAmount).toBeNull();

    // Renewal is a NEW submission through the real route; it supersedes the
    // lapsed record and the gates open again.
    await submitDocs(provider, ['national_id']);
    expect((await inject('POST', `/api/v1/services/jobs/${jobId}/quote`, { amount: 25000 }, provider.token)).statusCode).toBe(200);
    expect((await inject('POST', `/api/v1/services/jobs/${jobId}/schedule`, {
      scheduledFor: new Date(Date.now() + 5 * 3600_000).toISOString(),
    }, customer.token)).statusCode).toBe(200);

    // The renewed evidence lapses between SCHEDULED and the provider's
    // acceptance: the last gate for new work refuses too.
    await lapseLiveEvidence(provider.userId, 'national_id');
    const confirmDenied = await inject('POST', `/api/v1/services/jobs/${jobId}/confirm`, {}, provider.token);
    expect(confirmDenied.statusCode).toBe(409);
    expect(confirmDenied.json().error.code).toBe('PROVIDER_NOT_VERIFIED');
    const unconfirmed = await jobRow(jobId);
    expect(unconfirmed.status).toBe('SCHEDULED');
    expect(unconfirmed.providerConfirmedAt).toBeNull();
    expect(await inbox(customer.userId, 'booking_confirmed', jobId)).toHaveLength(0);
  });

  it('two customers racing the same provider slot produce exactly one winner, and the loser recovers with another time', async () => {
    const provider = await makeVerifiedProvider('plumber');
    const customerA = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const customerB = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');

    const requestA = await inject('POST', '/api/v1/services/jobs', {
      providerId: provider.providerId,
      description: 'Fix the leak under the kitchen sink',
    }, customerA.token);
    const requestB = await inject('POST', '/api/v1/services/jobs', {
      providerId: provider.providerId,
      description: 'Replace the bathroom tap and reseal the basin',
    }, customerB.token);
    expect(requestA.statusCode).toBe(201);
    expect(requestB.statusCode).toBe(201);
    const jobA = requestA.json().data.id as string;
    const jobB = requestB.json().data.id as string;
    expect((await inject('POST', `/api/v1/services/jobs/${jobA}/quote`, { amount: 15000 }, provider.token)).statusCode).toBe(200);
    expect((await inject('POST', `/api/v1/services/jobs/${jobB}/quote`, { amount: 15000 }, provider.token)).statusCode).toBe(200);

    // The SAME instant, raced by two customers.
    const slot = new Date(Date.now() + 3 * 3600_000);
    const [raceA, raceB] = await Promise.all([
      inject('POST', `/api/v1/services/jobs/${jobA}/schedule`, { scheduledFor: slot.toISOString() }, customerA.token),
      inject('POST', `/api/v1/services/jobs/${jobB}/schedule`, { scheduledFor: slot.toISOString() }, customerB.token),
    ]);
    expect([raceA.statusCode, raceB.statusCode].sort()).toEqual([200, 409]);
    const aWon = raceA.statusCode === 200;
    const [winnerJob, loserJob] = aWon ? [jobA, jobB] : [jobB, jobA];
    const loser = aWon ? { res: raceB, ...customerB } : { res: raceA, ...customerA };
    expect(loser.res.json().error.code).toBe('SLOT_TAKEN');

    // Durable: exactly one live job holds the slot; the loser is still QUOTED
    // with no slot; the provider was asked to confirm the winner only.
    const holders = await runWithoutTenant(() => app.prisma.serviceJob.findMany({
      where: { providerId: provider.providerId, scheduledFor: slot, status: { in: ['SCHEDULED', 'IN_PROGRESS'] } },
    }));
    expect(holders.map((h) => h.id)).toEqual([winnerJob]);
    const loserRow = await jobRow(loserJob);
    expect(loserRow.status).toBe('QUOTED');
    expect(loserRow.scheduledFor).toBeNull();
    expect(await inbox(provider.userId, 'booking_to_confirm', winnerJob)).toHaveLength(1);
    expect(await inbox(provider.userId, 'booking_to_confirm', loserJob)).toHaveLength(0);

    // Recovery: the loser picks the next hour and is booked.
    const later = new Date(slot.getTime() + 3600_000);
    const retry = await inject('POST', `/api/v1/services/jobs/${loserJob}/schedule`, { scheduledFor: later.toISOString() }, loser.token);
    expect(retry.statusCode).toBe(200);
    const recovered = await jobRow(loserJob);
    expect(recovered.status).toBe('SCHEDULED');
    expect(recovered.scheduledFor!.toISOString()).toBe(later.toISOString());
    expect(await inbox(provider.userId, 'booking_to_confirm', loserJob)).toHaveLength(1);
  });

  it('a request that fails on a lapsed credential leaves nothing behind, and one retry after renewal mints exactly one job', async () => {
    const provider = await makeVerifiedProvider('gardener');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const body = { providerId: provider.providerId, description: 'Trim the hedge and clear the gutters' };

    await lapseLiveEvidence(provider.userId, 'police_clearance');
    const failed = await inject('POST', '/api/v1/services/jobs', body, customer.token);
    expect(failed.statusCode).toBe(403);
    expect(failed.json().error.code).toBe('PROVIDER_NOT_VERIFIED');

    // The failure is atomic: no job, no chat room, no notice to the provider.
    const jobsOf = () => runWithoutTenant(() => app.prisma.serviceJob.findMany({ where: { customerId: customer.userId } }));
    const roomsOf = () => runWithoutTenant(() => app.prisma.chatRoom.count({ where: { participants: { some: { userId: customer.userId } } } }));
    expect(await jobsOf()).toHaveLength(0);
    expect(await roomsOf()).toBe(0);
    expect(await inbox(provider.userId, 'booking_requested')).toHaveLength(0);

    // The provider renews through the real route; ONE retry succeeds.
    await submitDocs(provider, ['police_clearance']);
    const retried = await inject('POST', '/api/v1/services/jobs', body, customer.token);
    expect(retried.statusCode).toBe(201);
    const jobs = await jobsOf();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(retried.json().data.id);
    expect(jobs[0]!.status).toBe('REQUESTED');
    expect(await roomsOf()).toBe(1);
    expect(await inbox(provider.userId, 'booking_requested', jobs[0]!.id)).toHaveLength(1);
    expect(await inbox(provider.userId, 'booking_requested')).toHaveLength(1);
  });
});
