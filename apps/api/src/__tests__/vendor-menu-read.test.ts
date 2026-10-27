import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct] The phone's menu read (GET /vendor/categories) carries each item as the editor and the list need
// it: its bulk as the WORD (G2: the integer never crosses the wire) and why customers cannot see it (GUARDRAILS §8).
//
// Before, this read sent `bulkUnits` and no `bulk`, so the phone's item editor (opened from this list) showed every
// item as "Normal" and SAVED "normal" back: editing the price of a 20 kg bag of rice made it bicycle-sized for
// dispatch. And the menu list never showed "Waiting for a quick check". GET /vendor/items (the web) already did both.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
// Checked names (store, section, item) carry digits only (helpers/fixture-ids: random letters can spell a banned word).
const RUN = wordFreeTag(6);
let app: FastifyInstance;
let token: string;
const userIds: string[] = [];

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method, url,
    ...(payload ? { payload } : {}),
    headers: { ...(payload ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const user = await app.prisma.user.create({
    data: {
      phone: `+5926${String(Date.now()).slice(-6)}`, firstName: 'Menu', lastName: `Read${RUN}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'menu-read', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Menu Read Mart ${RUN}`, slug: `menu-read-mart-${RUN}`, vendorType: 'SUPERMARKET',
      phone: `+5927${String(Date.now()).slice(-6)}`, addressLine1: '1 Menu Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
});

afterAll(async () => {
  if (userIds.length) await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[TAP-AUDIT] the phone\'s menu read carries the bulk word and the catalogue check', () => {
  it('each item: bulk as the word the store chose (never the integer), and why customers cannot see it', async () => {
    const section = await inject('POST', '/api/v1/vendor/categories', { name: 'Staples' });
    expect(section.statusCode, section.body).toBe(200);
    const categoryId = section.json().data.id as string;
    const rice = await inject('POST', '/api/v1/vendor/items', { categoryId, name: `Rice 20 kg ${RUN}`, basePrice: 6000, bulk: 'very_bulky' });
    expect(rice.statusCode, rice.body).toBe(200);
    // An item a person took off the menu (the catalogue check is what is under test here, not the word check: no
    // banned word in any fixture name).
    const held = await inject('POST', '/api/v1/vendor/items', { categoryId, name: `Pepper sauce ${RUN}`, basePrice: 300 });
    expect(held.statusCode, held.body).toBe(200);
    await app.prisma.item.update({ where: { id: held.json().data.id }, data: { prohibitedAt: new Date(), prohibitedClass: 'COUNTERFEIT', prohibitedReason: 'Removed by a person in this test' } });

    const read = await inject('GET', '/api/v1/vendor/categories');
    expect(read.statusCode, read.body).toBe(200);
    const items = (read.json().data as Array<{ id: string; items: Array<Record<string, unknown>> }>).find((c) => c.id === categoryId)!.items;
    const riceRow = items.find((i) => i['id'] === rice.json().data.id)!;
    const heldRow = items.find((i) => i['id'] === held.json().data.id)!;
    expect(riceRow['bulk']).toBe('very_bulky');
    expect(riceRow).not.toHaveProperty('bulkUnits');
    expect(riceRow['catalogueCheck']).toBeNull();
    expect(heldRow['bulk']).toBe('normal');
    expect(heldRow['catalogueCheck']).toMatchObject({ status: 'NOT_ALLOWED', prohibitedClass: 'COUNTERFEIT', reason: 'Removed by a person in this test' });
  });

  it('what the phone editor saves back after an unrelated edit keeps the item very bulky', async () => {
    const section = await inject('POST', '/api/v1/vendor/categories', { name: 'Bulk' });
    const categoryId = section.json().data.id as string;
    const created = await inject('POST', '/api/v1/vendor/items', { categoryId, name: `Water case ${RUN}`, basePrice: 2000, bulk: 'very_bulky' });
    const id = created.json().data.id as string;
    // The editor opens with what the menu read says, and sends its bulk with every save.
    const opened = ((await inject('GET', '/api/v1/vendor/categories')).json().data as Array<{ id: string; items: Array<Record<string, unknown>> }>)
      .find((c) => c.id === categoryId)!.items.find((i) => i['id'] === id)!;
    const saved = await inject('PUT', `/api/v1/vendor/items/${id}`, { basePrice: 2100, bulk: (opened['bulk'] as string | undefined) ?? 'normal' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().data.bulk).toBe('very_bulky');
  });
});
