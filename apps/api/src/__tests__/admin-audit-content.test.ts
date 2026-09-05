import { Prisma } from '@prisma/client';
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
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { ADMIN_ACTION_CLASSES, ADMIN_ROUTES_WITHOUT_ENTITY, ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { declaredFields, diffOf, digestOf } from '../modules/admin/audit-change';
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// [ADM-004] THE AUDIT ROW RECORDED THE REQUEST, NOT THE CHANGE.
//
// `changes` was `{ params, body }`, with the body truncated at 2,000
// characters. Three things followed:
//
//   * An investigator could see that a route was CALLED and not what it DID.
//   * The truncation lost the tail of any large payload — the part most likely
//     to matter was the part most likely to be cut.
//   * A raw body carried document numbers, phone numbers and addresses into a
//     table with no privacy shaping. The privacy control was creating a
//     privacy problem, and one that outlives the data it copied.
//
// The row now carries the subject's digest before and after and a diff of the
// declared fields. No payload is stored at all.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
let token = '';
const REASON = 'Bank confirmed the transfer cleared, reference GY-88213';

const call = (method: string, url: string, payload?: unknown) =>
  injectWithApproval(app, {
    method: method as never, url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const lastAudit = async (action: string) => {
  for (let i = 0; i < 25; i += 1) {
    const row = await app.prisma.auditLog.findFirst({
      where: { userId: userIds[0]!, action: { contains: action } },
      orderBy: { createdAt: 'desc' },
    });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

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
  const phone = `+59271${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Content', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN',
      status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
    },
  });
  userIds.push(user.id);
  token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'admin-audit-content', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
});
afterAll(async () => {
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.platformConfig.deleteMany({ where: { key: { startsWith: 'ADM004_' } } }).catch(() => {});
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'test-cleanup:admin-audit-content').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-audit-content').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:admin-audit-content');
  await app.close();
});

describe('[ADM-004] the row says what changed', () => {
  it('a config write records the before and after digest and names the field that moved', async () => {
    const key = `ADM004_${RUN}`;
    await runWithoutTenant(() => app.prisma.platformConfig.create({ data: { key, value: { rate: 1 } } }), 'test-seed');
    const res = await call('PUT', `/api/v1/admin/config/${key}`, { value: { rate: 2 }, reason: REASON });
    expect(res.statusCode, res.body).toBe(200);

    const row = await lastAudit('/config/:key');
    expect(row, 'an audit row for the write').toBeTruthy();
    const changes = row!.changes as Record<string, unknown>;
    expect(changes['before'], 'the before digest').toBeTruthy();
    expect(changes['after'], 'the after digest').toBeTruthy();
    expect(changes['before']).not.toBe(changes['after']); // something moved
    expect(changes['changed']).toMatchObject({ value: { from: { rate: 1 }, to: { rate: 2 } } });
    expect(changes['reason']).toBe(REASON);
  });

  it('the raw request body is NOT in the row — the payload was the privacy problem', async () => {
    const key = `ADM004_${RUN}_pii`;
    await runWithoutTenant(() => app.prisma.platformConfig.create({ data: { key, value: { note: 'before' } } }), 'test-seed');
    // a body carrying exactly the shapes a document number, a phone and an
    // address take when an operator pastes them into a form
    const documentNumber = `GY-${RUN.toUpperCase()}-0099887`;
    const res = await call('PUT', `/api/v1/admin/config/${key}`, {
      value: { note: 'after' },
      passportNumber: documentNumber,
      payerPhone: '+5926001234',
      addressLine1: '12 Lamaha Street, Georgetown',
      reason: REASON,
    });
    expect(res.statusCode, res.body).not.toBe(500);

    const row = await lastAudit('/config/:key');
    const serialised = JSON.stringify(row!.changes);
    expect(serialised).not.toContain(documentNumber);
    expect(serialised).not.toContain('+5926001234');
    expect(serialised).not.toContain('Lamaha Street');
    expect(serialised).not.toContain('body');
  });

  it('an action on a route with no single subject row SAYS so, rather than leaving an empty digest pair', async () => {
    // a broadcast addresses an audience, not a row — the record says which,
    // instead of an empty digest pair that reads as a failure to record
    const res = await call('POST', '/api/v1/admin/notifications/broadcast', {
      title: 'Service notice', body: 'Deliveries resume at 6am.', category: 'service', reason: REASON,
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await lastAudit('/notifications/broadcast');
    expect(row, 'an audit row for the broadcast').toBeTruthy();
    const changes = row!.changes as Record<string, unknown>;
    expect(changes['subject']).toBe('no-single-row');
    expect(changes).not.toHaveProperty('before');
    expect(changes['reason']).toBe(REASON);
  });
});

describe('[ADM-004] the digest and the diff', () => {
  it('the digest covers the WHOLE row, so a change outside the declared fields still shows', () => {
    const base = { id: 'x', status: 'ACTIVE', internalNote: 'one', updatedAt: new Date('2026-01-01') };
    const moved = { ...base, internalNote: 'two' };
    expect(digestOf(base)).not.toBe(digestOf(moved));
    // and the declared diff, which names only what a reader cares about, is empty
    const fields = ['status'];
    expect(diffOf(
      { digest: digestOf(base), fields: declaredFields(base, fields), exists: true },
      { digest: digestOf(moved), fields: declaredFields(moved, fields), exists: true },
    )).toEqual({});
  });

  it('an equal row digests equal however it was written, and a moved value never collides', () => {
    const a = { id: 'x', status: 'ACTIVE', amount: 100 };
    const b = { status: 'ACTIVE', id: 'x', amount: 100 };
    expect(digestOf(a)).toBe(digestOf(b));
    expect(digestOf(a)).not.toBe(digestOf({ ...a, amount: 101 }));
    // dates and Decimals reduce to a stable string rather than an object
    const d = new Date('2026-03-01T00:00:00.000Z');
    expect(digestOf({ at: d })).toBe(digestOf({ at: new Date(d.getTime()) }));
  });

  it('the diff names both sides of every field that moved, and nothing that did not', () => {
    const before = { status: 'PENDING', amount: 100, note: 'x' };
    const after = { status: 'PAID', amount: 100, note: 'y' };
    const fields = ['status', 'amount'];
    const changed = diffOf(
      { digest: 'a', fields: declaredFields(before, fields), exists: true },
      { digest: 'b', fields: declaredFields(after, fields), exists: true },
    );
    expect(changed).toEqual({ status: { from: 'PENDING', to: 'PAID' } });
  });

  it('a row that did not exist before, or does not after, is a real answer', () => {
    const changed = diffOf(
      { digest: '', fields: {}, exists: false },
      { digest: 'b', fields: { status: 'ACTIVE' }, exists: true },
    );
    expect(changed).toEqual({ status: { from: null, to: 'ACTIVE' } });
  });
});

describe('[ADM-004] the census: every consequential action is accounted for', () => {
  it('a C3-C5 mutation either declares its subject row or is named as having none, with a reason', () => {
    const mutations = Object.entries(ADMIN_ROUTE_AUTHORITY)
      .filter(([key, a]) => !key.startsWith('GET ') && ADMIN_ACTION_CLASSES[a.cls].requiresReason);
    expect(mutations.length).toBeGreaterThan(60);
    const unaccounted = mutations
      .filter(([key, a]) => !a.entity && !(key in ADMIN_ROUTES_WITHOUT_ENTITY))
      .map(([key]) => key);
    expect(unaccounted, 'routes whose audit row would say nothing about the change').toEqual([]);
    const orphaned = Object.keys(ADMIN_ROUTES_WITHOUT_ENTITY)
      .filter((key) => !ADMIN_ROUTE_AUTHORITY[key] || ADMIN_ROUTE_AUTHORITY[key]!.entity);
    expect(orphaned, 'exemptions for routes that do not exist or now declare a row').toEqual([]);
  });

  it('every exemption states a reason a reviewer can check, not a placeholder', () => {
    for (const [key, why] of Object.entries(ADMIN_ROUTES_WITHOUT_ENTITY)) {
      expect(why.length, key).toBeGreaterThan(20);
      expect(why, key).not.toMatch(/^(todo|n\/a|none|later)/i);
    }
  });

  it('every declared model exists on the Prisma client — a typo would silently record nothing', () => {
    const models = new Set(Object.values(ADMIN_ROUTE_AUTHORITY).filter((a) => a.entity).map((a) => a.entity!.model));
    expect(models.size).toBeGreaterThan(15);
    for (const model of models) {
      const delegate = (app.prisma as unknown as Record<string, unknown>)[model];
      expect(delegate, `prisma.${model}`).toBeTruthy();
      expect(typeof (delegate as { findUnique?: unknown }).findUnique, `prisma.${model}.findUnique`).toBe('function');
    }
  });

  it('every declared field list names at least one field, and money routes name a REAL money column', () => {
    const lowerFirst = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
    const types = new Map(Prisma.dmmf.datamodel.models.map((m) => [lowerFirst(m.name), new Map(m.fields.map((f) => [f.name, f.type]))]));
    for (const [key, a] of Object.entries(ADMIN_ROUTE_AUTHORITY)) {
      if (!a.entity) continue;
      expect(a.entity.fields.length, key).toBeGreaterThan(0);
    }
    // The settlement, claim and invoice rails all record what moved, not just
    // that it moved — and "what moved" must be a column the model actually
    // has. This rule used to be a name test (/amount/i), and it was satisfied
    // for months by `settlement.amount`, a field Settlement never had; the
    // diff it certified was empty. [ADM-002] It now asks the schema.
    for (const key of ['PUT /finance/settlements/:id/process', 'PUT /cash-rules/claims/:id/paid', 'PUT /ads/invoices/:id/mark-paid']) {
      const e = ADMIN_ROUTE_AUTHORITY[key]!.entity!;
      expect(e.fields, key).toContain('status');
      const money = e.fields.filter((f) => types.get(e.model)?.get(f) === 'Decimal');
      expect(money.length, `${key}: ${e.model} must declare a Decimal money column`).toBeGreaterThan(0);
    }
  });
});
