import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connect, type AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { requiresApproval } from '../modules/admin/admin-approval';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [FOLLOWUPS · REVIEW-M #2150 S4-1] An admin who hangs up while the two-person
// gate's 202 is still being written never gets the act done.
//
// The gate (admin.routes.ts preValidation) used to SEND its 202 and return.
// Under Fastify 5 a hook's reply resolves on a premature close, and the
// request goes on unless the response has ended: an admin who hung up mid-202
// could have the handler run the C4/C5 act WITHOUT the second person. #2150
// made the gate throw instead; census D (auth-refusal-return-census) pins that
// statically. This pins it on a REAL socket: a slow async onSend keeps every
// response open for 150 ms, the caller hangs up at several points inside it,
// and the act (a C5 platform-config write, deterministic and readable) must
// not have happened.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let port = 0;
const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const KEY_PREFIX = `HANGUP_${RUN}`;
const userIds: string[] = [];
const REASON = 'Bank confirmed the transfer cleared on the 3rd, reference GY-88213';
const SLOW_MS = 150;
let token = '';

async function makeAdmin(): Promise<string> {
  const user = await app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Hangup', lastName: `A${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
      activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
    },
  });
  userIds.push(user.id);
  const jwt = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token: jwt, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'admin-hang-up', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return jwt;
}

const body = (value: number) => JSON.stringify({ value: { rate: value }, reason: REASON });

/** A raw PUT of a C5 config write that hangs up `afterMs` after it is written. */
function hangUp(key: string, afterMs: number) {
  const payload = body(1);
  return new Promise<void>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`PUT /api/v1/admin/config/${key} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
      setTimeout(() => socket.destroy(), afterMs);
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve());
  });
}

const configOf = (key: string) => runWithoutTenant(() => app.prisma.platformConfig.findUnique({ where: { key } }), 'test-read:admin-approval-hang-up');
const approvalsFor = (key: string) => runWithoutTenant(() => app.prisma.privilegedApproval.findMany({ where: { entityId: key } }), 'test-read:admin-approval-hang-up');

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  // Every response stays open SLOW_MS longer, before the admin routes are registered so they inherit it: the window
  // in which a caller can hang up while the gate's 202 is still being written.
  app.addHook('onSend', async (_request, _reply, payload) => {
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    return payload;
  });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  token = await makeAdmin();
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.platformConfig.deleteMany({ where: { key: { startsWith: KEY_PREFIX } } }).catch(() => {});
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-approval-hang-up').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:admin-approval-hang-up');
  await app.close();
});

describe('[FOLLOWUPS · #2150 S4-1] hanging up mid-202 never gets a two-person act done', () => {
  it('the route is a two-person act (C5)', () => {
    const authority = ADMIN_ROUTE_AUTHORITY['PUT /config/:key'];
    expect(authority).toBeTruthy();
    expect(requiresApproval(authority!.cls)).toBe(true);
  });

  it('the control: a caller who waits gets the 202 after the slow write, and nothing is written', async () => {
    const key = `${KEY_PREFIX}_WAIT`;
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/admin/config/${key}`, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body(1),
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_REQUIRED');
    // The window is real: the gate's 202 was held open by the slow write.
    expect(Date.now() - started).toBeGreaterThanOrEqual(SLOW_MS - 10);
    expect(await configOf(key)).toBeNull();
    expect((await approvalsFor(key)).map((a) => a.status)).toEqual(['PENDING']);
  });

  it('a caller who hangs up at any point inside the 202 leaves the act undone: only the pending ask stands', async () => {
    const points = [5, 20, 40, 60, 80, 100, 120, 140];
    for (const afterMs of points) await hangUp(`${KEY_PREFIX}_${afterMs}`, afterMs);
    // Long enough for any handler the hang-up let through to have written.
    await new Promise((resolve) => setTimeout(resolve, 3 * SLOW_MS + 200));
    let reachedGate = 0;
    for (const afterMs of points) {
      const key = `${KEY_PREFIX}_${afterMs}`;
      expect(await configOf(key), `hung up after ${afterMs} ms: the config must not have been written`).toBeNull();
      const asks = await approvalsFor(key);
      expect(asks.every((a) => a.status === 'PENDING'), `hung up after ${afterMs} ms: no ask was applied`).toBe(true);
      reachedGate += asks.length;
    }
    // Most hang-ups land after the gate wrote its ask, inside the slow 202 (the window this pins).
    expect(reachedGate).toBeGreaterThanOrEqual(points.length - 2);
  });
});
