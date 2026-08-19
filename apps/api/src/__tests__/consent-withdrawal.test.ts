import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { mayReceiveMarketing } from '../modules/legal/consent.service';
import { LEGAL_VERSION } from '../modules/legal/legal.routes';

// [DCR-1 NR1-03] The withdrawal surface: marketing consent is a purpose
// consent the subject can grant and withdraw in-app; every change is a new
// append-only ledger row, and repeating the current state writes nothing.
let app: FastifyInstance;
const DAY = 24 * 60 * 60 * 1000;
const createdUserIds: string[] = [];

async function makeCustomer() {
  const user = await app.prisma.user.create({
    data: {
      phone: `+5920071${String(createdUserIds.length + 10)}${nanoid(2).replace(/[^0-9]/g, '0')}`,
      firstName: 'Consent',
      lastName: `Subject${createdUserIds.length}`,
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      customer: { create: {} },
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'nr1-03', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

function post(token: string, granted: boolean) {
  return app.inject({
    method: 'POST', url: '/api/v1/customer/consent/marketing',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: { granted },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  // Users/sessions are deletable; ledger rows are append-only by design and
  // stay (nanoid-fresh subjects, no collision).
  for (const id of createdUserIds) {
    await app.prisma.session.deleteMany({ where: { userId: id } });
    await app.prisma.customer.deleteMany({ where: { userId: id } });
    await app.prisma.user.delete({ where: { id } }).catch(() => {});
  }
  await app.close();
});

describe('marketing consent surface [DCR-1 NR1-03]', () => {
  it('grant → withdraw → re-grant: three ledger rows, state tracks the latest', async () => {
    const { userId, token } = await makeCustomer();

    // Default: no consent, no marketing.
    expect(await mayReceiveMarketing(app.prisma, 'customer', userId)).toBe(false);

    const grant = await post(token, true);
    expect(grant.statusCode).toBe(200);
    expect(grant.json().data).toEqual({ marketing: true, changed: true });
    expect(await mayReceiveMarketing(app.prisma, 'customer', userId)).toBe(true);

    await new Promise((r) => setTimeout(r, 5));
    const withdraw = await post(token, false);
    expect(withdraw.json().data).toEqual({ marketing: false, changed: true });
    expect(await mayReceiveMarketing(app.prisma, 'customer', userId)).toBe(false);

    await new Promise((r) => setTimeout(r, 5));
    const regrant = await post(token, true);
    expect(regrant.json().data).toEqual({ marketing: true, changed: true });

    const rows = await app.prisma.consentRecord.findMany({
      where: { subjectType: 'customer', subjectId: userId, documentType: 'marketing_consent' },
      orderBy: { capturedAt: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual(['granted', 'withdrawn', 're_granted']);
    // Every row anchored to the published marketing text.
    expect(new Set(rows.map((r) => r.documentVersion))).toEqual(new Set([LEGAL_VERSION]));
    expect(rows.every((r) => r.documentContentHash.length === 64)).toBe(true);
  });

  it('repeating the current state writes NOTHING to the ledger', async () => {
    const { userId, token } = await makeCustomer();
    await post(token, true);
    const again = await post(token, true);
    expect(again.json().data).toEqual({ marketing: true, changed: false });
    expect(await app.prisma.consentRecord.count({
      where: { subjectType: 'customer', subjectId: userId, documentType: 'marketing_consent' },
    })).toBe(1);
    // And withdrawing while never-granted also writes nothing.
    const { userId: u2, token: t2 } = await makeCustomer();
    const noop = await post(t2, false);
    expect(noop.json().data).toEqual({ marketing: false, changed: false });
    expect(await app.prisma.consentRecord.count({
      where: { subjectType: 'customer', subjectId: u2, documentType: 'marketing_consent' },
    })).toBe(0);
  });

  it('GET /consent reports the current states from the ledger', async () => {
    const { token } = await makeCustomer();
    await post(token, true);
    const res = await app.inject({
      method: 'GET', url: '/api/v1/customer/consent',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { consents, servedVersion } = res.json().data;
    expect(servedVersion).toBe(LEGAL_VERSION);
    const byType = Object.fromEntries(consents.map((c: { documentType: string; state: string | null }) => [c.documentType, c.state]));
    expect(byType['marketing_consent']).toBe('granted');
    // Created directly (not via /register), so no signup consents exist.
    expect(byType['privacy_policy']).toBeNull();
  });

  it('rejects unauthenticated access', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/customer/consent/marketing',
      headers: { 'content-type': 'application/json' },
      payload: { granted: true },
    });
    expect(res.statusCode).toBe(401);
  });
});
