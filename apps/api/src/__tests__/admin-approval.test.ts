import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { APPROVAL_HEADER, APPROVAL_TTL_MS, fingerprintOf, requiresApproval } from '../modules/admin/admin-approval';
import { ADMIN_ACTION_CLASSES, ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';

// ---------------------------------------------------------------------------
// [ADM-005] A SETTLEMENT WAS ONE PERSON'S SAY-SO.
//
// Every finance, billing, subscription and ads money route decided on a single
// actor's request. A settlement processed, a fee waived, a top-up granted, an
// invoice marked paid — no independent check, no reversal path. The only
// approval model in the schema gates the autonomous agent; no human action
// passed through anything like it. One mistaken or malicious admin was the
// whole control.
//
// A C4 or C5 action now takes two people. The record says what was asked, by
// whom, with what reason, and who else agreed — and it is bound by fingerprint
// to the request that was reviewed, so an approved settlement cannot be
// re-aimed at a different beneficiary or amount afterwards.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
const REASON = 'Bank confirmed the transfer cleared on the 3rd, reference GY-88213';

async function makeAdmin(permissions: string[]): Promise<{ token: string; userId: string }> {
  const phone = `+59274${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Approver', lastName: `A${RUN}${userIds.length}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
      activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions } },
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'admin-approval', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { token, userId: user.id };
}

const call = (token: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: method as never, url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

/** The money action used throughout: a config write is C5, deterministic, and
 *  leaves a row this suite can read to prove nothing happened. */
const CONFIG_KEY = `ADM005_${RUN}`;
const writeConfig = (token: string, value: unknown, approvalId?: string) =>
  call(token, 'PUT', `/api/v1/admin/config/${CONFIG_KEY}`, { value, reason: REASON },
    approvalId ? { [APPROVAL_HEADER]: approvalId } : {});

const decide = (token: string, id: string, approve: boolean, note?: string) =>
  call(token, 'POST', `/api/v1/admin/approvals/${id}/decide`, { approve, reason: REASON, ...(note ? { note } : {}) });

let requester: { token: string; userId: string };
let approver: { token: string; userId: string };

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
  requester = await makeAdmin(['*']);
  approver = await makeAdmin(['*']);
});
afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.platformConfig.deleteMany({ where: { key: { startsWith: 'ADM005_' } } }).catch(() => {});
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-approval').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:admin-approval');
  await app.close();
});

describe('[ADM-005] one person cannot move money alone', () => {
  it('the request becomes a pending approval and changes NOTHING — the operator is told what it is waiting for', async () => {
    const res = await writeConfig(requester.token, { rate: 1 });
    expect(res.statusCode).toBe(202);
    expect(res.json().error.code).toBe('APPROVAL_REQUIRED');
    const approvalId = res.json().error.details.approvalId as string;
    expect(approvalId).toBeTruthy();

    const written = await app.prisma.platformConfig.findUnique({ where: { key: CONFIG_KEY } });
    expect(written, 'the config must not have been written').toBeNull();

    const approval = await app.prisma.privilegedApproval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(approval.status).toBe('PENDING');
    expect(approval.requestedBy).toBe(requester.userId);
    expect(approval.reason).toBe(REASON); // what the second person reads
    expect(approval.entityId).toBe(CONFIG_KEY);
    expect(approval.cls).toBe('C5');
  });

  it('the requester cannot approve their own ask', async () => {
    const asked = await writeConfig(requester.token, { rate: 2 });
    const approvalId = asked.json().error.details.approvalId as string;
    const res = await decide(requester.token, approvalId, true);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/second person/);
    const approval = await app.prisma.privilegedApproval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(approval.status).toBe('PENDING');
  });

  it('a second admin approves, the requester re-issues, and THEN it happens', async () => {
    const asked = await writeConfig(requester.token, { rate: 3 });
    const approvalId = asked.json().error.details.approvalId as string;

    const decided = await decide(approver.token, approvalId, true, 'Checked against the bank statement');
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().data.status).toBe('APPROVED');

    const done = await writeConfig(requester.token, { rate: 3 }, approvalId);
    expect(done.statusCode, done.body).toBe(200);
    const written = await app.prisma.platformConfig.findUniqueOrThrow({ where: { key: CONFIG_KEY } });
    expect(written.value).toEqual({ rate: 3 });

    const approval = await app.prisma.privilegedApproval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(approval.status).toBe('APPLIED');
    expect(approval.approvedBy).toBe(approver.userId);
    expect(approval.decisionNote).toBe('Checked against the bank statement');
    expect(approval.appliedAt).toBeTruthy();
  });

  it('an approved act cannot be RE-AIMED — changing what you ask for invalidates the approval', async () => {
    const asked = await writeConfig(requester.token, { rate: 10 });
    const approvalId = asked.json().error.details.approvalId as string;
    await decide(approver.token, approvalId, true);

    // the approver read "rate: 10"; the requester now asks for 9999
    const switched = await writeConfig(requester.token, { rate: 9999 }, approvalId);
    expect(switched.statusCode).toBe(403);
    expect(switched.json().error.message).toMatch(/not what was approved/);
    const written = await app.prisma.platformConfig.findUniqueOrThrow({ where: { key: CONFIG_KEY } });
    expect(written.value).not.toEqual({ rate: 9999 });
  });

  it('an approval authorises ONE act — a replay is refused, not repeated (it was spent at the gate)', async () => {
    const asked = await writeConfig(requester.token, { rate: 4 });
    const approvalId = asked.json().error.details.approvalId as string;
    await decide(approver.token, approvalId, true);
    expect((await writeConfig(requester.token, { rate: 4 }, approvalId)).statusCode).toBe(200);

    const replay = await writeConfig(requester.token, { rate: 4 }, approvalId);
    expect(replay.statusCode).toBe(403);
    expect(replay.json().error.message).toMatch(/already been used/);
  });

  it('TWO requests racing on one approval: exactly one acts — the approval IS the authorisation, and only one can hold it', async () => {
    const asked = await writeConfig(requester.token, { rate: 20 });
    const approvalId = asked.json().error.details.approvalId as string;
    await decide(approver.token, approvalId, true);

    const [a, b] = await Promise.all([
      writeConfig(requester.token, { rate: 20 }, approvalId),
      writeConfig(requester.token, { rate: 20 }, approvalId),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes, `${a.statusCode}/${b.statusCode}`).toEqual([200, 403]);
    const loser = a.statusCode === 403 ? a : b;
    expect(loser.json().error.message).toMatch(/already been used/);
  });

  it('a REJECTED request never authorises anything', async () => {
    const asked = await writeConfig(requester.token, { rate: 5 });
    const approvalId = asked.json().error.details.approvalId as string;
    const rejected = await decide(approver.token, approvalId, false, 'The bank statement shows nothing');
    expect(rejected.json().data.status).toBe('REJECTED');

    const tried = await writeConfig(requester.token, { rate: 5 }, approvalId);
    expect(tried.statusCode).toBe(403);
    expect(tried.json().error.message).toMatch(/waiting for a second admin/);
  });

  it('an EXPIRED approval is refused — a decision cannot be banked against a later situation', async () => {
    const asked = await writeConfig(requester.token, { rate: 6 });
    const approvalId = asked.json().error.details.approvalId as string;
    await decide(approver.token, approvalId, true);
    await app.prisma.privilegedApproval.update({
      where: { id: approvalId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const stale = await writeConfig(requester.token, { rate: 6 }, approvalId);
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.message).toMatch(/expired/);
  });

  it('an unknown approval id is refused, not quietly ignored', async () => {
    const res = await writeConfig(requester.token, { rate: 7 }, 'no-such-approval');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/does not exist/);
  });

  it('an approver who could not perform the act cannot authorise it — that is a signature, not a check', async () => {
    // holds the right to DECIDE, but not the right to do the thing itself
    const weak = await makeAdmin(['approvals.read', 'approvals.decide', 'support.read']);
    const asked = await writeConfig(requester.token, { rate: 8 });
    const approvalId = asked.json().error.details.approvalId as string;
    const res = await decide(weak.token, approvalId, true);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/could not perform/);
  });

  it('a decision cannot be re-taken', async () => {
    const asked = await writeConfig(requester.token, { rate: 11 });
    const approvalId = asked.json().error.details.approvalId as string;
    expect((await decide(approver.token, approvalId, true)).statusCode).toBe(200);
    const again = await decide(approver.token, approvalId, false);
    expect(again.statusCode).toBe(409);
  });
});

describe('[ADM-005] the queue a second admin works', () => {
  it('shows what was asked and why, and flags the reader’s own asks — they cannot decide those', async () => {
    const asked = await writeConfig(requester.token, { rate: 12 });
    const approvalId = asked.json().error.details.approvalId as string;

    const mine = await call(requester.token, 'GET', '/api/v1/admin/approvals');
    expect(mine.statusCode).toBe(200);
    const own = (mine.json().data as Array<Record<string, unknown>>).find((r) => r['id'] === approvalId)!;
    expect(own['isOwnRequest']).toBe(true);
    expect(own['reason']).toBe(REASON);
    expect(own['action']).toBe('PUT /config/:key');

    const theirs = await call(approver.token, 'GET', '/api/v1/admin/approvals');
    const seen = (theirs.json().data as Array<Record<string, unknown>>).find((r) => r['id'] === approvalId)!;
    expect(seen['isOwnRequest']).toBe(false);
  });
});

describe('[ADM-005] the law itself', () => {
  it('C4 and C5 need a second person; C0-C3 do not — a ban is one person’s call, with a reason', () => {
    expect(requiresApproval('C4')).toBe(true);
    expect(requiresApproval('C5')).toBe(true);
    for (const cls of ['C0', 'C1', 'C2', 'C3'] as const) expect(requiresApproval(cls)).toBe(false);
    expect(ADMIN_ROUTE_AUTHORITY['PUT /users/:id/ban']!.cls).toBe('C3');
  });

  it('a C3 action still goes through on one person’s word', async () => {
    // it reaches the handler and fails there, on the missing user — never at
    // an approval gate
    const res = await call(requester.token, 'PUT', '/api/v1/admin/users/nobody/ban', { reason: REASON });
    expect(res.statusCode).toBe(404);
  });

  it('the fingerprint covers what is asked, ignores how it was written, and ignores the reason', () => {
    const base = { method: 'PUT', routeUrl: '/config/:key', params: { key: 'X' }, body: { a: 1, b: 2 } };
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base, body: { b: 2, a: 1 } }));
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base, body: { a: 1, b: 2, reason: 'anything' } }));
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, body: { a: 1, b: 3 } }));
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, params: { key: 'Y' } }));
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, method: 'POST' }));
  });

  it('the approval routes are themselves classified, and deciding is not itself a money action', () => {
    expect(ADMIN_ROUTE_AUTHORITY['GET /approvals']!.cls).toBe('C0');
    // if deciding were C4, approving would need approving
    expect(ADMIN_ROUTE_AUTHORITY['POST /approvals/:id/decide']!.cls).toBe('C3');
    expect(ADMIN_ACTION_CLASSES[ADMIN_ROUTE_AUTHORITY['POST /approvals/:id/decide']!.cls].requiresApproval).toBe(false);
  });

  it('the window is a day — long enough to act on, short enough not to be banked', () => {
    expect(APPROVAL_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('the census: every C4 and C5 route demands a second person, and no other route does', () => {
    const dual = Object.entries(ADMIN_ROUTE_AUTHORITY).filter(([, a]) => requiresApproval(a.cls));
    expect(dual.length).toBeGreaterThan(35);
    for (const [key, a] of dual) expect(['C4', 'C5'], key).toContain(a.cls);
    const single = Object.entries(ADMIN_ROUTE_AUTHORITY).filter(([, a]) => !requiresApproval(a.cls));
    for (const [key, a] of single) expect(['C0', 'C1', 'C2', 'C3'], key).toContain(a.cls);
  });
});
