import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { STORE_PIN_OUT_OF_MARKET } from '../modules/vendor/store-pin';
import { VENDOR_PIN_MOVED } from '../modules/vendor/store-pin-move';
import { purgeAuditLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// [Q8] Owner report: a store must not simply take the spot its owner signed up
// from. The app now has the owner place and confirm the pin on a map; this is
// the server half. The pin is where riders and customers are sent and what
// decides which shoppers see the store as nearby, so both writers of store
// coordinates refuse a pin outside every launch market with a named 400, and
// write nothing when they do:
//
//   POST /partner/become  (a new store)
//   PUT  /vendor/profile  (a store moving its pin)
//
// [DS269 F1] And a moved pin leaves a trace: an audit row with who moved it,
// from where and to where, in the transaction that moves it, and a notice to
// the owner whenever the mover is someone else.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
// Unique phone prefix per file (parallel-test gotcha): +592007183xx.
const PHONE_PREFIX = '+592007183';

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole, name = { first: 'Pin', last: 'Owner' }) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
      firstName: name.first,
      lastName: `${name.last}${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      avatar: '/uploads/avatars/pin.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      authMethod: 'OTP',
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'store-pin-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

const GEORGETOWN = { latitude: 6.8013, longitude: -58.1551 };
const ENTRANCE = { latitude: 6.8102, longitude: -58.1623 };

function business(pin: { latitude: number; longitude: number }) {
  return {
    name: 'Pin Test Roti Shop',
    vendorType: 'RESTAURANT',
    phone: '+5926001834',
    addressLine1: '12 Regent Street',
    city: 'Georgetown',
    ...pin,
  };
}

function become(token: string, pin: { latitude: number; longitude: number }) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/partner/become',
    payload: { acceptAgreement: true, role: 'VENDOR', business: business(pin) },
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}

function putProfile(token: string, vendorId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PUT',
    url: '/api/v1/vendor/profile',
    payload,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-vendor-id': vendorId },
  });
}

/** A store created through the real route at the Georgetown centre, by its owner. */
async function storeAtGeorgetown() {
  const owner = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const created = await become(owner.token, GEORGETOWN);
  expect(created.statusCode).toBe(201);
  const vendor = await app.prisma.vendor.findFirstOrThrow({ where: { owner: { userId: owner.userId } } });
  createdVendorIds.push(vendor.id);
  return { token: owner.token, ownerUserId: owner.userId, vendorId: vendor.id };
}

async function pinOf(vendorId: string) {
  const v = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { latitude: true, longitude: true } });
  return { latitude: v.latitude, longitude: v.longitude };
}

/** The store's pin-move audit rows, oldest first. */
function pinAudits(vendorId: string) {
  return app.prisma.auditLog.findMany({ where: { entityId: vendorId, action: VENDOR_PIN_MOVED }, orderBy: { createdAt: 'asc' } });
}

/** The pin-move notices in one account's inbox. */
async function pinNotices(userId: string) {
  const rows = await app.prisma.notification.findMany({ where: { userId } });
  return rows.filter((n) => (n.data as { kind?: unknown } | null)?.kind === 'store_pin_moved');
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
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  // A rerun after an interrupted run starts from nothing.
  await app.prisma.user.deleteMany({ where: { phone: { startsWith: PHONE_PREFIX } } });
});

afterAll(async () => {
  // audit_logs is append-only: this file's rows go through the one named purge.
  if (createdVendorIds.length > 0) {
    await purgeAuditLogs(app.prisma, { entityId: { in: createdVendorIds }, action: VENDOR_PIN_MOVED }, 'test-cleanup:store-pin-market');
  }
  // Deleting the account cascades its owner row, its store, its staff rows, its inbox and its sessions.
  if (createdUserIds.length > 0) await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('a new store is created only at a pin inside the market', () => {
  it.each([
    ['a phone that signed up abroad (New York)', { latitude: 40.7128, longitude: -74.006 }],
    ['a 0,0 fix', { latitude: 0, longitude: 0 }],
    ['Port of Spain', { latitude: 10.6596, longitude: -61.5089 }],
    ['Paramaribo', { latitude: 5.852, longitude: -55.2038 }],
  ])('%s is refused with a named 400, and nothing is created', async (_where, pin) => {
    const newcomer = await makeUser(['CUSTOMER'], 'CUSTOMER');

    const res = await become(newcomer.token, pin);

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(STORE_PIN_OUT_OF_MARKET);
    expect(res.json().error.message).toMatch(/outside Guyana/);
    expect(await app.prisma.vendorOwner.count({ where: { userId: newcomer.userId } })).toBe(0);
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: newcomer.userId }, select: { roles: true, activeRole: true } });
    expect(user.roles).not.toContain('VENDOR_OWNER');
    expect(user.activeRole).toBe('CUSTOMER');
  });

  it('control: a store in a border town (Lethem, on the Takutu) is created at exactly its pin', async () => {
    const newcomer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const lethem = { latitude: 3.3803, longitude: -59.7968 };

    const res = await become(newcomer.token, lethem);

    expect(res.statusCode).toBe(201);
    const vendor = await app.prisma.vendor.findFirstOrThrow({ where: { owner: { userId: newcomer.userId } } });
    expect({ latitude: vendor.latitude, longitude: vendor.longitude }).toEqual(lethem);
  });
});

describe('a store moves its pin only to a spot inside the market', () => {
  it('a pin moved out of the market is refused with the same named 400, and the store stays put', async () => {
    const store = await storeAtGeorgetown();

    const res = await putProfile(store.token, store.vendorId, { latitude: 40.7128, longitude: -74.006 });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(STORE_PIN_OUT_OF_MARKET);
    expect(await pinOf(store.vendorId)).toEqual(GEORGETOWN);
    // Nothing moved, so nothing is on the record.
    expect(await pinAudits(store.vendorId)).toHaveLength(0);
  });

  it('half a pin is refused: latitude and longitude travel together', async () => {
    const store = await storeAtGeorgetown();

    const onlyLatitude = await putProfile(store.token, store.vendorId, { latitude: 6.9 });
    const onlyLongitude = await putProfile(store.token, store.vendorId, { longitude: -58.2 });

    expect(onlyLatitude.statusCode).toBe(400);
    expect(onlyLatitude.json().error.code).toBe('VALIDATION_ERROR');
    expect(onlyLongitude.statusCode).toBe(400);
    expect(onlyLongitude.json().error.code).toBe('VALIDATION_ERROR');
    expect(await pinOf(store.vendorId)).toEqual(GEORGETOWN);
  });

  it('control: a pin moved within the market is saved, and the profile read returns it', async () => {
    const store = await storeAtGeorgetown();

    const res = await putProfile(store.token, store.vendorId, ENTRANCE);

    expect(res.statusCode).toBe(200);
    expect(await pinOf(store.vendorId)).toEqual(ENTRANCE);
  });

  it('control: an edit that does not touch the pin is untouched by the pin rule', async () => {
    const store = await storeAtGeorgetown();

    const res = await putProfile(store.token, store.vendorId, { description: 'Roti, curry and dhal puri.' });

    expect(res.statusCode).toBe(200);
    expect(await pinOf(store.vendorId)).toEqual(GEORGETOWN);
  });
});

describe('[DS269 F1] a moved pin is on the record, and the owner hears of a move they did not make', () => {
  /** A MANAGER on the store: a plain account with a staff row, as the owner adds one. */
  async function managerOf(store: { vendorId: string; ownerUserId: string }) {
    const manager = await makeUser(['CUSTOMER'], 'CUSTOMER', { first: 'Marla', last: 'Manager' });
    await app.prisma.vendorStaff.create({ data: { vendorId: store.vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: store.ownerUserId } });
    const named = await app.prisma.user.findUniqueOrThrow({ where: { id: manager.userId }, select: { firstName: true, lastName: true } });
    return { ...manager, name: `${named.firstName} ${named.lastName}` };
  }

  it('the owner moving the pin writes one audit row — who, from, to — and no notice to themselves', async () => {
    const store = await storeAtGeorgetown();

    const res = await putProfile(store.token, store.vendorId, ENTRANCE);

    expect(res.statusCode).toBe(200);
    const rows = await pinAudits(store.vendorId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: store.ownerUserId, entity: 'Vendor', entityId: store.vendorId });
    // Positions in the one evidence format for a position (cash-rules gpsEvidence, 5 dp).
    expect(rows[0]!.changes).toEqual({ from: 'gps:6.80130,-58.15510', to: 'gps:6.81020,-58.16230', actorRole: 'OWNER', ownerNotified: false });
    expect(await pinNotices(store.ownerUserId)).toHaveLength(0);
  });

  it('an unchanged pin, or an edit that sends no pin, writes no audit row', async () => {
    const store = await storeAtGeorgetown();

    expect((await putProfile(store.token, store.vendorId, GEORGETOWN)).statusCode).toBe(200);
    expect((await putProfile(store.token, store.vendorId, { description: 'Roti, curry and dhal puri.' })).statusCode).toBe(200);

    expect(await pinAudits(store.vendorId)).toHaveLength(0);
  });

  it('a manager moving the pin is recorded as the manager, and the owner is told who moved it', async () => {
    const store = await storeAtGeorgetown();
    const manager = await managerOf(store);

    const res = await putProfile(manager.token, store.vendorId, ENTRANCE);

    expect(res.statusCode).toBe(200);
    expect(await pinOf(store.vendorId)).toEqual(ENTRANCE);
    const rows = await pinAudits(store.vendorId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: manager.userId, entityId: store.vendorId });
    expect(rows[0]!.changes).toEqual({ from: 'gps:6.80130,-58.15510', to: 'gps:6.81020,-58.16230', actorRole: 'MANAGER', ownerNotified: true });

    const notices = await pinNotices(store.ownerUserId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: 'SYSTEM_ANNOUNCEMENT', title: 'Your store pin was moved' });
    expect(notices[0]!.body).toContain(`${manager.name} moved the map pin for Pin Test Roti Shop.`);
    expect(notices[0]!.data).toEqual({ kind: 'store_pin_moved', vendorId: store.vendorId, audience: 'business' });
    // The mover is not told about their own move.
    expect(await pinNotices(manager.userId)).toHaveLength(0);
  });

  it('control: the owner moving it after a manager records a second move, and tells nobody', async () => {
    const store = await storeAtGeorgetown();
    const manager = await managerOf(store);
    await putProfile(manager.token, store.vendorId, ENTRANCE);

    const back = await putProfile(store.token, store.vendorId, GEORGETOWN);

    expect(back.statusCode).toBe(200);
    const rows = await pinAudits(store.vendorId);
    expect(rows.map((r) => [r.userId, (r.changes as { from: string }).from, (r.changes as { to: string }).to])).toEqual([
      [manager.userId, 'gps:6.80130,-58.15510', 'gps:6.81020,-58.16230'],
      [store.ownerUserId, 'gps:6.81020,-58.16230', 'gps:6.80130,-58.15510'],
    ]);
    // Only the manager's move reached the owner's inbox.
    expect(await pinNotices(store.ownerUserId)).toHaveLength(1);
  });

  it('the record and the notice are written by the transaction that moves the pin', () => {
    // A success cannot show atomicity, so the shape is pinned: lock, read,
    // move and record share one transaction, and only the fan-out (which cannot
    // undo anything) runs after it commits.
    const source = readFileSync(join(__dirname, '..', 'modules', 'vendor', 'vendor.routes.ts'), 'utf8');
    const start = source.indexOf("app.put('/profile'");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, start + source.slice(start).search(/\n {2}app\.(get|post|put|patch|delete)\(/));
    const txStart = block.indexOf('app.prisma.$transaction(async (tx) => {');
    expect(txStart, 'the profile write runs in a transaction').toBeGreaterThan(-1);
    const txEnd = block.indexOf('\n    });', txStart);
    const inTx = block.slice(txStart, txEnd);
    const afterTx = block.slice(txEnd);

    expect(inTx).toContain('lockStorePin(tx, vendorId)');
    expect(inTx.indexOf('lockStorePin(tx, vendorId)')).toBeLessThan(inTx.indexOf('tx.vendor.update('));
    expect(inTx.indexOf('tx.vendor.update(')).toBeLessThan(inTx.indexOf('recordStorePinMove(tx, {'));
    expect(afterTx).not.toContain('recordStorePinMove(');
    expect(afterTx).toContain('notifications.publishPersisted(pinNoticeId)');
  });

  it('a refused pin writes no record and tells nobody, whoever sends it', async () => {
    const store = await storeAtGeorgetown();
    const manager = await managerOf(store);

    const res = await putProfile(manager.token, store.vendorId, { latitude: 0, longitude: 0 });

    expect(res.statusCode).toBe(400);
    expect(await pinAudits(store.vendorId)).toHaveLength(0);
    expect(await pinNotices(store.ownerUserId)).toHaveLength(0);
  });
});
