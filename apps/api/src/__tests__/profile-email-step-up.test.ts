import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { devChannelLog, getChannels } from '../providers/notifications/channels';
import { grantStepUp } from './helpers/step-up';
import { testPhone } from './helpers/fixture-ids';
import { stepUpKey } from '../modules/auth/step-up';
import { notificationFailuresCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [L04 #1550] An account's email is where receipts and notices go, and a second
// sign-in identifier. A session alone (stolen, or left signed in) must never
// move it: a real change takes a fresh sign-in code on THIS session, spent by
// the change, and leaves an inbox notice written with it plus a bounded,
// best-effort text to the phone and note to the old address. Name edits, and
// the app re-sending the same address, stay free.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const users: string[] = [];
const sessions: string[] = [];
let sequence = 0;
const run = nanoid(10).toLowerCase();
const email = () => `${run}-${++sequence}@example.test`;

async function fixture(oldEmail: string | null = email()) {
  const user = await app.prisma.user.create({ data: {
    phone: testPhone(),
    firstName: 'Synthetic', lastName: 'Profile', email: oldEmail,
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE', isPhoneVerified: true,
    customer: { create: {} },
  } });
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid() });
  const session = await app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(64), deviceId: 'email-test', deviceType: 'test',
    expiresAt: new Date(Date.now() + 86_400_000),
  } });
  sessions.push(session.id);
  return { user, token, session };
}

const put = (token: string, body: Record<string, unknown>, after?: 'ban') => app.inject({
  method: 'PUT', url: '/api/v1/customer/profile', payload: body,
  headers: { authorization: `Bearer ${token}`, ...(after ? { 'x-test-after-auth': after } : {}) },
});
const notices = (userId: string) => app.prisma.notification.findMany({ where: { userId, data: { path: ['kind'], equals: 'email_changed' } } });
const account = (userId: string) => app.prisma.user.findUniqueOrThrow({ where: { id: userId } });
const failures = async (channel: string) => (await notificationFailuresCounter.get()).values
  .find((v) => v.labels['channel'] === channel && v.labels['stage'] === 'email_change')?.value ?? 0;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // A ban that lands between authentication and the write.
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-after-auth'] === 'ban') {
      await app.prisma.user.update({ where: { id: request.user.userId }, data: { status: 'BANNED' } });
    }
  });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (sessions.length) await app.redis.del(...sessions.map(stepUpKey));
  await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  await app.close();
});

describe('[L04 #1550] a customer email change takes a fresh code on this session and tells the account', () => {
  it.each([true, false])('refuses an email change without the code, nothing written (had an email before: %s)', async (hadEmail) => {
    const f = await fixture(hadEmail ? email() : null);

    const res = await put(f.token, { email: email(), firstName: 'Changed' });

    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    const after = await account(f.user.id);
    expect(after).toMatchObject({ email: f.user.email, firstName: 'Synthetic' });
    expect(after.emailChangedAt).toBeNull();
    expect(await notices(f.user.id)).toHaveLength(0);
  });

  it('name edits, and re-sending the same address, need no code and tell nobody', async () => {
    const f = await fixture();
    const start = devChannelLog.length;

    expect((await put(f.token, { firstName: 'Updated' })).statusCode).toBe(200);
    expect((await put(f.token, { lastName: 'Updated', email: f.user.email })).statusCode).toBe(200);

    expect(await account(f.user.id)).toMatchObject({ firstName: 'Updated', lastName: 'Updated', email: f.user.email, emailChangedAt: null });
    expect(await notices(f.user.id)).toHaveLength(0);
    expect(devChannelLog.slice(start).filter((n) => n.to === f.user.email || n.to === f.user.phone)).toHaveLength(0);
  });

  it("another session's code does not authorise this session, and is not spent", async () => {
    const f = await fixture();
    const other = await app.prisma.session.create({ data: {
      userId: f.user.id, token: nanoid(), refreshToken: nanoid(64), deviceId: 'other', deviceType: 'test',
      expiresAt: new Date(Date.now() + 60_000),
    } });
    sessions.push(other.id);
    await app.redis.set(stepUpKey(other.id), '1', 'EX', 600);

    expect((await put(f.token, { email: email() })).statusCode).toBe(403);
    expect(await app.redis.exists(stepUpKey(other.id))).toBe(1);
    expect((await account(f.user.id)).email).toBe(f.user.email);
  });

  it('with the code: the change is written and dated, the code is spent, and the old email + phone are told (never the new address)', async () => {
    const f = await fixture();
    const next = email();
    await grantStepUp(app, f.token);
    const start = devChannelLog.length;

    const res = await put(f.token, { firstName: 'Updated', email: next });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ id: f.user.id, firstName: 'Updated', email: next, phone: f.user.phone });
    const after = await account(f.user.id);
    expect(after.email).toBe(next);
    expect(Date.now() - after.emailChangedAt!.getTime()).toBeLessThan(60_000);
    expect(await app.redis.exists(stepUpKey(f.session.id)), 'the code authorises ONE change').toBe(0);
    expect((await put(f.token, { email: email() })).statusCode).toBe(403);
    const sent = devChannelLog.slice(start);
    expect(sent.filter((n) => n.channel === 'email').map((n) => n.to)).toEqual([f.user.email]);
    expect(sent.filter((n) => n.channel === 'sms').map((n) => n.to)).toEqual([f.user.phone]);
    expect(sent.every((n) => !n.body.includes(next)), 'the new address is never sent anywhere').toBe(true);
    const rows = await notices(f.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toMatch(/contact Swift support/);
  });

  it('a first email on an account without one still tells the phone and the inbox', async () => {
    const f = await fixture(null);
    await grantStepUp(app, f.token);
    const start = devChannelLog.length;

    expect((await put(f.token, { email: email() })).statusCode).toBe(200);

    const sent = devChannelLog.slice(start);
    expect(sent.filter((n) => n.channel === 'email')).toHaveLength(0);
    expect(sent.filter((n) => n.channel === 'sms').map((n) => n.to)).toEqual([f.user.phone]);
    expect(await notices(f.user.id)).toHaveLength(1);
  });

  it('two simultaneous changes cannot spend the same code twice', async () => {
    const f = await fixture();
    await grantStepUp(app, f.token);
    const next = [email(), email()];

    const responses = await Promise.all(next.map((e) => put(f.token, { email: e })));

    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 403]);
    expect((await account(f.user.id)).email).toBe(next[responses.findIndex((r) => r.statusCode === 200)]);
    expect(await notices(f.user.id)).toHaveLength(1);
  });

  it('a ban that lands after authentication refuses the write and leaves no notice', async () => {
    const f = await fixture();
    await grantStepUp(app, f.token);

    const res = await put(f.token, { email: email() }, 'ban');

    expect(res.statusCode, res.body).toBe(409);
    expect((await account(f.user.id)).email).toBe(f.user.email);
    expect(await notices(f.user.id)).toHaveLength(0);
  });

  it('a code store that cannot answer refuses the change, nothing written', async () => {
    const f = await fixture();
    await grantStepUp(app, f.token);
    const del = vi.spyOn(app.redis, 'del').mockRejectedValueOnce(new Error('synthetic store outage'));
    try {
      expect((await put(f.token, { email: email() })).statusCode).toBe(500);
    } finally {
      del.mockRestore();
    }
    expect((await account(f.user.id)).email).toBe(f.user.email);
    expect(await notices(f.user.id)).toHaveLength(0);
  });

  it('a committed change stays committed, with its inbox notice, when the text and the email both fail', async () => {
    const f = await fixture();
    await grantStepUp(app, f.token);
    const next = email();
    const start = devChannelLog.length;
    const failed = { sms: await failures('sms'), email: await failures('email') };
    // The text: the dev SMS is one shared (sealed) object, so the spy is the one the route calls.
    const sms = vi.spyOn(getChannels().sms, 'sendSms').mockRejectedValueOnce(new Error('synthetic SMS outage'));
    // The email: a configured mailbox that cannot be reached (placeholder values
    // only; a closed local port, so nothing reaches any network or account).
    const keys = ['EMAIL_PROVIDER', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'SMTP_TLS', 'SMTP_TIMEOUT_MS'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USER: 'placeholder', SMTP_PASS: 'placeholder',
      EMAIL_FROM: 'placeholder@example.test', SMTP_TLS: 'none', SMTP_TIMEOUT_MS: '1000',
    });
    try {
      expect((await put(f.token, { email: next })).statusCode).toBe(200);
      expect(sms, 'the text was attempted and failed').toHaveBeenCalledTimes(1);
    } finally {
      sms.mockRestore();
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
    }
    expect(devChannelLog.slice(start).filter((n) => n.to === f.user.email || n.to === f.user.phone), 'nothing was delivered').toHaveLength(0);
    expect({ sms: await failures('sms'), email: await failures('email') }, 'each failure is counted, by channel only')
      .toEqual({ sms: failed.sms + 1, email: failed.email + 1 });
    expect((await account(f.user.id)).email).toBe(next);
    expect(await notices(f.user.id)).toHaveLength(1);
  });
});
