import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { authPlugin } from '../plugins/auth';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [F-250] An outage is not a credential verdict.
//
// `authenticate` used to wrap the whole check in a bare `catch {}` and answer
// 401 UNAUTHORIZED. So when the session store was unreachable — a saturated
// connection pool, a database restart — every client in the fleet was told
// "Invalid or expired token" with a perfectly valid token in hand.
//
// Observed live on the ELV-2 rig: a 220-request burst against the SOS routes
// (deliberately rate-limit-exempt so a person can tap repeatedly) saturated
// Postgres, and 70 of those requests came back 401. A person in an emergency
// was being told their session was invalid.
//
// Two failure modes, both worse than the outage itself:
//   * clients treat 401 as terminal, clear their tokens and force a re-login,
//     so a transient blip becomes a fleet-wide forced logout; and
//   * the incident presents as an auth problem, sending responders to the
//     wrong system entirely.
//
// A refusal we actually DECIDED stays 401. Anything else is 503, and loud.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let liveToken: string;
const createdUserIds: string[] = [];
const phoneBase = 592_150_000_000 + Math.floor(Math.random() * 800_000_000);
let seq = 0;

/** A real user + live session — exactly what a client holds. */
async function makeSession(status: UserStatus = 'ACTIVE') {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Outage',
      lastName: `P${seq}`,
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      isPhoneVerified: true,
      status,
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: `outage-${nanoid(6)}`,
      deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { userId: user.id, token };
}

const probe = (token: string) =>
  app.inject({ method: 'GET', url: '/probe', headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['JWT_SECRET'] = process.env['JWT_SECRET'] || 'test-secret-for-auth-outage-honesty';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(authPlugin);
  app.get('/probe', { preHandler: [app.authenticate] }, async (request) => ({ ok: true, userId: request.user.userId }));
  // [REPORT-033 #25] The optional decorator has its own outage branch — a
  // guest-personalization route, so the contract is "never refuse, never
  // crash, attach the user only when the session is genuinely live".
  app.get('/probe-optional', { preHandler: [app.authenticateOptional] }, async (request) => ({
    ok: true,
    userId: (request as { user?: { userId?: string } }).user?.userId ?? null,
    sessionId: request.authSessionId ?? null,
  }));
  await app.ready();
  liveToken = (await makeSession()).token;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('[F-250] authenticate distinguishes an outage from a credential verdict', () => {
  it('the control: a live token on a reachable session store is admitted', async () => {
    const res = await probe(liveToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe(createdUserIds[0]);
  });

  it('a valid token + UNREACHABLE session store is 503 AUTH_UNAVAILABLE — never 401', async () => {
    const spy = vi.spyOn(app.prisma.session, 'findUnique').mockRejectedValue(
      Object.assign(new Error("Can't reach database server at `localhost:5434`"), {
        name: 'PrismaClientInitializationError',
      }),
    );
    try {
      const res = await probe(liveToken);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('AUTH_UNAVAILABLE');
      // The body must not tell a signed-in person they were signed out — that
      // is the sentence that makes clients discard working credentials.
      expect(res.json().error.message).not.toMatch(/invalid|expired/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('and it recovers: the same token works again the moment the store is back', async () => {
    const res = await probe(liveToken);
    expect(res.statusCode).toBe(200);
  });

  it('a REVOKED session is still a real 401 — the fix must not soften genuine refusals', async () => {
    const s = await makeSession();
    await app.prisma.session.deleteMany({ where: { userId: s.userId } });
    const res = await probe(s.token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('a garbage token is still a real 401 (a fastify-jwt verdict)', async () => {
    const res = await probe('not-a-jwt');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('a BANNED account is still a real 401, not an outage', async () => {
    const s = await makeSession();
    await app.prisma.user.update({ where: { id: s.userId }, data: { status: 'BANNED' } });
    const res = await probe(s.token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// [REPORT-033 #25] authenticateOptional has an INDEPENDENT outage/session
// branch that had zero test references — every outage case above registers
// only `authenticate`. Its contract: never refuse, never crash; attach the
// user only when the session is genuinely live; an unreachable store demotes
// to GUEST (loudly, in the log) instead of 401ing a browser.
// ---------------------------------------------------------------------------
const probeOptional = (token?: string) =>
  app.inject({ method: 'GET', url: '/probe-optional', headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('[REPORT-033 #25] authenticateOptional — the guest-demotion matrix', () => {
  it('a live token personalizes: user + session attached', async () => {
    const res = await probeOptional(liveToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe(createdUserIds[0]);
    expect(res.json().sessionId).not.toBeNull();
  });

  it('no token at all is a plain guest 200', async () => {
    const res = await probeOptional();
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBeNull();
  });

  it('a garbage token is a guest 200 — the optional door never 401s', async () => {
    const res = await probeOptional('not-a-jwt');
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBeNull();
  });

  it('a valid token + UNREACHABLE session store demotes to GUEST — never 401, never 503, never a crash', async () => {
    const spy = vi.spyOn(app.prisma.session, 'findUnique').mockRejectedValue(
      Object.assign(new Error("Can't reach database server at `localhost:5434`"), {
        name: 'PrismaClientInitializationError',
      }),
    );
    try {
      const res = await probeOptional(liveToken);
      expect(res.statusCode).toBe(200);
      expect(res.json().userId).toBeNull();
      expect(res.json().sessionId).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('and recovers: the same token personalizes again the moment the store is back', async () => {
    const res = await probeOptional(liveToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe(createdUserIds[0]);
  });

  it('a BANNED account token browses as a guest, never as the banned user', async () => {
    const s = await makeSession();
    await app.prisma.user.update({ where: { id: s.userId }, data: { status: 'BANNED' } });
    const res = await probeOptional(s.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBeNull();
  });
});
