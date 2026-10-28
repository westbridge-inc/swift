import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PrismaClient } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { runWithoutTenant } from '../plugins/tenant-context';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { digestOf, snapshot, SNAPSHOT_SECRET_FIELDS } from '../modules/admin/audit-change';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [SEC-PII · security scan 28 Oct 2026] AN AUDIT DIGEST MUST NOT BE A WAY TO
// READ A SECRET BACK.
//
// The audit trail records the subject row's digest before and after an admin
// action. It was a plain SHA-256 over the WHOLE row, secrets included (a
// custody case's 6-digit transfer code, an order's pickup code and ride PIN),
// and every other column of the row is readable elsewhere in the console. With
// only a 6-digit unknown left, anyone who could read the trail could recompute
// the digest for every candidate and recover the live code offline.
//
// Now: one registry of secret columns (SNAPSHOT_SECRET_FIELDS) is removed from
// the row before it is digested (and from the declared diff), and the digest
// is keyed (HMAC) with a key derived from a server secret no admin can read, so
// no column, secret or not, can be guessed back from it. Rows already written
// are never rewritten (the trail is append-only).
// ---------------------------------------------------------------------------

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'audit-snapshot-secrets-test');
const canonicalSha = (row: unknown) => digestOf(row);
const fake = (model: string, row: Record<string, unknown>) => ({ [model]: { findUnique: async () => row } }) as unknown as PrismaClient;
const without = (row: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

describe('[SEC-PII] the secret-field registry', () => {
  it('names every secret the scan found, and each one is a real column', () => {
    for (const field of ['transferCode', 'pickupCode', 'ridePin', 'pickupCodeAttempts', 'mmgNumberSnapshot', 'mmgPayUrlSnapshot', 'passwordHash', 'paymentToken']) {
      expect(SNAPSHOT_SECRET_FIELDS, field).toContain(field);
    }
    const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    for (const field of SNAPSHOT_SECRET_FIELDS) expect(new RegExp(`^\\s+${field}\\s`, 'm').test(schema), `${field} is a column`).toBe(true);
  });

  it('no audited entity names a secret among the fields its diff shows', () => {
    for (const [route, authority] of Object.entries(ADMIN_ROUTE_AUTHORITY)) {
      for (const field of authority.entity?.fields ?? []) expect(SNAPSHOT_SECRET_FIELDS, `${route} declares ${field}`).not.toContain(field);
    }
  });
});

describe('[SEC-PII] a snapshot digest does not move with a secret, and cannot be recomputed from the row', () => {
  const kase = { id: `case-${RUN}`, state: 'TRANSFER_IN_PROGRESS', holderRiderId: 'r1', relayRiderId: 'r2', transferCode: '482913', transferCodeExpiresAt: new Date('2026-10-28T10:00:00Z'), escalationCount: 0 };
  const entity = { model: 'custodyRecoveryCase', fields: ['state', 'transferCode'] };

  it('two rows that differ only in the transfer code digest the same; the code never reaches the diff', async () => {
    const a = await snapshot(fake('custodyRecoveryCase', kase), entity, kase.id);
    const b = await snapshot(fake('custodyRecoveryCase', { ...kase, transferCode: '000001' }), entity, kase.id);
    expect(a.exists).toBe(true);
    expect(a.digest).toBe(b.digest);
    expect(a.fields).toEqual({ state: 'TRANSFER_IN_PROGRESS' });
    expect(JSON.stringify(a)).not.toContain('482913');
  });

  it('the digest is keyed: neither the whole row nor the row without its secrets hashes to it', async () => {
    const a = await snapshot(fake('custodyRecoveryCase', kase), entity, kase.id);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.digest).not.toBe(canonicalSha(kase));
    expect(a.digest).not.toBe(canonicalSha(without(kase, SNAPSHOT_SECRET_FIELDS)));
    // ... and every other column still moves it, so a change outside the declared fields still shows.
    const moved = await snapshot(fake('custodyRecoveryCase', { ...kase, escalationCount: 1 }), entity, kase.id);
    expect(moved.digest).not.toBe(a.digest);
  });

  it('an order: pickup code, ride PIN, attempt counts and the MMG snapshots do not move the digest', async () => {
    const order = { id: `o-${RUN}`, status: 'READY', pickupCode: '1234', ridePin: '5678', pickupCodeAttempts: 1, ridePinAttempts: 2, mmgNumberSnapshot: '+5926000001', mmgPayUrlSnapshot: 'https://pay.example/x' };
    const orderEntity = { model: 'order', fields: ['status'] };
    const a = await snapshot(fake('order', order), orderEntity, order.id);
    const b = await snapshot(fake('order', { ...order, pickupCode: '9999', ridePin: '0000', pickupCodeAttempts: 4, ridePinAttempts: 0, mmgNumberSnapshot: null, mmgPayUrlSnapshot: null }), orderEntity, order.id);
    expect(a.digest).toBe(b.digest);
  });
});

// The scan's path, end to end: an admin claims a custody case whose relay hand-off code is live; the audit
// row's digests must not be reproducible from the row an admin can read, for any candidate code.
describe('[SEC-PII] the live custody code cannot be recovered from the audit trail', () => {
  let app: FastifyInstance;
  let adminId = '';
  let token = '';
  const userIds: string[] = [];
  const ids = { vendorOwner: '', vendor: '', rider: '', relay: '', order: '', kase: '' };

  const person = async (roles: string[], extra: Record<string, unknown> = {}) => {
    const user = await system(() => app.prisma.user.create({ data: {
      phone: testPhone(), firstName: 'Audit', lastName: `S${RUN}`, roles: roles as never, activeRole: roles[0] as never, status: 'ACTIVE', isPhoneVerified: true, ...extra,
    } as never }));
    userIds.push(user.id);
    return user;
  };

  beforeAll(async () => {
    app = Fastify({ logger: false });
    registerErrorHandler(app); registerEmptyJsonBodyParser(app);
    await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
    await app.register(adminRoutes, { prefix: '/api/v1/admin' });
    await app.ready();
    const admin = await person(['ADMIN', 'CUSTOMER'], { admin: { create: { permissions: ['*'] } } });
    adminId = admin.id;
    token = app.jwt.sign({ userId: admin.id, role: 'ADMIN', jti: nanoid(8) });
    await system(() => app.prisma.session.create({ data: {
      userId: admin.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `as-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    } }));
    const customer = await person(['CUSTOMER']);
    const owner = await person(['VENDOR_OWNER', 'CUSTOMER']);
    ids.vendorOwner = (await system(() => app.prisma.vendorOwner.create({ data: { userId: owner.id } }))).id;
    ids.vendor = (await system(() => app.prisma.vendor.create({ data: {
      ownerId: ids.vendorOwner, name: 'Audit Counter', slug: `as-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
      addressLine1: '1 Audit St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.801, longitude: -58.156, status: 'ACTIVE', isVerified: true,
    } as never }))).id;
    const riderUser = await person(['RIDER']);
    const relayUser = await person(['RIDER']);
    ids.rider = (await system(() => app.prisma.rider.create({ data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } as never }))).id;
    ids.relay = (await system(() => app.prisma.rider.create({ data: { userId: relayUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } as never }))).id;
    ids.order = (await system(() => app.prisma.order.create({ data: {
      orderNumber: `AS-${RUN}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', status: 'PICKED_UP', customerId: customer.id, vendorId: ids.vendor, riderId: ids.rider,
      deliveryAddress: '1 Gate St', deliveryLat: 6.801, deliveryLng: -58.156,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
    } as never }))).id;
    ids.kase = (await system(() => app.prisma.custodyRecoveryCase.create({ data: {
      orderId: ids.order, reason: 'VEHICLE_BREAKDOWN', holderRiderId: ids.rider, relayRiderId: ids.relay, state: 'TRANSFER_IN_PROGRESS',
      transferCode: '731946', transferCodeExpiresAt: new Date(Date.now() + 600_000), deadlineAt: new Date(Date.now() + 600_000),
    } as never }))).id;
  });

  afterAll(async () => {
    await system(async () => {
      await purgeAuditLogs(app.prisma, { OR: [{ entityId: ids.kase }, { userId: { in: userIds } }] }, 'test-cleanup:audit-snapshot-secrets');
      await app.prisma.custodyRecoveryCase.deleteMany({ where: { id: ids.kase } });
      await app.prisma.order.deleteMany({ where: { id: ids.order } });
      await app.prisma.rider.deleteMany({ where: { id: { in: [ids.rider, ids.relay] } } });
      await app.prisma.vendor.deleteMany({ where: { id: ids.vendor } });
      await app.prisma.vendorOwner.deleteMany({ where: { id: ids.vendorOwner } });
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    });
    await app.close();
  });

  it('claiming the case writes a before digest that no candidate code reproduces', async () => {
    const before = await system(() => app.prisma.custodyRecoveryCase.findUnique({ where: { id: ids.kase } }));
    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/custody-cases/${ids.kase}/claim`, payload: {},
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const rows = await system(() => app.prisma.auditLog.findMany({ where: { entityId: ids.kase, userId: adminId } }));
    const changes = rows.map((r) => r.changes as Record<string, unknown>).find((c) => typeof c['before'] === 'string')!;
    expect(changes, JSON.stringify(rows.map((r) => r.action))).toBeTruthy();
    const digest = changes['before'] as string;
    // The scan's recipe: the row as read, with each candidate code in place. The real code first.
    for (const code of ['731946', '000000', '999999']) {
      expect(canonicalSha({ ...before, transferCode: code })).not.toBe(digest);
    }
    expect(canonicalSha(without(before as unknown as Record<string, unknown>, SNAPSHOT_SECRET_FIELDS))).not.toBe(digest);
    expect(createHash('sha256').update(JSON.stringify(before)).digest('hex')).not.toBe(digest);
    expect(JSON.stringify(rows)).not.toContain('731946');
  });
});
