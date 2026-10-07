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
import { stepUpKey } from '../modules/auth/step-up';

let app: FastifyInstance;
const users: string[] = [];
const sessions: string[] = [];
let sequence = 0;
const run = nanoid(10);
const email = () => `${run}-${++sequence}@example.test`;

async function fixture(oldEmail: string | null = email()) {
  const user = await app.prisma.user.create({ data: {
    phone: `+5920477${String(++sequence).padStart(3, '0')}`,
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
const put = (token: string, body: Record<string, unknown>, header?: string) => app.inject({
  method: 'PUT', url: '/api/v1/customer/profile', payload: body,
  headers: { authorization: `Bearer ${token}`, ...(header ? { 'x-test-after-auth': header } : {}) },
});
const notices = (userId: string) => app.prisma.notification.findMany({ where: { userId, data: { path: ['kind'], equals: 'email_changed' } } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false }); registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-after-auth'] === 'logout') {
      await app.prisma.session.deleteMany({ where: { id: request.authSessionId! } });
    }
    if (request.headers['x-test-after-auth'] === 'ban') {
      await app.prisma.user.update({ where: { id: request.user.userId }, data: { status: 'BANNED' } });
    }
  });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' }); await app.ready();
});
afterAll(async () => {
  vi.restoreAllMocks();
  if (sessions.length) await app.redis.del(...sessions.map(stepUpKey));
  await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  await app.close();
});

describe('email changes require one live-session confirmation and tell the previous contacts', () => {
  it.each([true, false])('refuses an email change without proof (has previous email: %s)', async (hasEmail) => {
    const f = await fixture(hasEmail ? email() : null);
    const response = await put(f.token, { email: email(), firstName: 'Changed' });
    expect(response.statusCode).toBe(403); expect(response.json().error.code).toBe('STEP_UP_REQUIRED');
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).toMatchObject({ email: f.user.email, firstName: 'Synthetic' });
    expect(await notices(f.user.id)).toHaveLength(0);
  });
  it('preserves name-only edits and unchanged email without proof or notices', async () => {
    const f = await fixture();
    expect((await put(f.token, { firstName: 'Updated' })).statusCode).toBe(200);
    expect((await put(f.token, { lastName: 'Updated', email: f.user.email })).statusCode).toBe(200);
    expect(await notices(f.user.id)).toHaveLength(0);
  });
  it('another session proof does not authorize this session', async () => {
    const f = await fixture();
    const other = await app.prisma.session.create({ data: { userId: f.user.id, token: nanoid(), refreshToken: nanoid(64), deviceId: 'other', deviceType: 'test', expiresAt: new Date(Date.now() + 60_000) } });
    sessions.push(other.id); await app.redis.set(stepUpKey(other.id), '1', 'EX', 600);
    expect((await put(f.token, { email: email() })).statusCode).toBe(403);
    expect(await app.redis.exists(stepUpKey(other.id))).toBe(1);
  });
  it('consumes proof once and notifies the old email and existing phone, never the new email', async () => {
    const f = await fixture(); const next = email(); await grantStepUp(app, f.token);
    const start = devChannelLog.length;
    const response = await put(f.token, { firstName: 'Updated', email: next });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ id: f.user.id, firstName: 'Updated', email: next, phone: f.user.phone });
    expect(await app.redis.exists(stepUpKey(f.session.id))).toBe(0);
    expect((await put(f.token, { email: email() })).statusCode).toBe(403);
    const sent = devChannelLog.slice(start);
    expect(sent.filter((n) => n.channel === 'email').map((n) => n.to)).toEqual([f.user.email]);
    expect(sent.filter((n) => n.channel === 'sms').map((n) => n.to)).toEqual([f.user.phone]);
    expect(sent.every((n) => !n.body.includes(next))).toBe(true);
    expect(await notices(f.user.id)).toHaveLength(1);
  });
  it('first email registration still tells the existing phone', async () => {
    const f = await fixture(null); await grantStepUp(app, f.token); const start = devChannelLog.length;
    expect((await put(f.token, { email: email() })).statusCode).toBe(200);
    expect(devChannelLog.slice(start).filter((n) => n.channel === 'email')).toHaveLength(0);
    expect(devChannelLog.slice(start).filter((n) => n.channel === 'sms').map((n) => n.to)).toEqual([f.user.phone]);
  });
  it('two simultaneous email changes cannot spend the same proof twice', async () => {
    const f = await fixture(); await grantStepUp(app, f.token); const next = [email(), email()];
    const responses = await Promise.all(next.map((e) => put(f.token, { email: e })));
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 403]);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).email).toBe(next[responses.findIndex((r) => r.statusCode === 200)]);
    expect(await notices(f.user.id)).toHaveLength(1);
  });
  it.each(['logout', 'ban'])('a %s after authentication still refuses the write and sends no notice', async (action) => {
    const f = await fixture(); await grantStepUp(app, f.token);
    const response = await put(f.token, { email: email() }, action);
    expect(response.statusCode).toBe(action === 'logout' ? 401 : 409);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).email).toBe(f.user.email);
    expect(await notices(f.user.id)).toHaveLength(0);
  });
  it('refuses an unavailable proof store without changing the profile', async () => {
    const f = await fixture(); await grantStepUp(app, f.token);
    const del = vi.spyOn(app.redis, 'del').mockRejectedValueOnce(new Error('synthetic store outage'));
    try { expect((await put(f.token, { email: email() })).statusCode).toBe(500); }
    finally { del.mockRestore(); }
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).email).toBe(f.user.email);
  });
  it('keeps a committed inbox notice and success even when both external delivery attempts fail', async () => {
    const f = await fixture(); await grantStepUp(app, f.token); const next = email();
    const sms = vi.spyOn(getChannels().sms, 'sendSms').mockRejectedValueOnce(new Error('synthetic SMS outage'));
    const mail = vi.spyOn(getChannels().email, 'sendEmail').mockRejectedValueOnce(new Error('synthetic mail outage'));
    try { expect((await put(f.token, { email: next })).statusCode).toBe(200); }
    finally { sms.mockRestore(); mail.mockRestore(); }
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).email).toBe(next);
    expect(await notices(f.user.id)).toHaveLength(1);
  });
});
