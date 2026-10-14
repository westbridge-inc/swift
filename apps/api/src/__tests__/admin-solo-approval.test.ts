import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { APPROVAL_HEADER, APPROVAL_TTL_MS, fingerprintOf, resolveApproval } from '../modules/admin/admin-approval';
import { runWithTenant } from '../plugins/tenant-context';
import { stepUpKey } from '../modules/auth/step-up';
import { devChannelLog } from '../providers/notifications/channels';
import {
  SOLO_COOLOFF_CONFIG_KEY, SOLO_COOLOFF_DEFAULT_HOURS, clampCoolOffHours, decideSoloApproval, soloCoolOffHours,
} from '../modules/admin/solo-approval';

// ---------------------------------------------------------------------------
// [OWNER #13 · 13 Oct] SOLO MODE — the owner is the only admin.
//
// A money (C4) or platform (C5) action takes two people. The owner has no
// second admin, so every such action could be ASKED for and none could ever
// happen. Solo mode lets the requester approve their OWN request, but only
// while they are the one admin who could approve it, only as SUPER_ADMIN, and
// only after: a cooling-off wait (default 12 h, cancellable), a fresh sign-in
// code at the moment of decision, an audit row at every step and an email at
// the request and at the decision. The day a second admin who could approve it
// exists, solo mode is off again — for requests already waiting too.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const REASON = 'Raise the batch cap after the Georgetown lunch peak review';
const tenants: string[] = [];
const userIds: string[] = [];

interface Actor { token: string; userId: string; sessionId: string; email: string | null; phone: string }

async function makeTenant(): Promise<string> {
  const id = `solo-${RUN}-${tenants.length}`;
  await runWithoutTenant(() => app.prisma.tenant.create({ data: { id, name: `Solo ${id}`, slug: id, isActive: true } }), 'test-fixture:solo');
  tenants.push(id);
  return id;
}

async function makeAdmin(tenantId: string, opts: { role?: 'SUPER_ADMIN' | 'ADMIN' | 'CUSTOMER'; email?: string | null; permissions?: string[] } = {}): Promise<Actor> {
  const role = opts.role ?? 'SUPER_ADMIN';
  const email = opts.email === undefined ? `owner-${RUN}-${userIds.length}@example.test` : opts.email;
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: `+59275${String(Math.floor(Math.random() * 90000) + 10000)}`,
        firstName: 'Solo', lastName: `Owner${RUN}${userIds.length}`, roles: role === 'CUSTOMER' ? ['CUSTOMER'] : [role, 'CUSTOMER'], activeRole: role,
        status: 'ACTIVE', isPhoneVerified: true, tenantId, ...(email ? { email } : {}),
        ...(role === 'CUSTOMER' ? {} : { admin: { create: { permissions: opts.permissions ?? ['*'] } } }),
      },
    });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
    const session = await app.prisma.session.create({
      data: {
        userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
        deviceId: 'admin-solo', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    return { token, userId: user.id, sessionId: session.id, email, phone: user.phone };
  }, 'test-fixture:solo');
}

const call = (actor: Actor, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: method as never, url,
    headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json', 'x-swift-reason': REASON, ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

/** A C5 action that works in any market: the market's own batching dials. */
async function ask(actor: Actor, maxOrdersPerRun = 2): Promise<string> {
  const res = await call(actor, 'PUT', '/api/v1/admin/batching/settings', { maxOrdersPerRun, reason: REASON });
  expect(res.statusCode, res.body).toBe(202);
  return res.json().error.details.approvalId as string;
}
const startSolo = (actor: Actor, id: string) => call(actor, 'POST', `/api/v1/admin/approvals/${id}/solo`, {});
const cancel = (actor: Actor, id: string) => call(actor, 'POST', `/api/v1/admin/approvals/${id}/cancel`, {});
const decide = (actor: Actor, id: string, approve = true) =>
  call(actor, 'POST', `/api/v1/admin/approvals/${id}/decide`, { approve, reason: REASON, note: 'Read it again after the wait; still right' });
const apply = (actor: Actor, id: string) => call(actor, 'POST', `/api/v1/admin/approvals/${id}/apply`, {});

/** A verified step-up on THIS session, exactly as POST /auth/step-up/verify leaves it. */
const stepUp = (actor: Actor) => app.redis.set(stepUpKey(actor.sessionId), '1', 'EX', 600);
const hasStepUp = async (actor: Actor) => (await app.redis.exists(stepUpKey(actor.sessionId))) === 1;

/** The cooling-off wait, passed: the solo request and its end both moved into
 *  the past by the full wait, exactly as if the hours had gone by. */
const elapse = (id: string) => runWithoutTenant(() => app.prisma.privilegedApproval.update({
  where: { id },
  data: {
    soloRequestedAt: new Date(Date.now() - SOLO_COOLOFF_DEFAULT_HOURS * 3_600_000 - 60_000),
    soloEligibleAt: new Date(Date.now() - 60_000),
  } as never,
}), 'test-fixture:solo');

const row = (id: string) => runWithoutTenant(
  () => app.prisma.privilegedApproval.findUniqueOrThrow({ where: { id } }),
  'test-fixture:solo',
) as Promise<Record<string, unknown> & { status: string; approvedBy: string | null; expiresAt: Date }>;

const auditRows = (id: string) => runWithoutTenant(
  () => app.prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: 'asc' } }),
  'test-fixture:solo',
);

const emailsTo = (to: string | null) => devChannelLog.filter((entry) => entry.channel === 'email' && entry.to === to);

const batchCap = (tenantId: string) => runWithoutTenant(
  () => app.prisma.batchingSettings.findFirst({ where: { tenantId }, select: { maxOrdersPerRun: true } }),
  'test-fixture:solo',
);

async function withEmailDown<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { provider: process.env['EMAIL_PROVIDER'], host: process.env['SMTP_HOST'] };
  process.env['EMAIL_PROVIDER'] = 'smtp';
  delete process.env['SMTP_HOST'];
  try {
    return await fn();
  } finally {
    if (saved.provider === undefined) delete process.env['EMAIL_PROVIDER']; else process.env['EMAIL_PROVIDER'] = saved.provider;
    if (saved.host !== undefined) process.env['SMTP_HOST'] = saved.host;
  }
}

/** A mailbox that IS configured but cannot be reached: the send itself fails.
 *  Placeholder values only — nothing here is, or reaches, a real account. */
async function withMailboxUnreachable<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ['EMAIL_PROVIDER', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'SMTP_TLS', 'SMTP_TIMEOUT_MS'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USER: 'placeholder', SMTP_PASS: 'placeholder',
    EMAIL_FROM: 'placeholder@example.test', SMTP_TLS: 'none', SMTP_TIMEOUT_MS: '2000',
  });
  try {
    return await fn();
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  }
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => {});
    await app.prisma.batchingSettings.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => {});
    await app.prisma.platformConfig.deleteMany({ where: { key: SOLO_COOLOFF_CONFIG_KEY } }).catch(() => {});
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-solo').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.prisma.tenant.deleteMany({ where: { id: { in: tenants } } }).catch(() => {});
  }, 'test-cleanup:admin-solo');
  await app.close();
});

describe('[OWNER #13] solo approval — the one admin approves their own request, slowly and loudly', () => {
  it('with ONE admin: start the wait, refused before it ends, refused without a fresh code, then approved and applied', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const id = await ask(owner);
    const before = emailsTo(owner.email).length;

    const started = await startSolo(owner, id);
    expect(started.statusCode, started.body).toBe(200);
    const eligibleAt = new Date(started.json().data.soloEligibleAt as string).getTime();
    // the default wait is 12 hours, measured from the request to go solo
    expect(eligibleAt - Date.now()).toBeGreaterThan(SOLO_COOLOFF_DEFAULT_HOURS * 3_600_000 - 120_000);
    expect(eligibleAt - Date.now()).toBeLessThanOrEqual(SOLO_COOLOFF_DEFAULT_HOURS * 3_600_000 + 1_000);
    // the request outlives the wait: it can still be decided for a full approval window afterwards
    const stored = await row(id);
    expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(eligibleAt + APPROVAL_TTL_MS - 1_000);
    expect(stored['soloRequestedAt']).toBeTruthy();
    // an email to the owner's own address at the request
    expect(emailsTo(owner.email).length).toBe(before + 1);
    expect(emailsTo(owner.email).at(-1)!.body).toMatch(/cancel/i);

    // before the wait ends: refused, nothing decided
    await stepUp(owner);
    const early = await decide(owner, id);
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json().error.code).toBe('SOLO_COOLING_OFF');
    expect((await row(id)).status).toBe('PENDING');
    expect(await hasStepUp(owner), 'a refusal before the wait ends must not spend the code').toBe(true);

    // after the wait, without a fresh code: refused
    await elapse(id);
    await app.redis.del(stepUpKey(owner.sessionId));
    const noCode = await decide(owner, id);
    expect(noCode.statusCode, noCode.body).toBe(403);
    expect(noCode.json().error.code).toBe('STEP_UP_REQUIRED');
    expect((await row(id)).status).toBe('PENDING');

    // after the wait, with a fresh code: approved — and the code is spent
    await stepUp(owner);
    const atDecision = emailsTo(owner.email).length;
    const approved = await decide(owner, id);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().data.status).toBe('APPROVED');
    const decided = await row(id);
    expect(decided.status).toBe('APPROVED');
    expect(decided.approvedBy).toBe(owner.userId);
    expect(decided['decidedSolo']).toBe(true);
    expect(await hasStepUp(owner), 'the sign-in code authorises ONE decision').toBe(false);
    expect(emailsTo(owner.email).length, 'an email at the decision').toBe(atDecision + 1);

    // the approved action happens when the owner executes it
    expect(await batchCap(tenantId)).toBeNull();
    const applied = await apply(owner, id);
    expect(applied.statusCode, applied.body).toBe(200);
    expect((await row(id)).status).toBe('APPLIED');
    expect((await batchCap(tenantId))?.maxOrdersPerRun).toBe(2);

    // audit rows: the solo request and the solo decision
    const trail = await auditRows(id);
    const facts = trail.map((r) => (r.changes as Record<string, unknown> | null)?.['solo']);
    expect(facts).toEqual(expect.arrayContaining(['requested', 'approved']));
  });

  it('with TWO admins: going solo is refused and self-approval stays refused (true two-person)', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    await makeAdmin(tenantId, { email: null });
    const id = await ask(owner);

    const started = await startSolo(owner, id);
    expect(started.statusCode, started.body).toBe(403);
    expect(started.json().error.code).toBe('SOLO_SECOND_ADMIN');

    await stepUp(owner);
    const self = await decide(owner, id);
    expect(self.statusCode).toBe(403);
    expect(self.json().error.message).toMatch(/second person/);
    const stored = await row(id);
    expect(stored.status).toBe('PENDING');
    expect(stored['soloEligibleAt'] ?? null).toBeNull();
  });

  it('a second admin added DURING the wait switches solo off: self-approval refused, the second admin decides', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const id = await ask(owner);
    expect((await startSolo(owner, id)).statusCode).toBe(200);
    await elapse(id);

    const second = await makeAdmin(tenantId, { email: null });
    await stepUp(owner);
    const self = await decide(owner, id);
    expect(self.statusCode, self.body).toBe(403);
    expect(self.json().error.code).toBe('SOLO_SECOND_ADMIN');
    expect((await row(id)).status).toBe('PENDING');
    expect(await hasStepUp(owner), 'a refusal that needs no code must not spend one').toBe(true);

    const byOther = await decide(second, id);
    expect(byOther.statusCode, byOther.body).toBe(200);
    expect((await row(id)).approvedBy).toBe(second.userId);
  });

  it('a second admin added AFTER a solo decision voids it before it executes (no grandfathering)', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const id = await ask(owner, 3);
    expect((await startSolo(owner, id)).statusCode).toBe(200);
    await elapse(id);
    await stepUp(owner);
    expect((await decide(owner, id)).statusCode).toBe(200);

    await makeAdmin(tenantId, { email: null });
    const applied = await apply(owner, id);
    expect(applied.statusCode, applied.body).toBe(403);
    expect(applied.json().error.message).toMatch(/second admin/i);
    expect((await row(id)).status).toBe('APPROVED');
    expect(await batchCap(tenantId)).toBeNull();
  });

  it('an ADMIN who is not the owner (SUPER_ADMIN) can never go solo', async () => {
    const tenantId = await makeTenant();
    const admin = await makeAdmin(tenantId, { role: 'ADMIN' });
    const id = await ask(admin);
    const started = await startSolo(admin, id);
    expect(started.statusCode, started.body).toBe(403);
    expect(started.json().error.code).toBe('SOLO_NOT_OWNER');
    expect((await row(id))['soloEligibleAt'] ?? null).toBeNull();
  });

  it('email is required: no address on the account, or email not set up, refuses solo mode — never skips the email', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId, { email: null });
    const id = await ask(owner);
    const noAddress = await startSolo(owner, id);
    expect(noAddress.statusCode, noAddress.body).toBe(409);
    expect(noAddress.json().error.code).toBe('SOLO_NO_EMAIL');
    expect((await row(id))['soloEligibleAt'] ?? null).toBeNull();

    const tenant2 = await makeTenant();
    const owner2 = await makeAdmin(tenant2);
    const id2 = await ask(owner2);
    const down = await withEmailDown(() => startSolo(owner2, id2));
    expect(down.statusCode, down.body).toBe(503);
    expect(down.json().error.code).toBe('SOLO_EMAIL_UNAVAILABLE');
    expect((await row(id2))['soloEligibleAt'] ?? null, 'nothing started when the email could not go').toBeNull();
    expect((await auditRows(id2)).length, 'and nothing recorded as having started').toBe(0);
  });

  it('a configured mailbox that fails to SEND refuses too — at the start and at the decision', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const id = await ask(owner);
    const start = await withMailboxUnreachable(() => startSolo(owner, id));
    expect(start.statusCode, start.body).toBe(503);
    expect(start.json().error.code).toBe('SOLO_EMAIL_UNAVAILABLE');
    expect((await row(id))['soloEligibleAt'] ?? null, 'the wait rolled back with the failed email').toBeNull();
    expect((await auditRows(id)).length, 'and its audit row with it').toBe(0);

    expect((await startSolo(owner, id)).statusCode).toBe(200);
    await elapse(id);
    await stepUp(owner);
    const decided = await withMailboxUnreachable(() => decide(owner, id));
    expect(decided.statusCode, decided.body).toBe(503);
    expect(decided.json().error.code).toBe('SOLO_EMAIL_UNAVAILABLE');
    const stored = await row(id);
    expect(stored.status).toBe('PENDING');
    expect(stored.approvedBy).toBeNull();
  });

  it('a second admin created DURING the decision (after the code is spent) is still counted: refused, nothing decided', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const id = await ask(owner);
    expect((await startSolo(owner, id)).statusCode).toBe(200);
    await elapse(id);
    const attempt = runWithTenant(tenantId, () => decideSoloApproval(app.prisma, id,
      { userId: owner.userId, role: 'SUPER_ADMIN', holds: () => true },
      { approve: true, note: 'race: a second admin appears mid-decision' },
      {
        // the race, made deterministic: the second admin lands between the
        // checks before the code and the transaction that decides
        consumeStepUp: async () => { await makeAdmin(tenantId, { email: null }); },
        onAudit: async () => {},
      }));
    await expect(attempt).rejects.toMatchObject({ code: 'SOLO_SECOND_ADMIN' });
    const stored = await row(id);
    expect(stored.status).toBe('PENDING');
    expect(stored.approvedBy).toBeNull();
  });

  it('an email failure at the DECISION refuses the decision: the request stays pending', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const id = await ask(owner);
    expect((await startSolo(owner, id)).statusCode).toBe(200);
    await elapse(id);
    await stepUp(owner);
    const res = await withEmailDown(() => decide(owner, id));
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error.code).toBe('SOLO_EMAIL_UNAVAILABLE');
    const stored = await row(id);
    expect(stored.status).toBe('PENDING');
    expect(stored.approvedBy).toBeNull();
  });

  it('the requester can cancel during the wait; a cancelled request can never be approved', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const id = await ask(owner);
    expect((await startSolo(owner, id)).statusCode).toBe(200);

    const cancelled = await cancel(owner, id);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await row(id)).status).toBe('CANCELLED');
    const trail = await auditRows(id);
    expect(trail.map((r) => (r.changes as Record<string, unknown> | null)?.['solo'])).toContain('cancelled');

    await elapse(id);
    await stepUp(owner);
    const late = await decide(owner, id);
    expect(late.statusCode).toBeGreaterThanOrEqual(400);
    expect((await row(id)).status).toBe('CANCELLED');
    // and the cancelled id cannot be spent at the gate either
    const replay = await call(owner, 'PUT', '/api/v1/admin/batching/settings', { maxOrdersPerRun: 2, reason: REASON }, { [APPROVAL_HEADER]: id });
    expect(replay.statusCode).toBe(403);
  });

  it('only the requester can start or cancel; nobody else can', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const other = await makeAdmin(tenantId, { email: null });
    const id = await ask(owner);
    const started = await startSolo(other, id);
    expect(started.statusCode, started.body).toBe(403);
    const cancelled = await cancel(other, id);
    expect(cancelled.statusCode, cancelled.body).toBe(403);
    expect((await row(id)).status).toBe('PENDING');
  });

  it('the database refuses a self-approval that did not go through solo mode', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const id = await ask(owner);
    await expect(runWithoutTenant(() => app.prisma.privilegedApproval.update({
      where: { id }, data: { status: 'APPROVED', approvedBy: owner.userId, decidedAt: new Date() },
    }), 'test-fixture:solo')).rejects.toThrow();
    expect((await row(id)).status).toBe('PENDING');
  });
});

describe('[OWNER #13] the apply gate never trusts a self-approval that was not decided in solo mode', () => {
  it('refuses approvedBy == requestedBy without decidedSolo, even if the database ever held one', async () => {
    // The database CHECK makes this row impossible; the gate refuses it anyway.
    const subject = { method: 'PUT', routeUrl: '/batching/settings', params: {}, body: {} };
    const stub = {
      privilegedApproval: {
        findUnique: async () => ({
          id: 'ap-x', status: 'APPROVED', requestedBy: 'u-1', approvedBy: 'u-1', decidedSolo: false,
          capability: 'platform.algo.write', fingerprint: fingerprintOf(subject), expiresAt: new Date(Date.now() + 3_600_000),
        }),
        updateMany: async () => ({ count: 1 }),
      },
      user: { findMany: async () => [{ id: 'u-1', activeRole: 'SUPER_ADMIN', roles: ['SUPER_ADMIN'], admin: { permissions: ['*'] } }] },
    };
    const outcome = await resolveApproval(stub as never, { cls: 'C5', capability: 'platform.algo.write' },
      subject, { userId: 'u-1', role: 'SUPER_ADMIN' }, 'ap-x', REASON);
    expect(outcome).toMatchObject({ outcome: 'refused', code: 'self-approval' });
  });
});

describe('[OWNER #13] the cooling-off setting', () => {
  it('defaults to 12 hours and never goes below 1 hour', async () => {
    expect(clampCoolOffHours(undefined)).toBe(12);
    expect(clampCoolOffHours('nonsense')).toBe(12);
    expect(clampCoolOffHours(0)).toBe(1);
    expect(clampCoolOffHours(0.25)).toBe(1);
    expect(clampCoolOffHours(-5)).toBe(1);
    expect(clampCoolOffHours(6)).toBe(6);
    expect(clampCoolOffHours(10_000)).toBe(168);

    await runWithoutTenant(() => app.prisma.platformConfig.upsert({
      where: { key: SOLO_COOLOFF_CONFIG_KEY }, create: { key: SOLO_COOLOFF_CONFIG_KEY, value: 0.1 }, update: { value: 0.1 },
    }), 'test-fixture:solo');
    expect(await soloCoolOffHours(app.prisma)).toBe(1);
    await runWithoutTenant(() => app.prisma.platformConfig.deleteMany({ where: { key: SOLO_COOLOFF_CONFIG_KEY } }), 'test-fixture:solo');
    expect(await soloCoolOffHours(app.prisma)).toBe(12);
  });
});

describe('[DS1111] who counts follows what can actually happen', () => {
  it('in shadow capability mode an admin without approvals.decide can still decide, so they count', async () => {
    const { approversFor } = await import('../modules/admin/solo-approval');
    const roster = [
      { userId: 'owner', role: 'SUPER_ADMIN', held: ['*'] },
      { userId: 'finance', role: 'ADMIN', held: ['platform.algo.write'] },
    ];
    expect(approversFor(roster, 'platform.algo.write', 'enforce').map((a) => a.userId)).toEqual(['owner']);
    expect(approversFor(roster, 'platform.algo.write', 'shadow').map((a) => a.userId)).toEqual(['owner', 'finance']);
  });
});

describe('[DS1111] the screen never offers solo on an expired request', () => {
  it('a pending request past its expiry reads as unavailable, not available or ready', async () => {
    const { soloRowState } = await import('../modules/admin/solo-approval');
    const now = new Date('2026-10-14T12:00:00Z');
    const ctx = { userId: 'owner', role: 'SUPER_ADMIN', roster: [{ userId: 'owner', role: 'SUPER_ADMIN', held: ['*'] }], hasEmail: true, emailReady: true, coolOffHours: 12, now };
    const expired = new Date(now.getTime() - 1);
    expect(soloRowState({ status: 'PENDING', capability: 'x', soloRequestedAt: null, soloEligibleAt: null, expiresAt: expired }, ctx))
      .toMatchObject({ state: 'unavailable', why: 'expired' });
    expect(soloRowState({ status: 'PENDING', capability: 'x', soloRequestedAt: new Date(now.getTime() - 13 * 3_600_000), soloEligibleAt: new Date(now.getTime() - 3_600_000), expiresAt: expired }, ctx))
      .toMatchObject({ state: 'unavailable', why: 'expired' });
    expect(soloRowState({ status: 'PENDING', capability: 'x', soloRequestedAt: null, soloEligibleAt: null, expiresAt: new Date(now.getTime() + 3_600_000) }, ctx))
      .toMatchObject({ state: 'available', coolOffHours: 12 });
  });
});

// ---------------------------------------------------------------------------
// [Opus money review S2 · 14 Oct] The solo warning goes to the account's
// email. A stolen session must never be able to move that address and then
// go solo with the warnings landing in the thief's inbox: an admin's email
// change takes a fresh sign-in code and tells the OLD address; solo stays off
// for seven days after any email change; and every solo notice ALSO goes by
// text to the phone on the account.
// ---------------------------------------------------------------------------

const changeEmail = (actor: Actor, email: string, extra: Record<string, unknown> = {}) =>
  call(actor, 'PUT', '/api/v1/customer/profile', { ...extra, email });

const account = (userId: string) => runWithoutTenant(
  () => app.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
  'test-fixture:solo',
) as Promise<Record<string, unknown> & { email: string | null }>;

/** Move the account's last email change back in time, as if the days had gone by. */
const emailChangedDaysAgo = (userId: string, days: number) => runWithoutTenant(() => app.prisma.user.update({
  where: { id: userId },
  data: { emailChangedAt: new Date(Date.now() - days * 24 * 3_600_000) } as never,
}), 'test-fixture:solo');

const textsTo = (phone: string) => devChannelLog.filter((entry) => entry.channel === 'sms' && entry.to === phone);

/** Texts that cannot go: a real provider shape (placeholder identity, never a
 *  real account) whose recipient list is empty, so nothing is sent — exactly
 *  what a non-production server does for a number not on its list. fetch is
 *  stubbed to fail too, so nothing here can ever reach a network. */
async function withTextsDown<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ['NOTIFICATION_PROVIDER', 'TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID', 'SMS_RECIPIENT_ALLOWLIST'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const savedFetch = globalThis.fetch;
  Object.assign(process.env, {
    NOTIFICATION_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`, TWILIO_API_KEY_SID: `SK${'0'.repeat(32)}`,
    TWILIO_API_KEY_SECRET: 'placeholder', TWILIO_FROM: '+15550000000', SMS_RECIPIENT_ALLOWLIST: '',
  });
  delete process.env['TWILIO_MESSAGING_SERVICE_SID'];
  globalThis.fetch = (async () => { throw new Error('no network in this test'); }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = savedFetch;
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  }
}

describe('[Opus S2] an admin account email is where solo warnings go — a session alone can never move it', () => {
  it('changing an admin email needs a fresh sign-in code; without one nothing changes', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const res = await changeEmail(owner, `thief-${RUN}-a@example.test`);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    const after = await account(owner.userId);
    expect(after.email).toBe(owner.email);
    expect(after['emailChangedAt'] ?? null).toBeNull();
  });

  it('with the code: the email changes, the OLD address is told, the change is dated and the code is spent', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const next = `new-${RUN}-b@example.test`;
    const toOld = emailsTo(owner.email).length;
    await stepUp(owner);
    const res = await changeEmail(owner, next);
    expect(res.statusCode, res.body).toBe(200);
    const after = await account(owner.userId);
    expect(after.email).toBe(next);
    expect(Date.now() - (after['emailChangedAt'] as Date).getTime()).toBeLessThan(60_000);
    expect(emailsTo(owner.email).length, 'the OLD address is told').toBe(toOld + 1);
    const notice = emailsTo(owner.email).at(-1)!;
    expect(notice.body).toMatch(/was not you/i);
    // [Opus S4-1] after a SIM swap, signing in and the code both reach the thief: the first step is the carrier
    expect(notice.body).toMatch(/call your carrier to lock your SIM, then change it back/i);
    expect(notice.body, 'the new address is masked, never copied').not.toContain(next);
    expect(await hasStepUp(owner), 'the code authorises ONE change').toBe(false);
  });

  it('sending the same email again (the app does on every name edit) needs no code and tells nobody', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const before = emailsTo(owner.email).length;
    const res = await changeEmail(owner, owner.email!, { firstName: 'Renamed' });
    expect(res.statusCode, res.body).toBe(200);
    const after = await account(owner.userId);
    expect(after['firstName']).toBe('Renamed');
    expect(after['emailChangedAt'] ?? null).toBeNull();
    expect(emailsTo(owner.email).length).toBe(before);
  });

  it('a customer changes their email as before (no code, no notice), and the change is still dated', async () => {
    const tenantId = await makeTenant();
    const customer = await makeAdmin(tenantId, { role: 'CUSTOMER' });
    const before = emailsTo(customer.email).length;
    const res = await changeEmail(customer, `cust-${RUN}-c@example.test`);
    expect(res.statusCode, res.body).toBe(200);
    const after = await account(customer.userId);
    expect(after.email).toBe(`cust-${RUN}-c@example.test`);
    expect(after['emailChangedAt']).toBeTruthy();
    expect(emailsTo(customer.email).length).toBe(before);
  });

  it('if the old address cannot be told, an admin email does not change', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    await stepUp(owner);
    const res = await withEmailDown(() => changeEmail(owner, `new-${RUN}-d@example.test`));
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error.code).toBe('EMAIL_CHANGE_NOTICE_UNAVAILABLE');
    const after = await account(owner.userId);
    expect(after.email).toBe(owner.email);
    expect(after['emailChangedAt'] ?? null).toBeNull();
  });

  it('the stolen-session attack: right after an email change solo is refused, for seven days', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    await stepUp(owner);
    const moved = await changeEmail(owner, `moved-${RUN}-e@example.test`);
    expect(moved.statusCode, moved.body).toBe(200);
    const id = await ask(owner);
    const refused = await startSolo(owner, id);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('SOLO_EMAIL_RECENT');
    expect((await row(id))['soloRequestedAt'] ?? null).toBeNull();
    // the Approvals screen says why, and never offers the button
    const list = await call(owner, 'GET', '/api/v1/admin/approvals');
    const mine = (list.json().data as Array<{ id: string; solo: { state: string; why?: string } | null }>).find((r) => r.id === id)!;
    expect(mine.solo).toMatchObject({ state: 'unavailable', why: 'email-recent' });

    await emailChangedDaysAgo(owner.userId, 6.9);
    expect((await startSolo(owner, id)).statusCode, 'still inside the seven days').toBe(409);
    await emailChangedDaysAgo(owner.userId, 7.01);
    const started = await startSolo(owner, id);
    expect(started.statusCode, started.body).toBe(200);
  });

  it('an email change DURING the wait refuses the decision, before any code is spent', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const id = await ask(owner);
    expect((await startSolo(owner, id)).statusCode).toBe(200);
    await elapse(id);
    await stepUp(owner);
    expect((await changeEmail(owner, `wait-${RUN}-f@example.test`)).statusCode).toBe(200);
    await stepUp(owner);
    const res = await decide(owner, id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('SOLO_EMAIL_RECENT');
    expect((await row(id)).status).toBe('PENDING');
    expect(await hasStepUp(owner), 'a cheap refusal never spends the code').toBe(true);
  });
});

describe('[Opus S2] every solo notice also goes by text to the phone on the account', () => {
  it('the start and the decision each text the owner, as well as emailing', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const id = await ask(owner);
    const atStart = textsTo(owner.phone).length;
    expect((await startSolo(owner, id)).statusCode).toBe(200);
    expect(textsTo(owner.phone).length).toBe(atStart + 1);
    expect(textsTo(owner.phone).at(-1)!.body).toMatch(/cancel/i);
    await elapse(id);
    await stepUp(owner);
    const atDecision = textsTo(owner.phone).length;
    expect((await decide(owner, id)).statusCode).toBe(200);
    expect(textsTo(owner.phone).length).toBe(atDecision + 1);
    expect(textsTo(owner.phone).at(-1)!.body).toMatch(/approved/i);
  });

  it('a text that cannot be sent refuses the step: at the start and at the decision', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAdmin(tenantId);
    const id = await ask(owner);
    const down = await withTextsDown(() => startSolo(owner, id));
    expect(down.statusCode, down.body).toBe(503);
    expect(down.json().error.code).toBe('SOLO_SMS_UNAVAILABLE');
    expect((await row(id))['soloRequestedAt'] ?? null, 'nothing started').toBeNull();

    expect((await startSolo(owner, id)).statusCode).toBe(200);
    await elapse(id);
    await stepUp(owner);
    const atDecision = await withTextsDown(() => decide(owner, id));
    expect(atDecision.statusCode, atDecision.body).toBe(503);
    expect(atDecision.json().error.code).toBe('SOLO_SMS_UNAVAILABLE');
    expect((await row(id)).status, 'nothing decided').toBe('PENDING');
  });
});

describe('[Opus S3] the solo rollback guard cannot be blinded by row-level security', () => {
  it('switches row security off for its transaction before it looks for solo requests', () => {
    const sql = readFileSync(path.join(__dirname, '../../prisma/migrations/20261014110000_approval_solo_mode/rollback.sql'), 'utf8');
    const begin = sql.indexOf('BEGIN;');
    const off = sql.indexOf('SET LOCAL row_security = off;');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(off, 'privileged_approvals forces row security: a non-bypass role must get an error, never an empty table').toBeGreaterThan(begin);
    expect(off).toBeLessThan(sql.indexOf('IF EXISTS'));
  });
});
