import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, type AddressInfo } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import pino from 'pino';
import { nanoid } from 'nanoid';
import { buildApp } from '../app';
import { runWithoutTenant } from '../plugins/prisma';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [AUTH-FIX · S2-3] A request the API refuses to authenticate gets EXACTLY 401
// (or 503 when the session store is unreachable), and nothing after the guard
// runs.
//
// `authenticate` sent its 401 and then returned undefined. Under Fastify 5 an
// async hook that sends must RETURN the reply: the app's async onSend hooks
// mean the response is not finished when the hook resolves, so `reply.sent`
// is still false, the next hook and the route handler run anyway, read
// `request.user` (not set) and throw. The error handler then logs "Unhandled
// error", counts it toward the 5xx spike page, and overwrites the status
// line: the body says UNAUTHORIZED and the wire says 500. The guards that
// call `authenticate` themselves (the admin console guards, the customer
// module hook, the browse binding) carried on past the refusal the same way.
//
// The phone refreshes its session ONLY on a 401 (apps/mobile src/lib/api.ts).
// A 500 for an expired access token is never refreshed: the person sits on an
// error until they sign out by hand.
//
// Everything here is asserted on a REAL socket (the status line a phone
// reads) against the real composition (buildApp), and the log is read for
// the error lines the old behaviour produced.
// ---------------------------------------------------------------------------

const UNAUTHORIZED = { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } };

let app: FastifyInstance;
let base = '';
const userIds: string[] = [];
/** Calls that must never happen on a refused request. */
const reached = { handler: 0, nextGuard: 0, onRequestHandler: 0 };
/** Handler runs on the slow door after the caller hung up, and the identity it saw. */
const afterHangUp = { handler: 0, sawUser: 0 };
/** Refused requests on the slow door that still carried an identity when they finished. */
const refusedWithIdentity: string[] = [];

// The app logs through pino to fd 1. Point the root logger's stream (which
// every request's child logger inherits) at a buffer for the run.
type LogLine = { level: number; msg?: string; res?: { statusCode?: number }; req?: { url?: string } };
const logLines: LogLine[] = [];
const streamSym = pino.symbols.streamSym as unknown as string;
let originalStream: unknown;
const capture = {
  write(chunk: string) {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try { logLines.push(JSON.parse(line) as LogLine); } catch { /* a non-JSON line is not ours to grade */ }
    }
  },
};

/** The error lines a refused request used to leave behind. */
const ERROR_TRACES = /Unhandled error|Reply was already sent|Promise errored|reply\.sent/i;
const errorTraces = () => logLines.filter((l) => ERROR_TRACES.test(l.msg ?? '') || ERROR_TRACES.test(JSON.stringify(l)));
const completedStatuses = () => logLines.filter((l) => l.msg === 'request completed').map((l) => l.res?.statusCode);

async function makeSession() {
  const user = await app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Refusal', lastName: `Probe${nanoid(4)}`, isPhoneVerified: true, status: 'ACTIVE',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', customer: { create: {} },
    },
    select: { id: true },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(64), deviceId: `refusal-${nanoid(6)}`, deviceType: 'ios', expiresAt: new Date(Date.now() + 3_600_000) },
  });
  return { userId: user.id, token };
}

/** Over the wire, exactly as a phone sends it. */
async function call(method: string, path: string, authorization?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers['authorization'] = authorization;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

/** Every credential a refused phone can hold. Filled in beforeAll. */
const credentials: Record<string, string | undefined> = {};

// Representative doors: the plain per-route guard, the per-route guard on a
// mover route and on the documents status the onboarding screen polls, a
// module-wide onRequest hook that calls authenticate itself (customer), the
// admin console's guards (an onRequest hook + a per-route guard, and the
// founder guard), a write with a body, and a browse surface that holds a
// credential.
const DOORS: Array<{ name: string; method: string; path: string; body?: unknown; credentialOnly?: boolean }> = [
  { name: 'GET /auth/me', method: 'GET', path: '/api/v1/auth/me' },
  { name: 'GET /rider/profile', method: 'GET', path: '/api/v1/rider/profile' },
  { name: 'GET /verification/status', method: 'GET', path: '/api/v1/verification/status' },
  { name: 'GET /customer/profile (module hook)', method: 'GET', path: '/api/v1/customer/profile' },
  { name: 'PUT /customer/profile (a write)', method: 'PUT', path: '/api/v1/customer/profile', body: { firstName: 'Nobody' } },
  { name: 'GET /admin/dashboard/overview (admin guard)', method: 'GET', path: '/api/v1/admin/dashboard/overview' },
  { name: 'GET /admin/staff/document-reviewers (founder guard)', method: 'GET', path: '/api/v1/admin/staff/document-reviewers' },
  { name: 'GET /discovery/categories with a credential (browse binding)', method: 'GET', path: '/api/v1/discovery/categories', credentialOnly: true },
  { name: 'GET probe (preHandler: authenticate, then a second guard)', method: 'GET', path: '/api/v1/__test/auth-refusal-probe' },
  { name: 'GET probe (onRequest: authenticate)', method: 'GET', path: '/api/v1/__test/auth-refusal-probe-onrequest' },
];

beforeAll(async () => {
  app = await buildApp();
  // A door whose handler and second guard count every visit: on a refused
  // request both must stay at zero.
  app.get('/api/v1/__test/auth-refusal-probe', {
    preHandler: [app.authenticate, async (_request: FastifyRequest, _reply: FastifyReply) => { reached.nextGuard += 1; }],
  }, async (request) => {
    reached.handler += 1;
    return { success: true, data: { userId: request.user.userId } };
  });
  app.get('/api/v1/__test/auth-refusal-probe-onrequest', { onRequest: [app.authenticate] }, async (request) => {
    reached.onRequestHandler += 1;
    return { success: true, data: { userId: request.user.userId } };
  });
  // A door whose response is still being written (a slow async onSend) when
  // the caller hangs up. A refusal must stop the request even then.
  await app.register(async (slow) => {
    slow.addHook('onSend', async (_request, _reply, payload) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return payload;
    });
    slow.addHook('onResponse', async (request, reply) => {
      const r = request as { user?: unknown; tenantId?: unknown; authSessionId?: unknown };
      if (reply.statusCode >= 400 && (r.user || r.tenantId || r.authSessionId)) refusedWithIdentity.push(`${reply.statusCode}`);
    });
    slow.post('/api/v1/__test/auth-refusal-slow-door', { preHandler: [app.authenticate] }, async (request) => {
      afterHangUp.handler += 1;
      if ((request as { user?: unknown }).user) afterHangUp.sawUser += 1;
      return { success: true };
    });
  });
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  originalStream = (app.log as unknown as Record<string, unknown>)[streamSym];
  (app.log as unknown as Record<string, unknown>)[streamSym] = capture;

  const live = await makeSession();
  credentials['live'] = `Bearer ${live.token}`;
  const revoked = await makeSession();
  await app.prisma.session.deleteMany({ where: { userId: revoked.userId } });
  credentials['revoked session'] = `Bearer ${revoked.token}`;
  // Signed by the API's own key an hour ago: a 15-minute access token that
  // ran out, exactly what a phone holds after a night asleep.
  credentials['expired token'] = `Bearer ${app.jwt.sign({ userId: live.userId, role: 'CUSTOMER', jti: nanoid(8) }, { clockTimestamp: Date.now() - 3_600_000 })}`;
  credentials['garbage token'] = 'Bearer not-a-jwt';
  // A live session on an account that was suspended: the token still verifies.
  const suspendedAccount = await makeSession();
  await runWithoutTenant(() => app.prisma.user.update({ where: { id: suspendedAccount.userId }, data: { status: 'SUSPENDED' } }), 'test-setup:auth-refusal-status');
  credentials['suspended account'] = `Bearer ${suspendedAccount.token}`;
  credentials['no credential'] = undefined;
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (app) (app.log as unknown as Record<string, unknown>)[streamSym] = originalStream;
  await runWithoutTenant(async () => {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:auth-refusal-status');
  await app?.close();
});

beforeEach(() => {
  logLines.length = 0;
  reached.handler = 0;
  reached.nextGuard = 0;
  reached.onRequestHandler = 0;
});

describe('[S2-3] a refused credential is EXACTLY 401 on the wire, and nothing after the guard runs', () => {
  it('the control: the live session passes the probe door (so the probe can tell the difference)', async () => {
    const res = await call('GET', '/api/v1/__test/auth-refusal-probe', credentials['live']);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(reached).toEqual({ handler: 1, nextGuard: 1, onRequestHandler: 0 });
  });

  for (const credential of ['no credential', 'garbage token', 'expired token', 'revoked session', 'suspended account'] as const) {
    describe(credential, () => {
      for (const door of DOORS) {
        if (door.credentialOnly && credential === 'no credential') continue;
        it(`${door.name} -> 401 with the normal error body; no handler, no error log`, async () => {
          const res = await call(door.method, door.path, credentials[credential], door.body);
          expect({ status: res.status, body: res.json }).toEqual({ status: 401, body: UNAUTHORIZED });
          expect(reached).toEqual({ handler: 0, nextGuard: 0, onRequestHandler: 0 });
          expect(errorTraces()).toEqual([]);
          expect(completedStatuses()).toEqual([401]);
        });
      }
    });
  }
});

describe('[S2-3 · F-250] an unreachable session store is EXACTLY 503 on the wire, and nothing after the guard runs', () => {
  const AUTH_UNAVAILABLE = {
    success: false,
    error: { code: 'AUTH_UNAVAILABLE', message: 'We could not verify your session right now. Please try again in a moment — you have not been signed out.' },
  };

  for (const door of DOORS) {
    it(`${door.name} -> 503 AUTH_UNAVAILABLE; no handler, no unhandled error`, async () => {
      const spy = vi.spyOn(app.prisma.session, 'findUnique').mockRejectedValue(
        Object.assign(new Error('session store unreachable (test)'), { name: 'PrismaClientInitializationError' }),
      );
      try {
        const res = await call(door.method, door.path, credentials['live'], door.body);
        expect({ status: res.status, body: res.json }).toEqual({ status: 503, body: AUTH_UNAVAILABLE });
      } finally {
        spy.mockRestore();
      }
      expect(reached).toEqual({ handler: 0, nextGuard: 0, onRequestHandler: 0 });
      expect(errorTraces()).toEqual([]);
      // The outage itself stays loud: the one [F-250] line, nothing else at error level.
      const errors = logLines.filter((l) => l.level >= 50).map((l) => l.msg);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((m) => /\[F-250\]/.test(m ?? ''))).toBe(true);
      expect(completedStatuses()).toEqual([503]);
    });
  }
});

/** A raw request that hangs up `afterMs` after it is written. */
function hangUp(path: string, authorization: string, afterMs: number) {
  const { port } = new URL(base);
  return new Promise<void>((resolve) => {
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${authorization}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);
      setTimeout(() => socket.destroy(), afterMs);
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve());
  });
}

describe('[S2-3] a caller that hangs up mid-refusal still reaches nothing', () => {
  it('the control: the live session passes the slow door', async () => {
    afterHangUp.handler = 0;
    afterHangUp.sawUser = 0;
    const res = await call('POST', '/api/v1/__test/auth-refusal-slow-door', credentials['live'], {});
    expect(res.status).toBe(200);
    expect(afterHangUp).toEqual({ handler: 1, sawUser: 1 });
  });

  it('a refused request carries no identity onward: no user, no tenant, no session', async () => {
    refusedWithIdentity.length = 0;
    for (const credential of ['revoked session', 'suspended account', 'expired token', 'garbage token'] as const) {
      const res = await call('POST', '/api/v1/__test/auth-refusal-slow-door', credentials[credential], {});
      expect(res.status).toBe(401);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(refusedWithIdentity).toEqual([]);
  });

  for (const credential of ['revoked session', 'suspended account', 'expired token', 'no credential'] as const) {
    it(`${credential}: hanging up while the 401 is still being written runs no handler`, async () => {
      afterHangUp.handler = 0;
      afterHangUp.sawUser = 0;
      // Hang up at several points across the refusal and the slow write.
      for (const afterMs of [5, 20, 40, 80, 120]) {
        await hangUp('/api/v1/__test/auth-refusal-slow-door', credentials[credential] ?? '', afterMs);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(afterHangUp).toEqual({ handler: 0, sawUser: 0 });
    });
  }
});
