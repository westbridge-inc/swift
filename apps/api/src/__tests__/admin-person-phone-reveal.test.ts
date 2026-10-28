import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { testPhone } from './helpers/fixture-ids';
import { runWithoutTenant } from '../plugins/tenant-context';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { ADMIN_ROUTE_AUTHORITY, SUPPORT_OPERATOR_CAPABILITIES } from '../modules/admin/admin-authority';

// ---------------------------------------------------------------------------
// [FOLLOWUPS · COORD ruling 28 Oct 2026, owner delegated; follows O-1] The
// console's person pages show phone numbers MASKED, like the order desk; the
// full number of ONE party is an audited reveal through the order desk's own
// door (a stated reason, an audit row written BEFORE the number leaves):
//   users/:id            -> GET /users/:id/phone                  (user.contact.read)
//   vendors/:id          -> GET /vendors/:id/party-phone?party=owner|store (vendor.contact.read)
//   riders/:id           -> GET /riders/:id/phone                 (mover.contact.read)
//   drivers/:id          -> GET /drivers/:id/phone                (mover.contact.read)
//   custody-cases/:id    -> GET /custody-cases/:id/party-phone?party=holder|relay (custody.contact.read)
// A grant that reads a page without its contact capability sees the masked
// number and is refused the reveal before anything is recorded; another
// tenant's administrator reaches no number at all.
//
// Asserted on the SERIALIZED body: every party has a real, distinct number
// (testPhone(), the run-wide fictional +59206 block), so a full number
// anywhere in a response is a leak.
// ---------------------------------------------------------------------------

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const OTHER_TENANT = `fu-${RUN.toLowerCase()}`;
const REASON = 'Rider rang support: cannot reach the store about the order';
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'admin-person-phone-reveal-test');
const tail = (phone: string) => phone.slice(-4);

let app: FastifyInstance;
const userIds: string[] = [];
const phones = { person: testPhone(), owner: testPhone(), store: testPhone(), rider: testPhone(), relay: testPhone(), driver: testPhone(), customer: testPhone() };
const ids = { person: '', ownerUser: '', vendorOwner: '', vendor: '', riderUser: '', rider: '', relayUser: '', relay: '', driverUser: '', driver: '', order: '', loneOrder: '', kase: '', loneCase: '' };
const tokens: Record<string, string> = {};

async function person(phone: string, roles: string[], extra: Record<string, unknown> = {}) {
  const user = await system(() => app.prisma.user.create({ data: {
    phone, firstName: 'Contact', lastName: `P${RUN}`, roles: roles as never, activeRole: roles[0] as never, status: 'ACTIVE', isPhoneVerified: true, ...extra,
  } as never }));
  userIds.push(user.id);
  return user;
}

async function adminWith(name: string, permissions: readonly string[], tenantId?: string) {
  const user = await person(testPhone(), ['ADMIN', 'CUSTOMER'], { admin: { create: { permissions: [...permissions] } }, ...(tenantId ? { tenantId } : {}) });
  const token = app.jwt.sign({ userId: user.id, role: 'ADMIN', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `fu-${RUN}-${name}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } }));
  tokens[name] = token;
}

const get = (url: string, token: string, reason?: string) =>
  app.inject({ method: 'GET', url: `/api/v1/admin${url}`, headers: { authorization: `Bearer ${token}`, ...(reason === undefined ? {} : { 'x-swift-reason': reason }) } });
const revealRows = (entityIds: string[]) => system(() => app.prisma.auditLog.findMany({
  where: { entityId: { in: entityIds }, action: { startsWith: 'REVEAL_PARTY_PHONE' } }, orderBy: { createdAt: 'asc' },
}));
const allEntities = () => [ids.person, ids.vendor, ids.rider, ids.driver, ids.kase, ids.loneCase];

/** Every reveal door, the party it names, the number it must return, and the audit row it must leave. */
const doors = () => [
  { url: `/users/${ids.person}/phone`, phone: phones.person, entity: 'User', entityId: ids.person, party: 'person', who: { subjectUserId: ids.person } },
  { url: `/vendors/${ids.vendor}/party-phone?party=owner`, phone: phones.owner, entity: 'Vendor', entityId: ids.vendor, party: 'owner', who: { subjectUserId: ids.ownerUser } },
  { url: `/vendors/${ids.vendor}/party-phone?party=store`, phone: phones.store, entity: 'Vendor', entityId: ids.vendor, party: 'store', who: { vendorId: ids.vendor } },
  { url: `/riders/${ids.rider}/phone`, phone: phones.rider, entity: 'Rider', entityId: ids.rider, party: 'mover', who: { subjectUserId: ids.riderUser } },
  { url: `/drivers/${ids.driver}/phone`, phone: phones.driver, entity: 'Driver', entityId: ids.driver, party: 'mover', who: { subjectUserId: ids.driverUser } },
  { url: `/custody-cases/${ids.kase}/party-phone?party=holder`, phone: phones.rider, entity: 'CustodyRecoveryCase', entityId: ids.kase, party: 'holder', who: { subjectUserId: ids.riderUser } },
  { url: `/custody-cases/${ids.kase}/party-phone?party=relay`, phone: phones.relay, entity: 'CustodyRecoveryCase', entityId: ids.kase, party: 'relay', who: { subjectUserId: ids.relayUser } },
];

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await system(() => app.prisma.tenant.create({ data: { id: OTHER_TENANT, name: `FU other ${RUN}`, slug: OTHER_TENANT, isActive: true } }));

  ids.person = (await person(phones.person, ['CUSTOMER'], { email: `fu-${RUN.toLowerCase()}@example.test` })).id;
  const customer = await person(phones.customer, ['CUSTOMER']);
  ids.ownerUser = (await person(phones.owner, ['VENDOR_OWNER', 'CUSTOMER'])).id;
  ids.vendorOwner = (await system(() => app.prisma.vendorOwner.create({ data: { userId: ids.ownerUser } }))).id;
  ids.vendor = (await system(() => app.prisma.vendor.create({ data: {
    ownerId: ids.vendorOwner, name: 'Contact Counter', slug: `fu-contact-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT',
    phone: phones.store, addressLine1: '1 Counter St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.801, longitude: -58.156,
    status: 'ACTIVE', isVerified: true, acceptingOrders: true, isCurrentlyOpen: true,
  } as never }))).id;
  ids.riderUser = (await person(phones.rider, ['RIDER'])).id;
  ids.rider = (await system(() => app.prisma.rider.create({ data: { userId: ids.riderUser, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } as never }))).id;
  ids.relayUser = (await person(phones.relay, ['RIDER'])).id;
  ids.relay = (await system(() => app.prisma.rider.create({ data: { userId: ids.relayUser, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } as never }))).id;
  ids.driverUser = (await person(phones.driver, ['DRIVER'])).id;
  ids.driver = (await system(() => app.prisma.driver.create({ data: {
    userId: ids.driverUser, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleColor: 'White', vehicleYear: 2015,
    licensePlate: `PFU ${RUN.slice(0, 4)}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
  } as never }))).id;
  const order = async (n: number) => (await system(() => app.prisma.order.create({ data: {
    orderNumber: `FUC-${RUN}-${n}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', status: 'PICKED_UP', customerId: customer.id, vendorId: ids.vendor, riderId: ids.rider,
    deliveryAddress: '1 Gate St', deliveryLat: 6.801, deliveryLng: -58.156,
    subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
  } as never }))).id;
  ids.order = await order(1);
  ids.loneOrder = await order(2);
  const kase = (orderId: string, relayRiderId: string | null) => system(() => app.prisma.custodyRecoveryCase.create({ data: {
    orderId, reason: 'VEHICLE_BREAKDOWN', holderRiderId: ids.rider, ...(relayRiderId ? { relayRiderId, state: 'TRANSFER_IN_PROGRESS' as const } : {}),
    deadlineAt: new Date(Date.now() + 600_000),
  } }));
  ids.kase = (await kase(ids.order, ids.relay)).id;
  ids.loneCase = (await kase(ids.loneOrder, null)).id;

  await adminWith('all', ['*']);
  await adminWith('support', SUPPORT_OPERATOR_CAPABILITIES);
  await adminWith('readers', ['user.read', 'vendor.read', 'mover.read', 'custody.read']);
  await adminWith('userContact', ['user.read', 'user.contact.read']);
  await adminWith('wildcards', ['vendor.*', 'mover.*', 'custody.*']);
  await adminWith('otherTenant', ['*'], OTHER_TENANT);
});

afterAll(async () => {
  await system(async () => {
    await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: allEntities() } }, { userId: { in: userIds } }] }, 'test-cleanup:admin-person-phone-reveal');
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'test-cleanup:admin-person-phone-reveal').catch(() => 0);
    await app.prisma.custodyRecoveryCase.deleteMany({ where: { id: { in: [ids.kase, ids.loneCase] } } });
    await app.prisma.order.deleteMany({ where: { id: { in: [ids.order, ids.loneOrder] } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: [ids.rider, ids.relay] } } });
    await app.prisma.driver.deleteMany({ where: { id: ids.driver } });
    await app.prisma.vendor.deleteMany({ where: { id: ids.vendor } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: ids.vendorOwner } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: OTHER_TENANT } });
  });
  await app.close();
});

describe('[FOLLOWUPS] the person pages show phones masked', () => {
  const masked = (phone: string) => new RegExp(`•+${tail(phone)}$`);

  it('a person: no full number, a masked one ending in the same 4 digits; the rest of the page unchanged', async () => {
    const res = await get(`/users/${ids.person}`, tokens['all']!);
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(phones.person);
    expect(res.json().data.phone).toMatch(masked(phones.person));
    expect(res.json().data.email).toBe(`fu-${RUN.toLowerCase()}@example.test`);
    expect(res.json().data.firstName).toBe('Contact');
  });

  it('a store: neither its own line nor its owner\'s number', async () => {
    const res = await get(`/vendors/${ids.vendor}`, tokens['all']!);
    expect(res.statusCode).toBe(200);
    for (const phone of [phones.store, phones.owner]) expect(res.payload).not.toContain(phone);
    expect(res.json().data.phone).toMatch(masked(phones.store));
    expect(res.json().data.owner.user.phone).toMatch(masked(phones.owner));
    expect(res.json().data.name).toBe('Contact Counter');
  });

  it('a rider and a driver', async () => {
    const rider = await get(`/riders/${ids.rider}`, tokens['all']!);
    expect(rider.statusCode).toBe(200);
    expect(rider.payload).not.toContain(phones.rider);
    expect(rider.json().data.user.phone).toMatch(masked(phones.rider));
    const driver = await get(`/drivers/${ids.driver}`, tokens['all']!);
    expect(driver.statusCode).toBe(200);
    expect(driver.payload).not.toContain(phones.driver);
    expect(driver.json().data.user.phone).toMatch(masked(phones.driver));
  });

  it('a custody case: the rider holding the goods and the relay rider', async () => {
    const res = await get(`/custody-cases/${ids.kase}`, tokens['all']!);
    expect(res.statusCode).toBe(200);
    for (const phone of [phones.rider, phones.relay]) expect(res.payload).not.toContain(phone);
    expect(res.json().data.holder.user.phone).toMatch(masked(phones.rider));
    expect(res.json().data.relay.user.phone).toMatch(masked(phones.relay));
    // The case without a relay rider keeps relay: null.
    expect((await get(`/custody-cases/${ids.loneCase}`, tokens['all']!)).json().data.relay).toBeNull();
  });
});

describe('[FOLLOWUPS] the audited reveal (the order desk\'s door)', () => {
  it('each door is classified C1 with its own contact capability, like order.contact.read', () => {
    expect(ADMIN_ROUTE_AUTHORITY['GET /users/:id/phone']).toMatchObject({ cls: 'C1', capability: 'user.contact.read' });
    expect(ADMIN_ROUTE_AUTHORITY['GET /vendors/:id/party-phone']).toMatchObject({ cls: 'C1', capability: 'vendor.contact.read' });
    expect(ADMIN_ROUTE_AUTHORITY['GET /riders/:id/phone']).toMatchObject({ cls: 'C1', capability: 'mover.contact.read' });
    expect(ADMIN_ROUTE_AUTHORITY['GET /drivers/:id/phone']).toMatchObject({ cls: 'C1', capability: 'mover.contact.read' });
    expect(ADMIN_ROUTE_AUTHORITY['GET /custody-cases/:id/party-phone']).toMatchObject({ cls: 'C1', capability: 'custody.contact.read' });
  });

  it('refuses without a reason, or with one too short to be one, and records nothing', async () => {
    for (const door of doors()) {
      const none = await get(door.url, tokens['all']!);
      expect(none.statusCode, door.url).toBe(400);
      const short = await get(door.url, tokens['all']!, 'need it');
      expect(short.statusCode, door.url).toBe(400);
      expect(short.payload).not.toContain(door.phone);
    }
    expect(await revealRows(allEntities())).toHaveLength(0);
  });

  it('refuses a party the page does not have a line for, and records nothing', async () => {
    expect((await get(`/vendors/${ids.vendor}/party-phone?party=customer`, tokens['all']!, REASON)).statusCode).toBe(400);
    expect((await get(`/custody-cases/${ids.kase}/party-phone?party=mover`, tokens['all']!, REASON)).statusCode).toBe(400);
    expect(await revealRows(allEntities())).toHaveLength(0);
  });

  it('SUPPORT (reads people, holds no contact capability) sees the masked page and is refused the reveal, with no row', async () => {
    const page = await get(`/users/${ids.person}`, tokens['support']!);
    expect(page.statusCode).toBe(200);
    expect(page.payload).not.toContain(phones.person);
    const res = await get(`/users/${ids.person}/phone`, tokens['support']!, REASON);
    expect(res.statusCode).toBe(403);
    expect(res.payload).not.toContain(phones.person);
    expect(res.payload).toContain('user.contact.read');
    expect(await revealRows(allEntities())).toHaveLength(0);
  });

  it('a grant that reads every page but holds no contact capability is refused every door, with no row', async () => {
    for (const door of doors()) {
      const res = await get(door.url, tokens['readers']!, REASON);
      expect(res.statusCode, door.url).toBe(403);
      expect(res.payload).not.toContain(door.phone);
    }
    // ... while each page itself still reads (masked) for it.
    expect((await get(`/riders/${ids.rider}`, tokens['readers']!)).statusCode).toBe(200);
    expect(await revealRows(allEntities())).toHaveLength(0);
  });

  it('the exact capability (or its area wildcard) opens the door: the number, and exactly one audit row', async () => {
    const one = await get(`/users/${ids.person}/phone`, tokens['userContact']!, REASON);
    expect(one.statusCode).toBe(200);
    expect(one.json().data).toMatchObject({ party: 'person', phone: phones.person });
    expect(await revealRows([ids.person])).toHaveLength(1);
    // user.contact.read alone does not open a store's, a mover's or a case's door.
    expect((await get(`/riders/${ids.rider}/phone`, tokens['userContact']!, REASON)).statusCode).toBe(403);
    const store = await get(`/vendors/${ids.vendor}/party-phone?party=store`, tokens['wildcards']!, REASON);
    expect(store.statusCode).toBe(200);
    expect(store.json().data.phone).toBe(phones.store);
    expect(await revealRows([ids.vendor])).toHaveLength(1);
    await system(() => purgeAuditLogs(app.prisma, { entityId: { in: [ids.person, ids.vendor] } }, 'test-cleanup:admin-person-phone-reveal'));
  });

  it('every door returns its party\'s full number, with an audit row naming actor, record, party, person and reason, never the number', async () => {
    for (const door of doors()) {
      const res = await get(door.url, tokens['all']!, REASON);
      expect(res.statusCode, door.url).toBe(200);
      expect(res.json().data).toMatchObject({ party: door.party, phone: door.phone });
      const row = await system(() => app.prisma.auditLog.findUnique({ where: { id: res.json().data.auditId as string } }));
      expect(row, door.url).toMatchObject({ action: 'REVEAL_PARTY_PHONE', entity: door.entity, entityId: door.entityId });
      expect(row!.userId).toBeTruthy();
      expect(row!.changes).toMatchObject({ reason: REASON, party: door.party, ...door.who });
      expect(JSON.stringify(row)).not.toContain(door.phone);
    }
    expect(await revealRows(allEntities())).toHaveLength(doors().length);
    await system(() => purgeAuditLogs(app.prisma, { entityId: { in: allEntities() } }, 'test-cleanup:admin-person-phone-reveal'));
  });

  it('a case with no relay rider: a 404, and the ask is recorded', async () => {
    const res = await get(`/custody-cases/${ids.loneCase}/party-phone?party=relay`, tokens['all']!, REASON);
    expect(res.statusCode).toBe(404);
    expect((await revealRows([ids.loneCase])).map((r) => r.action)).toEqual(['REVEAL_PARTY_PHONE_MISS']);
  });

  it('another tenant\'s administrator (holding *) reaches no number on any door, and nothing is recorded as a reveal', async () => {
    for (const door of doors()) {
      const res = await get(door.url, tokens['otherTenant']!, REASON);
      expect(res.statusCode, door.url).not.toBe(200);
      expect(res.payload).not.toContain(door.phone);
      // ... nor through the page itself.
      const page = await get(door.url.replace(/\/(phone|party-phone)(\?.*)?$/, ''), tokens['otherTenant']!);
      expect(page.payload).not.toContain(door.phone);
    }
    expect((await revealRows(allEntities())).filter((r) => r.action === 'REVEAL_PARTY_PHONE')).toHaveLength(0);
  });
});
