import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [V12] The JWT layer accepts exactly ONE algorithm: HS256. Before the pin,
// @fastify/jwt would verify an HS384/HS512 token signed with the same
// symmetric secret — harmless today, but algorithm agility is the classic
// place a future signer misconfiguration hides. The pin removes the class.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let userId: string;
const DAY = 24 * 60 * 60 * 1000;

const b64u = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** Hand-rolled JWS so the test controls `alg` exactly. */
function forgeToken(alg: 'HS256' | 'HS384' | 'HS512', payload: object, secret: string): string {
  const shaBits = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' } as const;
  const header = b64u(JSON.stringify({ alg, typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }));
  const sig = createHmac(shaBits[alg], secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64u(sig)}`;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  app.get('/probe', { preHandler: [app.authenticate] }, async () => ({ ok: true }));
  await app.ready();

  const stale = await app.prisma.user.findUnique({ where: { phone: '+5920079601' } });
  if (stale) {
    await app.prisma.session.deleteMany({ where: { userId: stale.id } });
    await app.prisma.user.delete({ where: { id: stale.id } });
  }
  const user = await app.prisma.user.create({
    data: {
      phone: '+5920079601', firstName: 'Alg', lastName: 'Pin',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} },
    },
  });
  userId = user.id;
});

afterAll(async () => {
  if (userId) {
    await app.prisma.session.deleteMany({ where: { userId } });
    await app.prisma.customer.deleteMany({ where: { userId } });
    await app.prisma.user.deleteMany({ where: { id: userId } });
  }
  await app.close();
});

async function sessionFor(token: string) {
  await app.prisma.session.create({
    data: {
      userId, token, refreshToken: nanoid(48),
      deviceId: 'alg-pin-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
}

describe('JWT algorithm pin [V12]', () => {
  it('accepts a legitimate HS256 token with a live session', async () => {
    const token = app.jwt.sign({ userId, role: 'CUSTOMER', jti: nanoid(8) });
    await sessionFor(token);
    const res = await app.inject({ method: 'GET', url: '/probe', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it('refuses an HS512 token signed with the SAME secret — even with a live session row', async () => {
    const secret = process.env['JWT_SECRET']!;
    const forged = forgeToken('HS512', { userId, role: 'CUSTOMER', jti: nanoid(8) }, secret);
    // Even if an attacker (or a misconfigured signer) minted a session for it,
    // verification dies at the algorithm gate before any session lookup.
    await sessionFor(forged);
    const res = await app.inject({ method: 'GET', url: '/probe', headers: { authorization: `Bearer ${forged}` } });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an HS384 token signed with the SAME secret', async () => {
    const secret = process.env['JWT_SECRET']!;
    const forged = forgeToken('HS384', { userId, role: 'CUSTOMER', jti: nanoid(8) }, secret);
    const res = await app.inject({ method: 'GET', url: '/probe', headers: { authorization: `Bearer ${forged}` } });
    expect(res.statusCode).toBe(401);
  });

  it('sanity: the forge helper produces tokens the pinned verifier would otherwise accept', () => {
    // The HS256 forge verifies through the app's own verifier — proving the
    // HS384/HS512 refusals above fail on the ALGORITHM, not on a malformed
    // token from the helper.
    const secret = process.env['JWT_SECRET']!;
    const okForged = forgeToken('HS256', { userId, role: 'CUSTOMER' }, secret);
    expect(() => app.jwt.verify(okForged)).not.toThrow();
  });
});
