import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { runWithoutTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { AppError } from '../utils/errors';
import { z } from '../lib/zod';
import { NotificationService } from '../modules/notification/notification.service';
import { acknowledgeOpsAlert, escalateOverdueOpsAlerts } from '../modules/safety/ops-alert';
import { SUSTAINED_ERROR_PAGE_KEY, SUSTAINED_ERROR_PAGE_TITLE, SUSTAINED_ERROR_PAGE_WINDOW_SECONDS, sustainedErrorThreshold, watchErrorRate } from '../modules/ops/error-rate-watch';
import { serverErrorHourKey, tallyServerError } from '../lib/server-error-tally';
import { JOB_RECOVERY } from '../jobs/recovery-policy';
import { alertClassOf } from '../providers/notifications/alert-class';
import { devChannelLog, getChannels, resetDevChannelLog } from '../providers/notifications/channels';
import { gsm7Parts, isGsm7Message } from '../utils/sms-text';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [FIXES-4] Low-rate 500s page an operator, once, inside the SMS rules.
//
// The 5xx pager needs 30 unhandled 500s in ONE minute. 70 of them in 26 bursts
// over seven days could never fire it, so nobody heard of them. Now a count
// over a rolling day pages through the durable ops path. Asserted:
//  1. the pattern that could never fire now fires, at the 10th error;
//  2. one page per episode: errors that go on open no second alert and send no
//     second first-page text; the on-call texts stay inside the SMS cap, GSM-7,
//     one part, a PLATFORM page and nothing SOS;
//  3. an acknowledgement quiets the episode, and a day later it may page again
//     if the errors never stopped (bounded, never silenced);
//  4. an hour with no error closes the page, so nobody is reminded of a
//     condition that ended, and the page does not reopen inside its day;
//  5. the count is what the error handler answered: 500s and unhandled 5xx
//     count; a deliberate 503 refusal and every 4xx do not;
//  6. a typo in the setting never silences the page; the job is registered.
// Each scenario runs on its own far-future clock, so hour buckets never mix.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const ONCALL = testPhone();
const io = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) } as unknown as Server;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const userIds: string[] = [];
/** Each run starts somewhere of its own: the hour buckets of the last run are still in Redis for a day. */
let days = 2_000 + (Date.now() % 100_000);

/** A clock of the scenario's own, on the hour plus five minutes: far past anything another run wrote. */
const clock = () => { days += 40; return Math.floor((Date.now() + days * DAY) / HOUR) * HOUR + 5 * 60_000; };

interface Person { userId: string; device: string }
async function responder(): Promise<Person> {
  const user = await runWithoutTenant(() => app.prisma.user.create({
    data: { phone: testPhone(), firstName: 'Errs', lastName: `E${RUN}${userIds.length}`, roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true },
  }), 'test-fixture:error-rate');
  userIds.push(user.id);
  const device = `ExponentPushToken[errrate-${RUN}-${userIds.length}]`;
  await runWithoutTenant(() => app.prisma.deviceToken.create({ data: { userId: user.id, token: device, platform: 'ios' } }), 'test-fixture:error-rate');
  return { userId: user.id, device };
}

const notifications = () => new NotificationService(app.prisma, io);
const deps = (who: Person[]) => ({ prisma: app.prisma, redis: app.redis, notifications: notifications(), resolveRecipients: async () => who.map((p) => p.userId) });
const tick = (who: Person[], ms: number, env: Readonly<Record<string, string | undefined>> = {}) => watchErrorRate(deps(who), { now: new Date(ms), env });
const errors = async (n: number, ms: number) => { for (let i = 0; i < n; i += 1) await tallyServerError(app.redis, ms); };
const pages = () => runWithoutTenant(() => app.prisma.opsAlert.findMany({ where: { title: SUSTAINED_ERROR_PAGE_TITLE }, orderBy: { createdAt: 'asc' }, include: { recipients: true } }), 'test-read:error-rate');
const openPages = async () => (await pages()).filter((p) => p.closedAt === null);
const texts = () => devChannelLog.filter((e) => e.channel === 'sms' && e.to === ONCALL);
const sweep = (ids: string[], ms: number) => runWithoutTenant(() => escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now: new Date(ms), limit: 100, alertIds: ids, smsDay: app.redis }), 'test:error-rate');

async function wipe() {
  await app.redis.del(SUSTAINED_ERROR_PAGE_KEY);
  await runWithoutTenant(async () => {
    const rows = await app.prisma.opsAlert.findMany({ where: { title: SUSTAINED_ERROR_PAGE_TITLE }, select: { id: true } });
    await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: rows.map((r) => r.id) } } });
    await app.prisma.opsAlert.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  }, 'test-cleanup:error-rate');
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  app.get('/boom', async () => { throw new Error('error-rate boom'); });
  app.get('/refuse-503', async () => { throw new AppError(503, 'PROVIDER_DOWN', 'Try again soon'); });
  app.get('/refuse-502', async () => { throw new AppError(502, 'UPSTREAM', 'Upstream said no'); });
  app.get('/fault-500', async () => { throw new AppError(500, 'INVARIANT', 'An invariant broke'); });
  app.get('/own-500', async () => { throw Object.assign(new Error('own status'), { statusCode: 500, code: 'TENANT_CONTEXT_REQUIRED' }); });
  app.get('/own-503', async () => { throw Object.assign(new Error('own status'), { statusCode: 503, code: 'FST_UNDER_PRESSURE' }); });
  app.get('/own-429', async () => { throw Object.assign(new Error('slow down'), { statusCode: 429, code: 'RATE' }); });
  app.get('/forbidden', async () => { throw new AppError(403, 'NO', 'No'); });
  app.get('/invalid', async () => z.object({ a: z.string() }).parse({}));
  app.get('/duplicate', async () => { throw Object.assign(new (class PrismaClientKnownRequestError extends Error {})('dup'), { code: 'P2002' }); });
  await app.ready();
});

beforeEach(async () => {
  resetDevChannelLog(); process.env['OPS_ONCALL_PHONES'] = ONCALL;
  delete process.env['ERROR_SUSTAINED_ALERT_PER_DAY'];
  await wipe();
});
afterEach(() => { delete process.env['OPS_ONCALL_PHONES']; delete process.env['ERROR_SUSTAINED_ALERT_PER_DAY']; });

afterAll(async () => {
  await wipe();
  await runWithoutTenant(async () => {
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.deviceToken.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:error-rate');
  await app.close();
});

describe('[FIXES-4 1] the pattern the per-minute pager could never see now pages', () => {
  it('70 errors in 26 bursts across 7 days, never 30 in a minute: the page opens at the 10th error, once', async () => {
    const who = [await responder()];
    const t0 = clock();
    const gap = Math.floor((7 * DAY) / 26);
    let sent = 0; let pagedAtError: number | null = null;
    for (let burst = 0; burst < 26; burst += 1) {
      const size = burst % 3 === 0 ? 2 : 3; // 26 bursts, 70 errors
      const at = t0 + burst * gap;
      await errors(size, at);
      sent += size;
      const res = await tick(who, at);
      if (res.outcome === 'delivered' && pagedAtError === null) pagedAtError = sent;
    }
    expect(sent).toBeGreaterThanOrEqual(60);
    expect(pagedAtError).toBeGreaterThanOrEqual(10);
    expect(pagedAtError).toBeLessThanOrEqual(12);
    expect(await pages()).toHaveLength(1);
    expect(texts()).toHaveLength(1);
  });

  it('nine errors in a day page nobody; the tenth does', async () => {
    const who = [await responder()];
    const t0 = clock();
    await errors(9, t0);
    expect(await tick(who, t0)).toMatchObject({ errors: 9, outcome: 'below' });
    expect(await pages()).toHaveLength(0);
    expect(texts()).toHaveLength(0);
    await errors(1, t0 + 60_000);
    expect(await tick(who, t0 + 120_000)).toMatchObject({ errors: 10, outcome: 'delivered' });
    expect(await pages()).toHaveLength(1);
  });

  it('errors spread across the rolling day count together; the ones older than the window do not', async () => {
    const who = [await responder()];
    const t0 = clock();
    // two errors every five hours: ten of them inside a 25 hour reach
    for (let i = 0; i < 4; i += 1) await errors(2, t0 + i * 5 * HOUR);
    expect(await tick(who, t0 + 15 * HOUR)).toMatchObject({ errors: 8, outcome: 'below' });
    await errors(2, t0 + 20 * HOUR);
    expect(await tick(who, t0 + 20 * HOUR)).toMatchObject({ errors: 10, outcome: 'delivered' });
    await wipe();
    // past the 25 hour reach the first two have left the count
    await errors(1, t0 + 26 * HOUR);
    expect(await tick(who, t0 + 26 * HOUR)).toMatchObject({ errors: 9, outcome: 'below' });
  });

  it('the reach holds this hour and the 24 before it, so a whole day always counts, and no more', async () => {
    const who = [await responder()];
    const t0 = clock();
    await errors(10, t0);
    // the last minute of the reach: the bucket 24 hours back still counts, with a fresh error beside it
    await errors(1, t0 + 24 * HOUR);
    expect((await tick(who, t0 + 24 * HOUR)).errors).toBe(11);
    await wipe();
    // one hour on it has left
    await errors(1, t0 + 25 * HOUR);
    expect((await tick(who, t0 + 25 * HOUR)).errors).toBe(2);
  });
});

describe('[FIXES-4 2] one page per episode, inside the on-call rules', () => {
  it('errors that go on open no second alert and no second first-page text', async () => {
    const who = [await responder()];
    const t0 = clock();
    await errors(10, t0);
    expect((await tick(who, t0)).outcome).toBe('delivered');
    for (let m = 5; m <= 120; m += 5) {
      await errors(3, t0 + m * 60_000);
      expect((await tick(who, t0 + m * 60_000)).outcome).toBe('deduped');
    }
    expect(await pages()).toHaveLength(1);
    expect(texts()).toHaveLength(1);
  });

  it('is a platform page, never an SOS: GSM-7, one part, words of its own, no SOS row, the responders pushed', async () => {
    const who = [await responder()];
    const t0 = clock();
    await errors(12, t0);
    await tick(who, t0);
    const [page] = await pages();
    expect(page!.kind).toBe('PLATFORM');
    expect(page!.tenantId).toBeNull();
    expect(page!.sosAlertId).toBeNull();
    expect(page!.body).toContain('12 server errors');
    expect(page!.body).toContain('Unhandled error');
    expect(page!.recipients.map((r) => r.userId)).toEqual(who.map((p) => p.userId));
    const [text] = texts();
    expect(isGsm7Message(text!.body)).toBe(true);
    expect(gsm7Parts(text!.body)).toBe(1);
    expect(text!.body).toBe(`Swift ops: ${SUSTAINED_ERROR_PAGE_TITLE}. Acknowledge it in Mission Control > Ops alerts.`);
    const pushes = devChannelLog.filter((e) => e.channel === 'push' && e.to === who[0]!.device);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.data).toMatchObject({ kind: 'ops_error_sustained', errors: 12 });
    expect(alertClassOf('ops_error_sustained')).toBe(alertClassOf('ops_error_spike'));
    expect(alertClassOf('ops_error_sustained')).toBe('standard');
  });

  it('nobody acknowledging it is bounded by the SMS cap: reminders 2 hours apart, at most 6 texts a UTC day', async () => {
    const who = [await responder()];
    // The ladder's clock is the alert's own createdAt (the real clock), so its sweeps run from it.
    await errors(10, Date.now());
    await tick(who, Date.now());
    const [page] = await pages();
    const t0 = page!.createdAt.getTime();
    const sentAt: number[] = [];
    for (let s = 0; s <= 24 * 3600; s += 300) {
      const before = texts().length;
      await sweep([page!.id], t0 + s * 1000);
      for (let i = before; i < texts().length; i += 1) sentAt.push(s);
    }
    expect(sentAt.length).toBeGreaterThanOrEqual(1);
    expect(sentAt.length + 1).toBeLessThanOrEqual(12);
    const gaps = [0, ...sentAt].slice(1).map((s, i) => s - [0, ...sentAt][i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(7_200);
    const byDay = new Map<string, number>();
    for (const s of [0, ...sentAt]) { const d = new Date(t0 + s * 1000).toISOString().slice(0, 10); byDay.set(d, (byDay.get(d) ?? 0) + 1); }
    expect(Math.max(...byDay.values())).toBeLessThanOrEqual(6);
  });

  it('with nobody staffed the page stays owed: the key is released and one row stays open', async () => {
    const t0 = clock();
    await errors(10, t0);
    expect((await tick([], t0)).outcome).toBe('pending');
    expect(await app.redis.exists(SUSTAINED_ERROR_PAGE_KEY)).toBe(0);
    expect((await tick([], t0 + 300_000)).outcome).toBe('pending');
    expect(await pages()).toHaveLength(1);
  });
});

describe('[FIXES-4 3] an acknowledged episode stays quiet, and is never silenced for good', () => {
  it('after an acknowledgement errors that go on page nobody until the day is out, then once more', async () => {
    const who = [await responder()];
    const t0 = clock();
    await errors(10, t0);
    await tick(who, t0);
    const [page] = await pages();
    expect(SUSTAINED_ERROR_PAGE_WINDOW_SECONDS).toBe(86_400);
    expect(await app.redis.ttl(SUSTAINED_ERROR_PAGE_KEY)).toBeGreaterThan(86_340);
    await runWithoutTenant(() => acknowledgeOpsAlert(app.prisma, { opsAlertId: page!.id, userId: who[0]!.userId }), 'test:error-rate');
    await errors(5, t0 + HOUR);
    expect((await tick(who, t0 + HOUR)).outcome).toBe('deduped');
    expect(await pages()).toHaveLength(1);
    expect(texts()).toHaveLength(1);
    // the day is out (the key's own expiry) and the errors never stopped
    await app.redis.del(SUSTAINED_ERROR_PAGE_KEY);
    await errors(5, t0 + 24 * HOUR);
    expect((await tick(who, t0 + 24 * HOUR)).outcome).toBe('delivered');
    expect(await pages()).toHaveLength(2);
    expect(texts()).toHaveLength(2);
  });
});

describe('[FIXES-4 4] an hour with no error closes the page', () => {
  it('closes it, and the ladder stops', async () => {
    const who = [await responder()];
    const t0 = clock();
    await errors(10, t0);
    await tick(who, t0);
    const [page] = await pages();
    // the bucket of this hour still holds errors, and so does the next hour's reach: open
    expect((await tick(who, t0 + HOUR)).outcome).toBe('deduped');
    expect(await openPages()).toHaveLength(1);
    // two whole buckets on, none of them holds an error
    expect((await tick(who, t0 + 2 * HOUR)).outcome).toBe('quiet');
    expect(await openPages()).toHaveLength(0);
    const closed = (await pages())[0]!;
    expect(closed.closeReason).toBe('errors-stopped');
    resetDevChannelLog();
    await sweep([page!.id], t0 + 3 * HOUR);
    expect(texts()).toHaveLength(0);
    expect(devChannelLog.filter((e) => e.channel === 'push')).toHaveLength(0);
  });

  it('errors that come back inside the day do not reopen it: the page is once a day, whatever the bursts do', async () => {
    const who = [await responder()];
    const t0 = clock();
    await errors(10, t0);
    await tick(who, t0);
    await tick(who, t0 + 2 * HOUR);
    expect(await openPages()).toHaveLength(0);
    await errors(1, t0 + 3 * HOUR);
    expect((await tick(who, t0 + 3 * HOUR)).outcome).toBe('deduped');
    await errors(10, t0 + 6 * HOUR);
    expect((await tick(who, t0 + 6 * HOUR)).outcome).toBe('deduped');
    expect(await pages()).toHaveLength(1);
    expect(texts()).toHaveLength(1);
  });

  it('a quiet tick pages nobody, however many errors the day holds', async () => {
    const who = [await responder()];
    const t0 = clock();
    await errors(50, t0);
    expect((await tick(who, t0 + 3 * HOUR)).outcome).toBe('quiet');
    expect(await pages()).toHaveLength(0);
  });
});

describe('[FIXES-4 5] the count is what the error handler answered', () => {
  const counted = async () => Number((await app.redis.get(serverErrorHourKey(Date.now()))) ?? 0);
  /** The tally runs after the response: wait for it. */
  const settle = async (want: number) => { for (let i = 0; i < 100 && (await counted()) < want; i += 1) await new Promise((r) => setTimeout(r, 10)); };

  beforeEach(async () => {
    // Not across the top of an hour: the bucket under test is this hour's.
    while (Date.now() % HOUR > HOUR - 5_000) await new Promise((r) => setTimeout(r, 250));
    await app.redis.del(serverErrorHourKey(Date.now()));
  });

  it.each([
    ['an unknown error', '/boom', 500],
    ['an AppError 500 (a broken invariant)', '/fault-500', 500],
    ['an error carrying its own 500', '/own-500', 500],
    ['an error carrying its own 503', '/own-503', 503],
  ])('%s counts', async (_name, url, status) => {
    const before = await counted();
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(status);
    await settle(before + 1);
    expect(await counted()).toBe(before + 1);
  });

  it.each([
    ['a deliberate 503 refusal', '/refuse-503', 503],
    ['a deliberate 502 refusal', '/refuse-502', 502],
    ['an error carrying its own 429', '/own-429', 429],
    ['a 403', '/forbidden', 403],
    ['a validation failure', '/invalid', 400],
    ['a duplicate', '/duplicate', 409],
    ['an unmatched path', '/nowhere', 404],
  ])('%s does not', async (_name, url, status) => {
    const before = await counted();
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(status);
    await new Promise((r) => setTimeout(r, 50));
    expect(await counted()).toBe(before);
  });

  it('a failing tally never touches the response', async () => {
    const real = app.redis.incr.bind(app.redis);
    app.redis.incr = (() => Promise.reject(new Error('redis down'))) as typeof app.redis.incr;
    try {
      expect((await app.inject({ method: 'GET', url: '/boom' })).statusCode).toBe(500);
    } finally { app.redis.incr = real; }
  });

  it('a bucket keeps itself past the window it is read in, and every error renews that', async () => {
    const ms = clock();
    await tallyServerError(app.redis, ms);
    const key = serverErrorHourKey(ms);
    expect(await app.redis.ttl(key)).toBeGreaterThan(25 * 3600);
    await app.redis.expire(key, 10);
    await tallyServerError(app.redis, ms);
    expect(await app.redis.ttl(key)).toBeGreaterThan(25 * 3600);
  });
});

describe('[FIXES-4 6] the setting and the job', () => {
  it.each(['', 'abc', '0', '1', '-5', '2.5', 'Infinity'])('a bad setting (%j) falls back to 10: a typo never silences it', (value) => {
    expect(sustainedErrorThreshold({ ERROR_SUSTAINED_ALERT_PER_DAY: value })).toBe(10);
  });
  it('a real setting is honoured, unset means 10', async () => {
    expect(sustainedErrorThreshold({ ERROR_SUSTAINED_ALERT_PER_DAY: '25' })).toBe(25);
    expect(sustainedErrorThreshold({})).toBe(10);
    const who = [await responder()];
    const t0 = clock();
    await errors(11, t0);
    expect(await tick(who, t0, { ERROR_SUSTAINED_ALERT_PER_DAY: '25' })).toMatchObject({ threshold: 25, outcome: 'below' });
  });
  it('is a registered, replay-safe job on a five minute repeat, handled by the worker', () => {
    expect(JOB_RECOVERY['error-rate-watch']).toMatchObject({ policy: 'SAFE_REPLAY' });
    const queue = readFileSync(join(__dirname, '..', 'jobs', 'queue.ts'), 'utf8');
    expect(queue).toMatch(/verificationQueue\.add\('error-rate-watch', \{\}, \{\s*repeat: \{ every: 5 \* 60_000 \}/);
    expect(queue).toContain("job.name === 'error-rate-watch'");
  });
});
