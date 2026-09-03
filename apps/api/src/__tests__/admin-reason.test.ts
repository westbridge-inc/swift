import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { cleanupSecondApprovers, injectWithApproval } from './helpers/admin-approval';
import {
  ADMIN_ACTION_CLASSES, ADMIN_REASON_HEADER, ADMIN_REASON_MAX, ADMIN_REASON_MIN, ADMIN_ROUTE_AUTHORITY,
  reasonOf, reasonProblem, reasonRefusal,
} from '../modules/admin/admin-authority';

// ---------------------------------------------------------------------------
// [ADM-006] THE RECORD SHOWED WHAT HAPPENED AND NEVER WHY.
//
// No admin route validated a justification. 43 of the 68 routes that affect a
// person's access, move money, or change the platform took no reason field at
// all — a ban, a settlement, a fee waiver, a national price change, a
// broadcast to every user, all recorded as the fact that a route was called.
// A decision like that cannot be reviewed, appealed or defended.
//
// And where a reason WAS accepted, the console sent the literal string
// 'Suspended by admin', hard-coded at the call site. A reason nobody was asked
// for is a field, not an explanation, and it made "reason recorded" true and
// meaningless at the same time.
//
// The class decides who owes one — C3, C4, C5 — from the same table the
// capability comes from, so a route inherits the law by being classified.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
let token = '';
const REAL_REASON = 'Three written warnings, then a no-show on a paid booking';

const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: method as never, url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const phone = `+59275${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Reason', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN',
      status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
    },
  });
  userIds.push(user.id);
  token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'admin-reason', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
});
afterAll(async () => {
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.platformConfig.deleteMany({ where: { key: { startsWith: 'ADM006_' } } }).catch(() => {});
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-reason').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:admin-reason');
  await app.close();
});

describe('[ADM-006] a consequential action is refused until it says why', () => {
  it('a ban, a settlement, a waiver, a price change and a broadcast are all refused with no reason — and the refusal says what to do', async () => {
    const targets: [string, string, unknown][] = [
      ['PUT', '/api/v1/admin/users/nobody/ban', {}],
      ['PUT', '/api/v1/admin/finance/settlements/nobody/process', {}],
      ['PUT', '/api/v1/admin/subscriptions/nobody/waive-fee', {}],
      ['PUT', '/api/v1/admin/countries/GY/pricing/TAXI_RATES', { base: 1000 }],
      ['POST', '/api/v1/admin/notifications/broadcast', { title: 'x', body: 'y' }],
      ['PUT', '/api/v1/admin/config/DELIVERY_FEE', { value: 1 }],
      ['DELETE', '/api/v1/admin/dlq/order/nobody', undefined],
    ];
    for (const [method, url, payload] of targets) {
      const res = await call(method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(400);
      expect(res.json().error.message, `${method} ${url}`).toMatch(/Say why/);
    }
  });

  it('an OPERATIONAL action is not burdened with one — demanding a reason for everything trains people to type anything', async () => {
    // C2: reversible workflow, no money. It fails for its own reasons (a
    // missing entity), never for a missing justification.
    const res = await call('POST', '/api/v1/admin/orders/nobody/retry-dispatch', {});
    expect(res.statusCode).not.toBe(400);
  });

  it('a word is not a reason, and the console default is not one either', async () => {
    const tooShort = await call('PUT', '/api/v1/admin/users/nobody/ban', { reason: 'bad' });
    expect(tooShort.statusCode).toBe(400);
    expect(tooShort.json().error.message).toMatch(/at least 12/);

    const template = await call('PUT', '/api/v1/admin/users/nobody/ban', { reason: 'Suspended by admin' });
    expect(template.statusCode).toBe(400);
    expect(template.json().error.message).toMatch(/default text/);
  });

  it('a real reason gets through — the gate is on the explanation, not on the action', async () => {
    // it reaches the handler and fails there, on the missing user, not at the gate
    const res = await call('PUT', '/api/v1/admin/users/nobody/ban', { reason: REAL_REASON });
    expect(res.statusCode).toBe(404);
  });

  it('the reason may ride in the header, because some bodies have no room for one', async () => {
    // this route parses its WHOLE body as the pricing document under a strict
    // schema: a `reason` key there is a malformed price book, not an excuse
    const res = await call('PUT', '/api/v1/admin/countries/ZZ/pricing/TAXI_RATES', { base: 1000, perKm: 100, perMin: 10, minimum: 500 }, { [ADMIN_REASON_HEADER]: REAL_REASON });
    expect(res.statusCode).not.toBe(400);
    const stillRefused = await call('PUT', '/api/v1/admin/countries/ZZ/pricing/TAXI_RATES', { base: 1000, perKm: 100, perMin: 10, minimum: 500 });
    expect(stillRefused.statusCode).toBe(400);
    expect(stillRefused.json().error.message).toMatch(/Say why/);
  });

  it('the refusal happens BEFORE the handler — an unexplained action changes nothing', async () => {
    const before = await app.prisma.platformConfig.findUnique({ where: { key: 'ADM006_PROBE' } });
    const res = await call('PUT', '/api/v1/admin/config/ADM006_PROBE', { value: { probe: true } });
    expect(res.statusCode).toBe(400);
    const after = await app.prisma.platformConfig.findUnique({ where: { key: 'ADM006_PROBE' } });
    expect(after).toEqual(before);
  });
});

describe('[ADM-006] the reason is on the record, by name', () => {
  it('the audit row carries the reason as its own field — not buried in a truncated body', async () => {
    const reason = `${REAL_REASON} ${nanoid(6)}`;
    await call('PUT', '/api/v1/admin/users/nobody/ban', { reason });
    // the audit hook writes after the response; give the tick a beat
    await new Promise((r) => setTimeout(r, 150));
    const row = await app.prisma.auditLog.findFirst({
      where: { userId: userIds[0], action: { contains: '/users/:id/ban' } },
      orderBy: { createdAt: 'desc' },
    });
    // a 404 is not audited (nothing changed) — so drive one that reaches a handler
    if (!row) {
      // [ADM-005] a config write is a platform action now: it takes a second
      // admin, and this suite gets one the way the console will
      const probe = await injectWithApproval(app, {
        method: 'PUT', url: '/api/v1/admin/config/ADM006_AUDIT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { value: { ok: true }, reason },
      });
      expect(probe.statusCode, probe.body).toBe(200);
      await new Promise((r) => setTimeout(r, 200));
      const cfg = await app.prisma.auditLog.findFirst({
        where: { userId: userIds[0], action: { contains: '/config/:key' } },
        orderBy: { createdAt: 'desc' },
      });
      expect(cfg, 'an audited config write').toBeTruthy();
      expect((cfg!.changes as Record<string, unknown>)['reason']).toBe(reason);
      return;
    }
    expect((row.changes as Record<string, unknown>)['reason']).toBe(reason);
  });
});

describe('[ADM-006] the law itself', () => {
  it('every class that requires a reason is a class that changes something a person feels', () => {
    for (const cls of ['C3', 'C4', 'C5'] as const) expect(ADMIN_ACTION_CLASSES[cls].requiresReason).toBe(true);
    for (const cls of ['C0', 'C1', 'C2'] as const) expect(ADMIN_ACTION_CLASSES[cls].requiresReason).toBe(false);
  });

  it('the check reads the header first, then the body — a route whose body happens to hold the word is not thereby explained', () => {
    expect(reasonProblem('C4', { reason: REAL_REASON })).toBeNull();
    expect(reasonProblem('C4', {}, { [ADMIN_REASON_HEADER]: REAL_REASON })).toBeNull();
    expect(reasonOf({ reason: 'body one' }, { [ADMIN_REASON_HEADER]: REAL_REASON })).toBe(REAL_REASON);
    expect(reasonOf({ reason: 'body one' })).toBe('body one');
  });

  it('missing, short, long and template are each named — the operator is told which', () => {
    expect(reasonProblem('C3', {})).toBe('missing');
    expect(reasonProblem('C3', { reason: '   ' })).toBe('missing');
    expect(reasonProblem('C3', { reason: 'x'.repeat(ADMIN_REASON_MIN - 1) })).toBe('too-short');
    expect(reasonProblem('C3', { reason: 'x'.repeat(ADMIN_REASON_MAX + 1) })).toBe('too-long');
    expect(reasonProblem('C3', { reason: 'Banned by admin' })).toBe('template');
    expect(reasonProblem('C3', { reason: 'banned by admin.' })).toBe('template');
    expect(reasonProblem('C0', {})).toBeNull();
    for (const p of ['missing', 'too-short', 'too-long', 'template'] as const) {
      expect(reasonRefusal(p, 'C4').length).toBeGreaterThan(20);
    }
  });

  it('a template PREFIX is not a template — a real reason that starts with the old words is still a real reason', () => {
    expect(reasonProblem('C3', { reason: 'Suspended by admin after three written warnings and a no-show' })).toBeNull();
  });

  it('the console asks; it does not answer for the operator', () => {
    const consoleSrc = join(process.cwd(), '..', 'admin', 'src');
    const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const pages = ['app/users/[id]/page.tsx', 'app/users/page.tsx', 'app/orders/page.tsx', 'app/orders/[id]/page.tsx', 'app/vendors/[id]/page.tsx', 'app/moderation/page.tsx']
      .map((f) => readFileSync(join(consoleSrc, f), 'utf8')).join('\n');
    // the comments SAY the old constants, on purpose — they record what was
    // removed. Grade the code.
    expect(code(pages)).not.toMatch(/'(Suspended|Banned|Cancelled|Waived) by admin'/);
    expect(pages).toMatch(/askReason\(/);
    // that a cancelled prompt cancels the ACTION — never falling back to a
    // default, which is the shape that produced the canned strings — is
    // behaviour, and is graded as behaviour next to the helper itself
    // (apps/admin/src/lib/ask-reason.test.ts). A source scan of it looked
    // convincing and proved nothing: it survived the mutation that made a
    // cancelled prompt return 'Suspended by admin'.
    expect(readFileSync(join(consoleSrc, 'lib', 'ask-reason.test.ts'), 'utf8'))
      .toMatch(/a CANCELLED prompt returns nothing/);
  });

  it('the census: every C3-C5 route is covered by the law, and no C0-C2 route is', () => {
    const needs = Object.entries(ADMIN_ROUTE_AUTHORITY).filter(([, a]) => ADMIN_ACTION_CLASSES[a.cls].requiresReason);
    expect(needs.length).toBeGreaterThan(60);
    for (const [key, a] of needs) {
      expect(reasonProblem(a.cls, {}), key).toBe('missing');
      expect(reasonProblem(a.cls, { reason: REAL_REASON }), key).toBeNull();
    }
    const doesNot = Object.entries(ADMIN_ROUTE_AUTHORITY).filter(([, a]) => !ADMIN_ACTION_CLASSES[a.cls].requiresReason);
    for (const [key, a] of doesNot) expect(reasonProblem(a.cls, {}), key).toBeNull();
  });
});
