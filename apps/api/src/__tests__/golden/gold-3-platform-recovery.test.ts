import { describe, it, expect, beforeAll, afterAll, vi, type WorkerGlobalState } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Job, Queue } from 'bullmq';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import courierRoutes from '../../modules/courier/courier.routes';
import { riderRoutes } from '../../modules/rider/rider.routes';
import { customerRoutes } from '../../modules/user/customer.routes';
import { adminRoutes } from '../../modules/admin/admin.routes';
import { registerErrorHandler } from '../../middleware/error-handler';
import { createQueues, type SwiftQueues } from '../../jobs/queue';
import { recoveryFor } from '../../jobs/recovery-policy';

// ---------------------------------------------------------------------------
// GOLD-3 · PLAT-02 — a worker crashes mid-flow and the platform recovers.
//
// The API tier runs exactly as a split deployment runs it (app.ts with
// RUN_WORKERS=0): the mounted routes enqueue onto REAL BullMQ queues in the
// test Redis and nothing in this process consumes them. The worker is a
// SEPARATE OS PROCESS running the production consumer bundle — createWorkers
// in jobs/queue.ts, every processor src/worker.ts runs — which this journey
// SIGKILLs mid-offer and later restarts:
//
//   1  fleet down: a courier's dispatch job waits in Redis; a parcel's
//      free-cancel hold expires and nothing releases it; a checkout whose
//      queue write fails still answers with its order, its tail waiting in
//      the outbox
//   2  a worker takes the dispatch job and offers the nearest courier; it is
//      killed (SIGKILL) mid-offer — the offer and its armed timeout survive
//   3  a restarted worker resumes each piece exactly once: the timeout moves
//      the parcel to the next courier (the crash costs the first nothing),
//      the expired hold is released and offered, the checkout tail is
//      published — and a second tick of each sweep changes nothing
//   4  fleet down again, the courier delivers: paid once, nobody left busy
//   5  a job that exhausts its attempts is a dead letter the founder sees on
//      the DLQ page with its recovery verdict; stale and non-founder actions
//      are refused. [E36 it.fails] the crash classes are replay-certified.
//
// Why not the whole src/worker.ts: its recurring schedule runs platform-wide
// sweeps against the shared test database. Measured on this lane's database, a
// 12-second run of src/worker.ts opened a scheduled DRILL ops alert paging the
// seeded SUPER_ADMIN and wrote three sweep cursors — rows every later file in
// the CI run would inherit. The two sweeps this journey needs are enqueued as
// the exact one-off jobs the schedule adds (its own names and options), which
// is also exactly what an overdue repeatable tick looks like to a restarted
// worker — and, while a step waits on a state only a sweep can produce, the
// same job is enqueued again at the schedule's cadence (`resweep` below),
// because a sweep is a schedule, not a tick: one checkout-outbox tick drains at
// most 200 due rows, oldest first, and a row whose publish fails inside a tick
// is backed off for the NEXT tick while the job itself completes. In CI the
// single tick this step once relied on spent its whole budget on rows earlier
// files had left unpublished in the shared database (a checkout test with no
// queues writes two rows per order and never publishes them; deleting the order
// leaves them) and never reached this journey's row — twice, with nothing in
// the worker's stderr. The consumer process watches its parent and dies with
// it, so no worker can outlive this file.
//
// The one simulated fault: step 1's order-queue producer rejects one write
// (a Redis outage at the moment of checkout). Everything else is organic.
// Fixture range: +5920334nnn (this file only).
// ---------------------------------------------------------------------------

// ── One file at a time: checked here, never assumed ─────────────────────────
// This file obliterates the shared BullMQ queues in the shared test Redis and
// runs a real consumer against them, which is safe only while no other test
// file runs beside it. apps/api/vitest.config.ts pins fileParallelism: false.
// vitest resolves that to maxWorkers = 1, whatever --maxWorkers says, and its
// scheduler runs this file's group with that resolved number. Each worker
// receives the same resolved config, so read it from this worker's own state.
// If files could run side by side, or the value cannot be read, the file
// refuses to load. That happens before any hook is registered or temp dir is
// made, so nothing is obliterated.
const fileSlots = (Reflect.get(globalThis, '__vitest_worker__') as WorkerGlobalState | undefined)?.config?.maxWorkers;
if (fileSlots !== 1) {
  throw new Error(
    `[GOLD-3 PLAT-02] refusing to run: this file wipes and consumes the shared BullMQ queues, so test files must run one at a time, but vitest's resolved maxWorkers is ${String(fileSlots)}, not 1. Keep fileParallelism: false in apps/api/vitest.config.ts and never pass --file-parallelism.`,
  );
}

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920334';
const FIXTURE = 'gold3-plat02-fixture';
const API_ROOT = process.cwd();
const UPLOAD_DIR = mkdtempSync(path.join(os.tmpdir(), 'swift-gold3-plat02-'));

// Georgetown east (the crash cascade), Linden (the hold), New Amsterdam (the
// checkout): more than 15 km apart, so no dispatch ring reaches another scene.
const O1_PICKUP = { lat: 6.82461, lng: -58.11012 };
const O1_DROP = { lat: 6.81355, lng: -58.10111 };
const A_FIX = { lat: 6.82468, lng: -58.11005 };
const B_FIX = { lat: 6.82897, lng: -58.10661 };
const O2_PICKUP = { lat: 5.99813, lng: -58.29233 };
const O2_DROP = { lat: 6.01552, lng: -58.29761 };
const C_FIX = { lat: 5.9982, lng: -58.29225 };
const VENDOR_AT = { lat: 6.24817, lng: -57.51721 };
const HOME_AT = { lat: 6.25312, lng: -57.51298 };

/** The consumer process: the production consumer bundle, no recurring schedule. */
const CONSUMER_SCRIPT = `
const { PrismaClient } = await import('@prisma/client');
const { default: IORedis } = await import('ioredis');
const { Server } = await import('socket.io');
const { pino } = await import('pino');
const { createQueues, createWorkers } = await import('./src/jobs/queue.ts');
const { resolveDatabaseUrl } = await import('./src/utils/db-pool.ts');
const parent = Number(process.env.GOLD3_PARENT_PID);
const log = pino({ level: 'warn' }, pino.destination(2));
const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const prisma = new PrismaClient({ datasourceUrl: resolveDatabaseUrl(process.env.DATABASE_URL, 'worker') });
const io = new Server();
const queues = createQueues(redis, log);
const workers = await createWorkers({ prisma, io, redis, log }, queues);
await workers.waitUntilReady();
await workers.start();
setInterval(() => { if (process.ppid !== parent) process.kill(process.pid, 'SIGKILL'); }, 250).unref();
process.on('SIGTERM', async () => {
  await workers.cleanup();
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
});
process.stdout.write('consumer-ready\\n');
`;

let app: FastifyInstance;
let queues: SwiftQueues;
let redisKeysBefore = new Set<string>();
let seq = 0;
const live = new Set<ChildProcess>();

const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string };

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole, opts: { admin?: boolean } = {}): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName,
      lastName: `Plat${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(opts.admin && { admin: { create: { permissions: ['*'] } } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `plat02-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token };
}

async function makeCourier(firstName: string, fix: { lat: number; lng: number }) {
  const u = await makeUser(firstName, ['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await sys(() => app.prisma.rider.create({
    data: { userId: u.userId, riderType: 'COURIER', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 1_000_000 },
  }));
  const go = await call('POST', '/api/v1/rider/go-online', u.token, { latitude: fix.lat, longitude: fix.lng });
  expect(go.statusCode, go.body).toBe(200);
  return { ...u, riderId: rider.id };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

function postPhoto(orderId: string, token: string, route: 'proof-photo' | 'pickup-proof-photo' = 'proof-photo') {
  const boundary = `----gold3${nanoid(8)}`;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
  return app.inject({
    method: 'POST',
    url: `/api/v1/courier/order/${orderId}/${route}`,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="door.png"\r\ncontent-type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` },
  });
}

const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const riderRow = (id: string) => sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id } }));
const offerKey = (orderId: string) => `dispatch:offer:${orderId}`;

type JobState = 'waiting' | 'prioritized' | 'delayed' | 'active' | 'completed' | 'failed';
const ALL_STATES: JobState[] = ['waiting', 'prioritized', 'delayed', 'active', 'completed', 'failed'];

/** The two recurring sweeps this journey needs (jobs/queue.ts schedules both every 10 s). */
type SweepName = 'release-held-orders' | 'checkout-outbox';

/** One tick of a sweep, exactly as the schedule adds it: its own job name and options. */
function tick(name: SweepName): Promise<Job> {
  return queues.dispatchQueue.add(name, {}, { removeOnComplete: 20, removeOnFail: 20 });
}

/** Production re-fires each sweep every 10 s for as long as the worker lives.
 *  The same cadence, compressed: the outbox backs a failed row off 4 s, then
 *  8 s, and one tick drains at most 200 rows, so 2.5 s reaches every retry and
 *  every page of a backlog well inside a bounded wait. */
const SWEEP_EVERY_MS = 2_500;

type WaitOptions = {
  consumer?: Consumer;
  /** Keep enqueuing this sweep at the schedule's cadence until the state holds. */
  resweep?: SweepName;
  /** Evidence for the timeout error: the rows, the jobs, the clocks. */
  diagnose?: () => Promise<unknown>;
};

const dump = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

async function waitFor<T>(label: string, probe: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number, opts: WaitOptions = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const ticks: Job[] = [];
  let nextTickAt = Date.now() + SWEEP_EVERY_MS;
  let last = await probe();
  while (!done(last)) {
    if (Date.now() > deadline) {
      const diagnostics = opts.diagnose ? await opts.diagnose().catch((err: unknown) => ({ diagnosticsFailed: String(err) })) : undefined;
      throw new Error([
        `timed out waiting for ${label}; last: ${dump(last)}`,
        diagnostics === undefined ? '' : `diagnostics: ${dump(diagnostics)}`,
        opts.resweep ? `${opts.resweep} ticks this wait added: ${dump(await describeJobs(ticks))}` : '',
        opts.consumer ? `consumer stderr: ${opts.consumer.stderr().slice(-1500)}` : '',
      ].filter(Boolean).join('; '));
    }
    if (opts.resweep && Date.now() >= nextTickAt) {
      ticks.push(await tick(opts.resweep));
      nextTickAt = Date.now() + SWEEP_EVERY_MS;
    }
    await new Promise((r) => setTimeout(r, 150));
    last = await probe();
  }
  return last;
}

/** Jobs of one name about one order, in the given states. */
async function jobsFor(queue: Queue, name: string, orderId: string, states: JobState[]) {
  const jobs = (await queue.getJobs(states, 0, -1)) as Array<Job | undefined>;
  return jobs.filter((j): j is Job => !!j && j.name === name && (j.data as { orderId?: string }).orderId === orderId);
}

// ── Diagnostics: what a timed-out wait reports, so a real regression reads
// differently from a transient and from another file's residue ─────────────

/** Each job re-read from its queue (the instance `add` returns never updates). */
async function describeJobs(jobs: Job[]) {
  return Promise.all(jobs.map(async (j) => {
    const fresh = j.id ? (await queues.dispatchQueue.getJob(j.id)) ?? j : j;
    return { id: fresh.id, name: fresh.name, state: await fresh.getState(), attemptsMade: fresh.attemptsMade, failedReason: fresh.failedReason, processedOn: fresh.processedOn, finishedOn: fresh.finishedOn };
  }));
}

/** Every sweep job of one name on the dispatch queue, in every state. */
async function sweepJobs(name: SweepName) {
  const jobs = (await queues.dispatchQueue.getJobs(ALL_STATES, 0, -1)) as Array<Job | undefined>;
  return describeJobs(jobs.filter((j): j is Job => !!j && j.name === name));
}

/** The dead letters on every queue: the one place a job that gave up would show. */
async function deadLetters() {
  const out: Array<Record<string, unknown>> = [];
  for (const q of Object.values(queues)) {
    for (const j of await q.getFailed(0, 50)) out.push({ queue: q.name, id: j.id, name: j.name, attemptsMade: j.attemptsMade, failedReason: j.failedReason, data: j.data });
  }
  return out;
}

/** The outbox row as the drainer judges it (attempts, lease, backoff, error),
 *  the two clocks its due-ness is compared across, and how many due rows stand
 *  AHEAD of it in the drain order (oldest first, 200 a tick) — the shape of
 *  every silent miss. */
async function outboxDiagnostics(rowId: string) {
  const row = await sys(() => app.prisma.orderOutbox.findUnique({ where: { id: rowId } }));
  const [db] = await sys(() => app.prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`);
  const ahead = row ? await sys(() => app.prisma.orderOutbox.count({ where: { processedAt: null, availableAt: { lte: new Date() }, createdAt: { lt: row.createdAt } } })) : null;
  return { row, clocks: { db: db?.now, node: new Date() }, dueRowsAheadInDrainOrder: ahead, sweeps: await sweepJobs('checkout-outbox'), deadLetters: await deadLetters() };
}

/** A held parcel: its hold and release stamps, its card, its dispatch jobs, the release sweeps. */
async function heldParcelDiagnostics(orderId: string) {
  const row = await orderRow(orderId);
  return {
    order: { status: row.status, holdExpiresAt: row.holdExpiresAt, releasedToVendorAt: row.releasedToVendorAt, riderId: row.riderId },
    offer: await app.redis.get(offerKey(orderId)),
    dispatchJobs: await describeJobs(await jobsFor(queues.dispatchQueue, 'dispatch-order', orderId, ALL_STATES)),
    sweeps: await sweepJobs('release-held-orders'),
    deadLetters: await deadLetters(),
  };
}

/** A parcel in the offer cascade: its card, its timeouts, its dispatch jobs. */
async function offerDiagnostics(orderId: string) {
  const row = await orderRow(orderId);
  return {
    order: { status: row.status, riderId: row.riderId },
    offer: await app.redis.get(offerKey(orderId)),
    offerTimeouts: await describeJobs(await jobsFor(queues.dispatchQueue, 'offer-timeout', orderId, ALL_STATES)),
    dispatchJobs: await describeJobs(await jobsFor(queues.dispatchQueue, 'dispatch-order', orderId, ALL_STATES)),
    deadLetters: await deadLetters(),
  };
}

type Consumer = { proc: ChildProcess; exited: Promise<{ code: number | null; signal: string | null }>; stderr: () => string };

async function startConsumer(): Promise<Consumer> {
  const proc = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', CONSUMER_SCRIPT], {
    cwd: API_ROOT,
    env: { ...process.env, GOLD3_PARENT_PID: String(process.pid) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.add(proc);
  let out = '';
  let err = '';
  proc.stdout!.on('data', (c: Buffer) => { out += c.toString(); });
  proc.stderr!.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-20_000); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    proc.once('exit', (code, signal) => { live.delete(proc); resolve({ code, signal }); });
  });
  const consumer: Consumer = { proc, exited, stderr: () => err };
  await waitFor('the worker process to report ready', async () => ({ out, gone: proc.exitCode !== null || proc.signalCode !== null }), (v) => v.out.includes('consumer-ready') || v.gone, 90_000, { consumer });
  if (!out.includes('consumer-ready')) throw new Error(`worker process exited before ready: ${err.slice(-2000)}`);
  return consumer;
}

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const riderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
    const ownerIds = (await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((o) => o.id);
    const vendorIds = (await app.prisma.vendor.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } })).map((v) => v.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { riderId: { in: riderIds } }, { vendorId: { in: vendorIds } }] },
      select: { id: true },
    })).map((o) => o.id);
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...riderIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    await app.prisma.batchEvaluation.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
    await app.prisma.earning.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
    if (orderIds.length > 0) {
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    }
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
}

async function allRedisKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor = '0';
  do {
    const [next, batch] = await app.redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    for (const k of batch) keys.add(k);
  } while (cursor !== '0');
  return keys;
}

async function obliterateQueues() {
  for (const q of Object.values(queues)) await q.obliterate({ force: true });
}

beforeAll(async () => {
  expect(existsSync(path.join(API_ROOT, 'src', 'worker.ts')), 'tests run from apps/api').toBe(true);
  vi.stubEnv('UPLOAD_DIR', UPLOAD_DIR);
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // The API tier of a split deployment: real producers, no consumers here.
  queues = createQueues(app.redis, app.log);
  app.decorate('queues', queues);
  app.decorate('dispatchQueue', queues.dispatchQueue);
  app.decorate('workersActive', false);
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  // The courier routes' storage provider has read UPLOAD_DIR at registration;
  // nothing else may inherit it (the worker processes spawned below included).
  vi.unstubAllEnvs();
  await purgeFixtures();
  // Files run one at a time (the guard at the top of this file refuses to load
  // otherwise): nothing another file left in the shared queues (jobs,
  // repeatable schedules, dead letters) may run inside this journey's
  // workers. The key set after this is what afterAll restores.
  await obliterateQueues();
  redisKeysBefore = await allRedisKeys();
}, 120_000);

afterAll(async () => {
  for (const proc of [...live]) proc.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  await obliterateQueues().catch(() => undefined);
  await Promise.all(Object.values(queues).map((q) => q.close().catch(() => undefined)));
  await purgeFixtures();
  const now = await allRedisKeys();
  const added = [...now].filter((k) => !redisKeysBefore.has(k));
  if (added.length > 0) await app.redis.del(...added);
  await app.close();
  rmSync(UPLOAD_DIR, { recursive: true, force: true });
}, 120_000);

describe('GOLD-3 · PLAT-02 — worker crash and job recovery mid-flow', () => {
  let sender: Actor;
  let a: Awaited<ReturnType<typeof makeCourier>>;
  let b: Awaited<ReturnType<typeof makeCourier>>;
  let c: Awaited<ReturnType<typeof makeCourier>>;
  let o1 = '';
  let o2 = '';
  let o2HoldExpiresAt = new Date(0);
  let o2ReleasedAt: Date | null = null;
  let checkoutCustomer: Actor;
  let c1 = '';
  let c1Key = '';
  let c1Answer: unknown = null;
  let autoCancelRow = '';
  let aAcceptanceBefore = 0;
  let deadJobId = '';
  let deadJobFinishedOn = 0;
  let founder: Actor;
  let tenantAdmin: Actor;

  it('1 · fleet down: the dispatch job waits in Redis, an expired hold stays unreleased, and a checkout whose queue write fails keeps its order and its tail', async () => {
    sender = await makeUser('Shan', ['CUSTOMER'], 'CUSTOMER');
    a = await makeCourier('Arjun', A_FIX);
    b = await makeCourier('Bebe', B_FIX);
    c = await makeCourier('Cleo', C_FIX);
    aAcceptanceBefore = (await riderRow(a.riderId)).acceptanceRate;

    // ── O1: an EXPRESS parcel. The route enqueues its dispatch; nobody consumes it.
    const created = await call('POST', '/api/v1/courier/order', sender.token, {
      pickup: O1_PICKUP, dropoff: O1_DROP, pickupAddress: '2 Ogle Front Road', dropoffAddress: '19 Railway Line, Kitty',
      packageSize: 'SMALL', speed: 'EXPRESS', recipientName: 'Kiran', recipientPhone: `${PHONE_PREFIX}991`,
    });
    expect(created.statusCode, created.body).toBe(201);
    o1 = created.json().data.orderId as string;
    const waiting = await jobsFor(queues.dispatchQueue, 'dispatch-order', o1, ['waiting', 'prioritized', 'delayed', 'active', 'completed', 'failed']);
    expect(waiting).toHaveLength(1);
    expect(await waiting[0]!.getState()).toMatch(/^(waiting|prioritized)$/);
    expect(await app.redis.get(offerKey(o1))).toBeNull();
    const o1Row = await orderRow(o1);
    expect({ status: o1Row.status, rider: o1Row.riderId, express: o1Row.isExpress }).toEqual({ status: 'READY_FOR_PICKUP', rider: null, express: true });

    // ── O2: a parcel born inside the free-cancel hold (LIFECYCLE_V2, 3 s window).
    vi.stubEnv('LIFECYCLE_V2', '1');
    vi.stubEnv('ORDER_HOLD_MINUTES', '0.05');
    let held;
    try {
      held = await call('POST', '/api/v1/courier/order', sender.token, {
        pickup: O2_PICKUP, dropoff: O2_DROP, pickupAddress: '7 Republic Avenue, Linden', dropoffAddress: '40 Mackenzie Road, Linden',
        packageSize: 'SMALL', speed: 'STANDARD', recipientName: 'Lola', recipientPhone: `${PHONE_PREFIX}992`,
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(process.env['LIFECYCLE_V2']).toBe('');
    expect(process.env['ORDER_HOLD_MINUTES']).toBeUndefined();
    expect(held.statusCode, held.body).toBe(201);
    o2 = held.json().data.orderId as string;
    const o2Row = await orderRow(o2);
    expect(o2Row.holdExpiresAt).not.toBeNull();
    o2HoldExpiresAt = o2Row.holdExpiresAt!;
    // The 3-second window (ORDER_HOLD_MINUTES=0.05), measured against the row's own birth.
    expect(o2HoldExpiresAt.getTime() - o2Row.createdAt.getTime()).toBeGreaterThanOrEqual(2_500);
    expect(o2HoldExpiresAt.getTime() - o2Row.createdAt.getTime()).toBeLessThanOrEqual(3_500);
    expect(await jobsFor(queues.dispatchQueue, 'dispatch-order', o2, ['waiting', 'prioritized', 'delayed', 'active', 'completed', 'failed'])).toHaveLength(0);
    const early = await call('POST', `/api/v1/rider/orders/${o2}/accept`, c.token, {});
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('ORDER_HELD');
    // The window closes with the fleet down: the hold lapses, and nothing
    // releases it — release is the worker's job.
    await waitFor('the hold window to pass', async () => Date.now(), (t) => t > o2HoldExpiresAt.getTime() + 1_000, 10_000);
    const lapsed = await orderRow(o2);
    expect({ hold: lapsed.holdExpiresAt, released: lapsed.releasedToVendorAt, rider: lapsed.riderId })
      .toEqual({ hold: o2HoldExpiresAt, released: null, rider: null });
    expect(await app.redis.get(offerKey(o2))).toBeNull();

    // ── C1: a cash food checkout while the order-queue producer loses one write.
    checkoutCustomer = await makeUser('Nadia', ['CUSTOMER'], 'CUSTOMER');
    const owner = await makeUser('Omari', ['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    const vendorOwner = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
    const vendor = await sys(() => app.prisma.vendor.create({
      data: {
        ownerId: vendorOwner.id, name: 'Recovery Kitchen', slug: `gold3-recovery-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
        phone: `${PHONE_PREFIX}990`, addressLine1: '5 Main Street', city: 'New Amsterdam', region: 'East Berbice-Corentyne',
        latitude: VENDOR_AT.lat, longitude: VENDOR_AT.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 10,
      },
    }));
    const category = await sys(() => app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains', sortOrder: 0 } }));
    const item = await sys(() => app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Pepperpot', basePrice: 2500, isAvailable: true } }));
    const address = await sys(() => app.prisma.address.create({
      data: { userId: checkoutCustomer.userId, label: 'Home', addressLine1: '12 Strand Street', city: 'New Amsterdam', region: 'East Berbice-Corentyne', latitude: HOME_AT.lat, longitude: HOME_AT.lng, isDefault: true },
    }));
    const added = await call('POST', '/api/v1/customer/cart/items', checkoutCustomer.token, { vendorId: vendor.id, itemId: item.id, quantity: 1 });
    expect(added.statusCode, added.body).toBeLessThan(300);
    const addressed = await call('PUT', '/api/v1/customer/cart/address', checkoutCustomer.token, { addressId: address.id });
    expect(addressed.statusCode, addressed.body).toBe(200);

    c1Key = `gold3-checkout-${nanoid(12)}`;
    const outage = vi.spyOn(queues.orderQueue, 'add').mockRejectedValueOnce(new Error('connection lost: the order queue producer is down'));
    let checkout;
    try {
      checkout = await call('POST', '/api/v1/customer/checkout', checkoutCustomer.token, { paymentMethod: 'CASH' }, { 'idempotency-key': c1Key });
    } finally {
      outage.mockRestore();
    }
    // The order exists and the customer is answered with it — not a 500.
    expect(checkout.statusCode, checkout.body).toBe(200);
    const orders = checkout.json().data.orders as Array<{ id: string }>;
    expect(orders).toHaveLength(1);
    c1 = orders[0]!.id;
    c1Answer = checkout.json().data;
    const rows = await sys(() => app.prisma.orderOutbox.findMany({ where: { orderId: c1 }, orderBy: { kind: 'asc' } }));
    expect(rows.map((r) => ({ kind: r.kind, queue: r.queue, done: r.processedAt !== null, attempts: r.attempts })))
      .toEqual([
        { kind: 'auto-cancel', queue: 'order', done: false, attempts: 1 },
        { kind: 'vendor-alert-escalate', queue: 'notification', done: true, attempts: 1 },
      ]);
    autoCancelRow = rows[0]!.id;
    expect(rows[0]!.lastError).toContain('connection lost');
    expect(rows[0]!.availableAt.getTime()).toBeGreaterThan(rows[0]!.createdAt.getTime());
    expect(await queues.orderQueue.getJob(autoCancelRow)).toBeUndefined();
    expect((await queues.notificationQueue.getJob(rows[1]!.id))?.name).toBe('vendor-alert-escalate');
    expect((await orderRow(c1)).status).toBe('PENDING');
  }, 60_000);

  it('2 · a worker takes the dispatch job and offers the nearest courier; SIGKILLed mid-offer, the offer and its armed timeout survive in Redis', async () => {
    expect(o1, 'step 1 created the parcel').not.toBe('');
    const worker = await startConsumer();

    // Fully published = the card is live for Arjun, its delivery row is
    // written (the last publication step), its timeout is armed and the
    // dispatch job has finished. The crash lands mid-OFFER, not mid-job.
    await waitFor('the offer to be published to Arjun', async () => ({
      offer: await app.redis.get(offerKey(o1)),
      rows: await sys(() => app.prisma.alertDelivery.count({ where: { kind: 'MOVER_OFFER', subjectId: o1, recipientId: a.userId } })),
      timeouts: (await jobsFor(queues.dispatchQueue, 'offer-timeout', o1, ['delayed'])).length,
      dispatched: (await jobsFor(queues.dispatchQueue, 'dispatch-order', o1, ['completed'])).length,
    }), (v) => v.offer?.startsWith(`${a.riderId}:`) === true && v.rows === 1 && v.timeouts === 1 && v.dispatched === 1, 60_000, { consumer: worker, diagnose: () => offerDiagnostics(o1) });

    worker.proc.kill('SIGKILL');
    expect(await worker.exited).toEqual({ code: null, signal: 'SIGKILL' });

    // The crash lost nothing: the card, its timeout, and nobody assigned.
    const card = await app.redis.get(offerKey(o1));
    expect(card!.split(':')[0]).toBe(a.riderId);
    const recovered = await call('GET', '/api/v1/rider/offers/current', a.token);
    expect(recovered.json().data.offer.orderId).toBe(o1);
    const timeouts = await jobsFor(queues.dispatchQueue, 'offer-timeout', o1, ['delayed']);
    expect(timeouts.map((j) => ({ riderId: j.data.riderId, attemptId: j.data.attemptId }))).toEqual([{ riderId: a.riderId, attemptId: card!.split(':')[1] }]);
    const done = await jobsFor(queues.dispatchQueue, 'dispatch-order', o1, ['completed']);
    expect(done).toHaveLength(1);
    const o1Row = await orderRow(o1);
    expect({ status: o1Row.status, rider: o1Row.riderId }).toEqual({ status: 'READY_FOR_PICKUP', rider: null });
    expect({ a: (await riderRow(a.riderId)).currentOrderId, b: (await riderRow(b.riderId)).currentOrderId }).toEqual({ a: null, b: null });
  }, 120_000);

  it('3 · the restarted worker resumes each piece exactly once: the timeout moves the parcel on, the expired hold is released and offered, the checkout tail is published', async () => {
    expect(o1 && o2 && c1, 'steps 1-2 ran').toBeTruthy();
    // The scheduler's ticks for the two sweeps, waiting in Redis for a worker —
    // exactly what an overdue repeatable looks like on restart. (The outbox
    // tick is one the schedule would fire after the row's retry backoff.)
    const backoff = (await sys(() => app.prisma.orderOutbox.findUniqueOrThrow({ where: { id: autoCancelRow } }))).availableAt;
    await waitFor('the outbox retry backoff to pass', async () => Date.now(), (t) => t > backoff.getTime() + 250, 30_000);
    await tick('release-held-orders');
    await tick('checkout-outbox');
    const worker = await startConsumer();

    // O2: released once and offered to Cleo — who takes the card at once. The
    // release sweep is re-fired at the schedule's cadence while the card is
    // missing (one tick releases at most 100 due holds; a tick whose job fails
    // is BullMQ's to retry, a re-tick of a released row is the no-op proven
    // below). A dispatch enqueue lost AFTER the flip is not a re-tick's to
    // recover — production's reconcile-dispatch takes that after 3 minutes —
    // so it would time out here, named by the diagnostics.
    await waitFor('the held parcel to be offered to Cleo', async () => app.redis.get(offerKey(o2)), (v) => v?.startsWith(`${c.riderId}:`) === true, 60_000, { consumer: worker, resweep: 'release-held-orders', diagnose: () => heldParcelDiagnostics(o2) });
    const takeO2 = await call('POST', '/api/v1/rider/offers/accept', c.token, { orderId: o2 });
    expect(takeO2.statusCode, takeO2.body).toBe(200);
    // O1: the timeout born before the crash fires; the card moves to Bebe — who
    // takes it at once. (No sweep to re-fire: the delayed offer-timeout job is
    // BullMQ's to run and retry.)
    await waitFor('the parcel to cascade to Bebe', async () => ({
      offer: await app.redis.get(offerKey(o1)),
      rows: await sys(() => app.prisma.alertDelivery.count({ where: { kind: 'MOVER_OFFER', subjectId: o1, recipientId: b.userId } })),
    }), (v) => v.offer?.startsWith(`${b.riderId}:`) === true && v.rows === 1, 60_000, { consumer: worker, diagnose: () => offerDiagnostics(o1) });
    const takeO1 = await call('POST', '/api/v1/rider/offers/accept', b.token, { orderId: o1 });
    expect(takeO1.statusCode, takeO1.body).toBe(200);
    expect(takeO1.json().data.status).toBe('RIDER_ASSIGNED');
    // C1: the outbox tail published — waited for the way production waits for
    // it: the sweep keeps firing until the row is done. One tick is not what
    // production offers a row (checkout-outbox.ts drains 200 due rows a tick,
    // oldest first, and backs a row whose publish failed off for the next tick
    // while its job completes and logs nothing above info). On timeout the
    // error carries the row, both clocks, the due rows ahead of it in the drain
    // order, every sweep job, every dead letter and the worker's stderr.
    const tail = await waitFor('the checkout tail to be published', async () => {
      const row = await sys(() => app.prisma.orderOutbox.findUniqueOrThrow({ where: { id: autoCancelRow } }));
      return { processedAt: row.processedAt, attempts: row.attempts, lastError: row.lastError, claimedAt: row.claimedAt };
    }, (v) => v.processedAt !== null, 90_000, { consumer: worker, resweep: 'checkout-outbox', diagnose: () => outboxDiagnostics(autoCancelRow) });

    // ── O1 ──
    expect((await call('GET', '/api/v1/rider/offers/current', a.token)).json().data.offer).toBeNull();
    const late = await call('POST', '/api/v1/rider/offers/accept', a.token, { orderId: o1 });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('OFFER_EXPIRED');
    // An expiry, not a decline — and the card never rendered, so the crash cost
    // Arjun nothing in his acceptance rate.
    expect((await app.redis.zrange(`dispatch:offer-expiries:${a.riderId}`, 0, -1)).filter((m) => m.startsWith(`${o1}:`))).toHaveLength(1);
    expect((await app.redis.zrange(`dispatch:offer-declines:${a.riderId}`, 0, -1)).filter((m) => m.startsWith(`${o1}:`))).toHaveLength(0);
    expect((await riderRow(a.riderId)).acceptanceRate).toBe(aAcceptanceBefore);

    // ── O2 ──
    const released = await orderRow(o2);
    expect(released.holdExpiresAt).toBeNull();
    expect(released.releasedToVendorAt!.getTime()).toBeGreaterThan(o2HoldExpiresAt.getTime());
    o2ReleasedAt = released.releasedToVendorAt;

    // ── C1 ──
    // Attempt 1 was the route's own drain, refused by the injected outage; the
    // sweep's claim is attempt 2 — or a later one when a tick's own publish was
    // the transient and the schedule's next tick got it. Whichever it was, the
    // retry is proven, and the last attempt succeeded cleanly: no error, no
    // live claim, and (below) exactly one publication.
    expect(tail.attempts, 'the sweep retried the row the route could not publish').toBeGreaterThanOrEqual(2);
    expect({ lastError: tail.lastError, claimedAt: tail.claimedAt }).toEqual({ lastError: null, claimedAt: null });
    const autoCancel = await queues.orderQueue.getJob(autoCancelRow);
    expect({ name: autoCancel?.name, data: autoCancel?.data, state: await autoCancel?.getState() }).toEqual({ name: 'auto-cancel', data: { orderId: c1 }, state: 'delayed' });

    // ── Once only: a second tick of each sweep changes nothing ──
    const secondRelease = await tick('release-held-orders');
    const secondDrain = await tick('checkout-outbox');
    await waitFor('the second sweep ticks to complete', async () => [await secondRelease.getState(), await secondDrain.getState()], (s) => s.every((x) => x === 'completed'), 60_000, { consumer: worker, diagnose: async () => ({ ticks: await describeJobs([secondRelease, secondDrain]), deadLetters: await deadLetters() }) });
    expect((await orderRow(o2)).releasedToVendorAt).toEqual(o2ReleasedAt);
    expect(await jobsFor(queues.dispatchQueue, 'dispatch-order', o2, ['waiting', 'prioritized', 'delayed', 'active', 'completed', 'failed'])).toHaveLength(1);
    expect((await sys(() => app.prisma.orderOutbox.findUniqueOrThrow({ where: { id: autoCancelRow } }))).processedAt).toEqual(tail.processedAt);
    expect(await jobsFor(queues.orderQueue, 'auto-cancel', c1, ['waiting', 'prioritized', 'delayed', 'active', 'completed', 'failed'])).toHaveLength(1);
    // The checkout itself replays from its receipt: one order, ever. (Only the
    // order ids are compared: the receipt answers raw order rows, not the
    // original response's shape — reported as G3-F2.)
    const replay = await call('POST', '/api/v1/customer/checkout', checkoutCustomer.token, { paymentMethod: 'CASH' }, { 'idempotency-key': c1Key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    const idsOf = (d: unknown) => ((d as { orders: Array<{ id: string }> }).orders).map((o) => o.id);
    expect(idsOf(replay.json().data)).toEqual(idsOf(c1Answer));
    expect(idsOf(c1Answer)).toEqual([c1]);
    expect(await sys(() => app.prisma.order.count({ where: { customerId: checkoutCustomer.userId } }))).toBe(1);

    // Exactly one owner each, exactly one assignment each.
    const [row1, row2, logs1, logs2] = await Promise.all([
      orderRow(o1), orderRow(o2),
      sys(() => app.prisma.orderStatusLog.count({ where: { orderId: o1, status: 'RIDER_ASSIGNED' } })),
      sys(() => app.prisma.orderStatusLog.count({ where: { orderId: o2, status: 'RIDER_ASSIGNED' } })),
    ]);
    expect({ o1: row1.riderId, o2: row2.riderId, logs1, logs2 }).toEqual({ o1: b.riderId, o2: c.riderId, logs1: 1, logs2: 1 });
    expect((await riderRow(a.riderId)).currentOrderId).toBeNull();

    worker.proc.kill('SIGTERM');
    expect(await worker.exited).toEqual({ code: 0, signal: null });
    // Room for every bounded wait above (60 + 60 + 90 + 60 s) to expire WITH
    // its diagnostics before vitest's own timeout cuts the step off; the
    // journey itself takes about 15 s.
  }, 300_000);

  it('4 · fleet down again, the courier delivers: paid once, nobody left busy, no paid order lost', async () => {
    expect((await orderRow(o1)).riderId, 'step 3 assigned the parcel').toBe(b.riderId);
    for (const slug of ['en-route-pickup', 'arrived-pickup']) {
      const step = await call('PUT', `/api/v1/rider/orders/${o1}/${slug}`, b.token, {});
      expect(step.statusCode, step.body).toBe(200);
    }
    const collect = await call('POST', `/api/v1/courier/order/${o1}/collect`, b.token, { outcome: 'paid', gps: O1_PICKUP });
    expect(collect.statusCode, collect.body).toBe(200);
    // Custody is photo-proven (E16): the pickup photo, then the confirm with its GPS.
    const pickupPhoto = await postPhoto(o1, b.token, 'pickup-proof-photo');
    expect(pickupPhoto.statusCode, pickupPhoto.body).toBe(200);
    const picked = await call('POST', `/api/v1/courier/order/${o1}/pickup-proof`, b.token, { proofPhotoUrl: pickupPhoto.json().data.url, gps: O1_PICKUP });
    expect(picked.statusCode, picked.body).toBe(200);
    for (const slug of ['en-route-delivery', 'arrived']) {
      const step = await call('PUT', `/api/v1/rider/orders/${o1}/${slug}`, b.token, {});
      expect(step.statusCode, step.body).toBe(200);
    }
    const photo = await postPhoto(o1, b.token);
    expect(photo.statusCode, photo.body).toBe(200);
    const url = photo.json().data.url as string;
    const proof = await call('POST', `/api/v1/courier/order/${o1}/proof`, b.token, { proofPhotoUrl: url });
    expect(proof.statusCode, proof.body).toBe(200);
    expect(proof.json().data.status).toBe('DELIVERED');
    const retry = await call('POST', `/api/v1/courier/order/${o1}/proof`, b.token, { proofPhotoUrl: url });
    expect(retry.statusCode).toBe(400);
    expect(retry.json().error.code).toBe('NOT_IN_TRANSIT');

    const [order, fees, courier] = await Promise.all([
      orderRow(o1),
      sys(() => app.prisma.earning.findMany({ where: { orderId: o1 } })),
      riderRow(b.riderId),
    ]);
    expect({ status: order.status, payment: order.paymentStatus }).toEqual({ status: 'DELIVERED', payment: 'CAPTURED' });
    expect(fees.map((e) => ({ type: e.type, rider: e.riderId, amount: Number(e.amount) }))).toEqual([{ type: 'COURIER_FEE', rider: b.riderId, amount: Number(order.deliveryFee) }]);
    expect({ pointer: courier.currentOrderId, available: courier.isAvailable, total: courier.totalDeliveries }).toEqual({ pointer: null, available: true, total: 1 });
  }, 60_000);

  it('5 · a job that exhausts its attempts is a dead letter the founder sees with its recovery verdict; stale and non-founder actions are refused', async () => {
    founder = await makeUser('Farida', ['SUPER_ADMIN'], 'SUPER_ADMIN', { admin: true });
    tenantAdmin = await makeUser('Toby', ['ADMIN'], 'ADMIN', { admin: true });
    // A clean queue so only this job can die, then one dispatch job that cannot succeed.
    await obliterateQueues();
    const doomed = await queues.dispatchQueue.add('dispatch-order', { orderId: 'gold3-no-such-order' }, { attempts: 1, removeOnFail: false, removeOnComplete: false });
    deadJobId = doomed.id!;
    const worker = await startConsumer();
    await waitFor('the dispatch job to die', async () => doomed.getState(), (s) => s === 'failed', 60_000, { consumer: worker, diagnose: () => describeJobs([doomed]) });
    worker.proc.kill('SIGTERM');
    expect(await worker.exited).toEqual({ code: 0, signal: null });
    const dead = (await queues.dispatchQueue.getJob(deadJobId))!;
    deadJobFinishedOn = dead.finishedOn!;
    expect({ attempts: dead.attemptsMade, reason: dead.failedReason }).toEqual({ attempts: 1, reason: 'Order with id gold3-no-such-order not found' });

    const page = await call('GET', '/api/v1/admin/dlq', founder.token);
    expect(page.statusCode, page.body).toBe(200);
    const entries = page.json().data as Array<Record<string, unknown>>;
    expect(entries).toEqual([{
      queue: 'dispatch',
      id: deadJobId,
      name: 'dispatch-order',
      failedReason: dead.failedReason,
      attemptsMade: 1,
      data: JSON.stringify({ orderId: 'gold3-no-such-order' }),
      finishedOn: deadJobFinishedOn,
      recovery: recoveryFor('dispatch-order'),
    }]);

    // Only the founder, on the platform tenant, runs this page.
    expect((await call('GET', '/api/v1/admin/dlq', tenantAdmin.token)).statusCode).toBe(403);
    const byTenantAdmin = await call('POST', `/api/v1/admin/dlq/dispatch/${deadJobId}/requeue?expectedName=dispatch-order&expectedFinishedOn=${deadJobFinishedOn}`, tenantAdmin.token);
    expect(byTenantAdmin.statusCode).toBe(403);
    // A stale page (it shows a different job under this id) is refused.
    const stale = await call('POST', `/api/v1/admin/dlq/dispatch/${deadJobId}/requeue?expectedName=offer-timeout&expectedFinishedOn=${deadJobFinishedOn}`, founder.token);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('JOB_IDENTITY_MISMATCH');
    expect(await dead.getState()).toBe('failed');
  }, 120_000);

  // E36 (S1, ledger): the job classes that carry a crash's recovery were not
  // replay-certified (jobs/recovery-policy.ts), so the DLQ page refused to
  // requeue a dead dispatch job (409 REPLAY_NOT_CERTIFIED). Stage 1 (#1318)
  // certified dispatch-order, offer-timeout, release-held-orders and
  // checkout-outbox; stage 2 certified reconcile-dispatch, each with a replay
  // test that drives the real handler twice. Its first assertion reads the
  // pure register, so a future uncertification fails here first.
  it('[E36] the crash-recovery job classes are certified, and the dead dispatch job requeues from the DLQ page', async () => {
    for (const name of ['dispatch-order', 'offer-timeout', 'release-held-orders', 'checkout-outbox', 'reconcile-dispatch']) {
      expect(recoveryFor(name).policy, name).toBe('SAFE_REPLAY');
    }
    const requeue = await call('POST', `/api/v1/admin/dlq/dispatch/${deadJobId}/requeue?expectedName=dispatch-order&expectedFinishedOn=${deadJobFinishedOn}`, founder.token);
    expect(requeue.statusCode, requeue.body).toBe(200);
    expect(requeue.json().data).toEqual({ queue: 'dispatch', id: deadJobId, retried: true });
    expect(await (await queues.dispatchQueue.getJob(deadJobId))!.getState()).not.toBe('failed');
  });
});
