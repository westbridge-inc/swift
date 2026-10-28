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
import { holdsPersonContact, PERSON_CONTACT_CAPABILITIES } from '../modules/admin/person-contact';

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
const phones = { person: testPhone(), owner: testPhone(), store: testPhone(), rider: testPhone(), relay: testPhone(), driver: testPhone(), customer: testPhone(), pendingOwner: testPhone(), pendingStore: testPhone() };
// [SEC-PII] The addresses the person lists must not print in full without the contact capability.
const emails = { person: `fu-${RUN.toLowerCase()}@example.test`, pendingOwner: `fu-owner-${RUN.toLowerCase()}@example.test`, pendingStore: `fu-store-${RUN.toLowerCase()}@example.test` };
const ids = { person: '', ownerUser: '', vendorOwner: '', vendor: '', pendingOwnerUser: '', pendingVendorOwner: '', pendingVendor: '', riderUser: '', rider: '', relayUser: '', relay: '', driverUser: '', driver: '', order: '', loneOrder: '', kase: '', loneCase: '' };
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

  ids.person = (await person(phones.person, ['CUSTOMER'], { email: emails.person })).id;
  const customer = await person(phones.customer, ['CUSTOMER']);
  ids.ownerUser = (await person(phones.owner, ['VENDOR_OWNER', 'CUSTOMER'])).id;
  ids.vendorOwner = (await system(() => app.prisma.vendorOwner.create({ data: { userId: ids.ownerUser } }))).id;
  ids.vendor = (await system(() => app.prisma.vendor.create({ data: {
    ownerId: ids.vendorOwner, name: 'Contact Counter', slug: `fu-contact-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT',
    phone: phones.store, addressLine1: '1 Counter St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.801, longitude: -58.156,
    status: 'ACTIVE', isVerified: true, acceptingOrders: true, isCurrentlyOpen: true,
  } as never }))).id;
  // [SEC-PII] A store waiting for approval: its owner has an email, the store has its own line, email and MMG number.
  ids.pendingOwnerUser = (await person(phones.pendingOwner, ['VENDOR_OWNER', 'CUSTOMER'], { email: emails.pendingOwner })).id;
  ids.pendingVendorOwner = (await system(() => app.prisma.vendorOwner.create({ data: { userId: ids.pendingOwnerUser } }))).id;
  ids.pendingVendor = (await system(() => app.prisma.vendor.create({ data: {
    ownerId: ids.pendingVendorOwner, name: 'Contact Pending', slug: `fu-pending-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT',
    phone: phones.pendingStore, email: emails.pendingStore, mmgNumber: phones.pendingOwner, mmgNumberPending: phones.pendingOwner,
    addressLine1: '2 Counter St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.801, longitude: -58.156,
    status: 'PENDING_APPROVAL',
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
  // [SEC-PII] Narrowed grants for the person LISTS.
  await adminWith('listReaders', ['user.read', 'vendor.read', 'mover.read', 'search.read']);
  await adminWith('userContactPlus', ['user.read', 'user.contact.read', 'vendor.read', 'mover.read', 'search.read']);
  await adminWith('moverContact', ['mover.read', 'mover.contact.read']);
  await adminWith('liveRevoke', ['user.read', 'user.contact.read', 'search.read']);
});

afterAll(async () => {
  await system(async () => {
    await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: allEntities() } }, { userId: { in: userIds } }] }, 'test-cleanup:admin-person-phone-reveal');
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'test-cleanup:admin-person-phone-reveal').catch(() => 0);
    await app.prisma.custodyRecoveryCase.deleteMany({ where: { id: { in: [ids.kase, ids.loneCase] } } });
    await app.prisma.subscription.deleteMany({ where: { OR: [{ riderId: ids.rider }, { driverId: ids.driver }, { vendorId: ids.vendor }] } });
    await app.prisma.order.deleteMany({ where: { id: { in: [ids.order, ids.loneOrder] } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: [ids.rider, ids.relay] } } });
    await app.prisma.driver.deleteMany({ where: { id: ids.driver } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: [ids.vendor, ids.pendingVendor] } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: [ids.vendorOwner, ids.pendingVendorOwner] } } });
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
      // [REVIEW-G #2162 S4-1] A full number is never kept by a cache.
      expect(res.headers['cache-control'], door.url).toBe('no-store');
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

describe('[FOLLOWUPS · REVIEW-M/G #2162 S3-1] no other field on a masked page carries a full number', () => {
  const DAYS7 = () => new Date(Date.now() + 7 * DAY);
  const TOKEN = `fixture-card-token-${RUN}`;

  it('a person page: the number each cash strike recorded (theirs, at the door) is masked too', async () => {
    await system(() => app.prisma.strike.create({ data: { userId: ids.person, reason: 'failed_payment_no_show', phone: phones.person } }));
    const res = await get(`/users/${ids.person}`, tokens['readers']!);
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(phones.person);
    expect(res.json().data.strikes[0].phone).toMatch(new RegExp(`•+${tail(phones.person)}$`));
  });

  it('a rider or driver who pays the weekly fee by MMG from their own phone: the payer number is masked, no card token rides the page', async () => {
    await system(async () => {
      await app.prisma.subscription.create({ data: {
        riderId: ids.rider, type: 'DELIVERY_RIDER', weeklyRate: 1000, currentPeriodStart: new Date(), currentPeriodEnd: DAYS7(), nextBillingDate: DAYS7(),
        billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: phones.rider, paymentToken: TOKEN,
      } as never });
      await app.prisma.subscription.create({ data: {
        driverId: ids.driver, type: 'TAXI_DRIVER', weeklyRate: 1000, currentPeriodStart: new Date(), currentPeriodEnd: DAYS7(), nextBillingDate: DAYS7(),
        billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: phones.driver,
      } as never });
    });
    for (const [url, phone] of [[`/riders/${ids.rider}`, phones.rider], [`/drivers/${ids.driver}`, phones.driver]] as const) {
      const res = await get(url, tokens['readers']!);
      expect(res.statusCode, url).toBe(200);
      expect(res.payload, url).not.toContain(phone);
      expect(res.payload, url).not.toContain(TOKEN);
      expect(res.json().data.subscription.mmgPayerMsisdn, url).toMatch(new RegExp(`•+${tail(phone)}$`));
      expect('paymentToken' in res.json().data.subscription, url).toBe(false);
      // the rest of the subscription the page shows is unchanged
      expect(res.json().data.subscription.weeklyRate, url).toBeTruthy();
    }
  });

  it('a store whose MMG number (live and pending) is its owner\'s phone, and whose fee payer is the store line: all masked', async () => {
    await system(async () => {
      await app.prisma.vendor.update({ where: { id: ids.vendor }, data: { mmgNumber: phones.owner, mmgNumberPending: phones.owner } as never });
      await app.prisma.subscription.create({ data: {
        vendorId: ids.vendor, type: 'RESTAURANT', weeklyRate: 20000, currentPeriodStart: new Date(), currentPeriodEnd: DAYS7(), nextBillingDate: DAYS7(),
        billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: phones.store, paymentToken: TOKEN,
      } as never });
    });
    const res = await get(`/vendors/${ids.vendor}`, tokens['readers']!);
    expect(res.statusCode).toBe(200);
    for (const phone of [phones.owner, phones.store]) expect(res.payload).not.toContain(phone);
    expect(res.payload).not.toContain(TOKEN);
    const data = res.json().data;
    for (const key of ['mmgNumber', 'mmgNumberPending'] as const) expect(data[key], key).toMatch(new RegExp(`•+${tail(phones.owner)}$`));
    expect(data.subscription.mmgPayerMsisdn).toMatch(new RegExp(`•+${tail(phones.store)}$`));
    expect('paymentToken' in data.subscription).toBe(false);
  });

  it('the order desk\'s own reveal answer is not kept by a cache either', async () => {
    const res = await get(`/orders/${ids.order}/party-phone?party=customer`, tokens['all']!, REASON);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    await system(() => purgeAuditLogs(app.prisma, { entityId: ids.order }, 'test-cleanup:admin-person-phone-reveal'));
  });
});

// ---------------------------------------------------------------------------
// [SEC-PII · security scan 28 Oct 2026] THE PERSON LISTS follow the pages.
//
// The pages above mask; the lists that lead to them printed every row's full
// number (and email) to any grant that could open the list: GET /users,
// /search (its people), /riders, /drivers, /vendors and /vendors/pending. A
// grant without the contact capability got, in bulk, what the audited door
// refuses it one person at a time. Each list now masks every row's numbers and
// emails unless the caller's LIVE grant (re-read on every request) holds the
// matching contact capability: user.contact.read for people, mover.contact.read
// for riders and drivers, vendor.contact.read for stores and their owners.
// Searching by the full number still works server-side.
// ---------------------------------------------------------------------------
describe('[SEC-PII] the person lists mask numbers and emails unless the grant holds the contact capability', () => {
  const allPhones = () => Object.values(phones);
  const allEmails = () => Object.values(emails);
  const lists = () => ({
    users: `/users?search=P${RUN}`,
    search: `/search?q=P${RUN}`,
    riders: `/riders?search=P${RUN}`,
    drivers: `/drivers?search=P${RUN}`,
    vendors: `/vendors?search=${RUN.toLowerCase()}`,
    vendorsPending: '/vendors/pending',
  });
  type ListKey = keyof ReturnType<typeof lists>;
  /** The phones and emails each list could carry (its own people), so "full" means exactly those. */
  const contactsOf: Record<ListKey, () => string[]> = {
    users: () => [phones.person, phones.owner, phones.rider, phones.relay, phones.driver, phones.customer, phones.pendingOwner, emails.person, emails.pendingOwner],
    search: () => [], // checked per row below (the search takes 5 people, whichever)
    riders: () => [phones.rider, phones.relay],
    drivers: () => [phones.driver],
    vendors: () => [phones.owner, phones.store, phones.pendingOwner, phones.pendingStore, emails.pendingStore],
    vendorsPending: () => [phones.pendingOwner, phones.pendingStore, emails.pendingOwner, emails.pendingStore],
  };
  const read = async (key: ListKey, token: string) => {
    const res = await get(lists()[key], token);
    return res;
  };
  const leaks = (payload: string) => [...allPhones(), ...allEmails()].filter((value) => payload.includes(value));

  it('SUPPORT (user.read, no contact capability): every person list it can open shows no full number or email; the rest is refused', async () => {
    const users = await read('users', tokens['support']!);
    expect(users.statusCode).toBe(200);
    expect(leaks(users.payload)).toEqual([]);
    const row = (users.json().data as Array<{ id: string; phone: string; email: string | null; firstName: string }>).find((u) => u.id === ids.person)!;
    expect(row.phone).toMatch(new RegExp(`•+${tail(phones.person)}$`));
    expect(row.email).toBe(`f•••@example.test`);
    expect(row.firstName).toBe('Contact');
    for (const key of ['search', 'riders', 'drivers', 'vendors', 'vendorsPending'] as const) {
      const res = await read(key, tokens['support']!);
      expect([200, 403], key).toContain(res.statusCode);
      expect(leaks(res.payload), key).toEqual([]);
    }
  });

  it('a grant that opens every list but holds no contact capability: every row masked, the lists otherwise unchanged', async () => {
    for (const key of Object.keys(lists()) as ListKey[]) {
      const res = await read(key, tokens['listReaders']!);
      expect(res.statusCode, key).toBe(200);
      expect(leaks(res.payload), key).toEqual([]);
    }
    const riders = (await read('riders', tokens['listReaders']!)).json().data as Array<{ id: string; user: { phone: string; firstName: string } }>;
    expect(riders.find((r) => r.id === ids.rider)!.user.phone).toMatch(new RegExp(`•+${tail(phones.rider)}$`));
    expect(riders.find((r) => r.id === ids.rider)!.user.firstName).toBe('Contact');
    const drivers = (await read('drivers', tokens['listReaders']!)).json().data as Array<{ id: string; user: { phone: string } }>;
    expect(drivers.find((d) => d.id === ids.driver)!.user.phone).toMatch(new RegExp(`•+${tail(phones.driver)}$`));
    type StoreRow = { id: string; name: string; phone: string; email: string | null; mmgNumber: string | null; owner: { user: { phone: string; email?: string | null } } };
    const vendors = (await read('vendors', tokens['listReaders']!)).json().data as StoreRow[];
    const store = vendors.find((v) => v.id === ids.vendor)!;
    expect(store.phone).toMatch(new RegExp(`•+${tail(phones.store)}$`));
    expect(store.owner.user.phone).toMatch(new RegExp(`•+${tail(phones.owner)}$`));
    expect(store.name).toBe('Contact Counter');
    const pending = ((await read('vendorsPending', tokens['listReaders']!)).json().data as StoreRow[]).find((v) => v.id === ids.pendingVendor)!;
    expect(pending.phone).toMatch(new RegExp(`•+${tail(phones.pendingStore)}$`));
    expect(pending.email).toBe('f•••@example.test');
    expect(pending.mmgNumber).toMatch(new RegExp(`•+${tail(phones.pendingOwner)}$`));
    expect(pending.owner.user.phone).toMatch(new RegExp(`•+${tail(phones.pendingOwner)}$`));
    expect(pending.owner.user.email).toBe('f•••@example.test');
    expect(pending.name).toBe('Contact Pending');
    const people = (await read('search', tokens['listReaders']!)).json().data.users as Array<{ phone: string }>;
    expect(people.length).toBeGreaterThan(0);
    for (const person of people) expect(person.phone).toMatch(/•/);
  });

  it('the server still finds a person by their full number; the answer is masked', async () => {
    const res = await get(`/users?search=${encodeURIComponent(phones.person)}`, tokens['listReaders']!);
    expect(res.statusCode).toBe(200);
    expect((res.json().data as Array<{ id: string }>).map((u) => u.id)).toContain(ids.person);
    expect(res.payload).not.toContain(phones.person);
    const riders = await get(`/riders?search=${encodeURIComponent(phones.rider)}`, tokens['listReaders']!);
    expect((riders.json().data as Array<{ id: string }>).map((r) => r.id)).toEqual([ids.rider]);
    expect(riders.payload).not.toContain(phones.rider);
  });

  // [SEC-PII · COORD] A substring search over the number or the email is an oracle: a caller who sees only the
  // masked row could still recover the number digit by digit from which rows come back. Without the contact
  // capability, the number and the email match only the EXACT full value; names keep substring search.
  it('without the contact capability, a person is found only by the exact full number or email, never a part of it', async () => {
    const found = async (url: string, token: string) => {
      const res = await get(url, token);
      expect(res.statusCode, url).toBe(200);
      const body = res.json().data;
      return (Array.isArray(body) ? body : body.users as unknown[]).map((row) => (row as { id: string }).id);
    };
    const partials = [phones.person.slice(-6), phones.person.slice(0, 8), phones.person.slice(2, 9), `${phones.person.slice(0, -1)}%`, emails.person.slice(0, 6), `${emails.person.slice(0, 4)}%`, emails.person.replace(/^./, '_'), emails.person.split('@')[0]!, '@example.test'];
    for (const part of partials) {
      expect(await found(`/users?search=${encodeURIComponent(part)}`, tokens['listReaders']!), part).not.toContain(ids.person);
      expect(await found(`/search?q=${encodeURIComponent(part)}`, tokens['listReaders']!), part).not.toContain(ids.person);
    }
    for (const part of [phones.rider.slice(-6), phones.rider.slice(0, 9)]) {
      expect(await found(`/riders?search=${encodeURIComponent(part)}`, tokens['listReaders']!), part).not.toContain(ids.rider);
    }
    expect(await found(`/drivers?search=${encodeURIComponent(phones.driver.slice(-6))}`, tokens['listReaders']!)).not.toContain(ids.driver);
    // The exact full number (as typed, with spaces, or without the +) and the exact email still find the person.
    const spaced = `${phones.person.slice(0, 4)} ${phones.person.slice(4, 7)} ${phones.person.slice(7)}`;
    for (const exact of [phones.person, spaced, phones.person.slice(1), emails.person, emails.person.toUpperCase()]) {
      expect(await found(`/users?search=${encodeURIComponent(exact)}`, tokens['listReaders']!), exact).toContain(ids.person);
      expect(await found(`/search?q=${encodeURIComponent(exact)}`, tokens['listReaders']!), exact).toContain(ids.person);
    }
    expect(await found(`/riders?search=${encodeURIComponent(phones.rider)}`, tokens['listReaders']!)).toEqual([ids.rider]);
    expect(await found(`/drivers?search=${encodeURIComponent(phones.driver)}`, tokens['listReaders']!)).toEqual([ids.driver]);
    // Names keep substring search.
    expect(await found(`/users?search=${encodeURIComponent(`P${RUN}`.slice(0, 5))}`, tokens['listReaders']!)).toContain(ids.person);
    // A caller holding the capability keeps today's substring search.
    expect(await found(`/users?search=${encodeURIComponent(phones.person.slice(-6))}`, tokens['userContactPlus']!)).toContain(ids.person);
    expect(await found(`/users?search=${encodeURIComponent(emails.person.slice(0, 6))}`, tokens['userContactPlus']!)).toContain(ids.person);
    expect(await found(`/riders?search=${encodeURIComponent(phones.rider.slice(-6))}`, tokens['moverContact']!)).toContain(ids.rider);
  });

  it('each contact capability unmasks only its own lists: user.contact.read shows people, never movers or stores', async () => {
    const users = await read('users', tokens['userContactPlus']!);
    for (const value of contactsOf.users()) expect(users.payload, value).toContain(value);
    const people = (await read('search', tokens['userContactPlus']!)).json().data.users as Array<{ phone: string }>;
    for (const person of people) expect(person.phone).not.toMatch(/•/);
    for (const key of ['riders', 'drivers', 'vendors', 'vendorsPending'] as const) {
      const res = await read(key, tokens['userContactPlus']!);
      expect(res.statusCode, key).toBe(200);
      expect(leaks(res.payload), key).toEqual([]);
    }
  });

  it('mover.contact.read shows riders and drivers in full; vendor.* (holds vendor.contact.read) shows stores and owners in full', async () => {
    for (const key of ['riders', 'drivers'] as const) {
      const res = await read(key, tokens['moverContact']!);
      expect(res.statusCode, key).toBe(200);
      for (const value of contactsOf[key]()) expect(res.payload, value).toContain(value);
    }
    for (const key of ['vendors', 'vendorsPending'] as const) {
      const res = await read(key, tokens['wildcards']!);
      expect(res.statusCode, key).toBe(200);
      for (const value of contactsOf[key]()) expect(res.payload, `${key} ${value}`).toContain(value);
    }
  });

  it('the full grant (*) keeps the lists as they were', async () => {
    for (const key of ['users', 'riders', 'drivers', 'vendors', 'vendorsPending'] as const) {
      const res = await read(key, tokens['all']!);
      expect(res.statusCode, key).toBe(200);
      for (const value of contactsOf[key]()) expect(res.payload, `${key} ${value}`).toContain(value);
    }
  });

  it('the list check is the reveal doors\' own capability, read from this request\'s live grant, and never fails open', () => {
    expect(PERSON_CONTACT_CAPABILITIES).toEqual({
      user: ADMIN_ROUTE_AUTHORITY['GET /users/:id/phone']!.capability,
      mover: ADMIN_ROUTE_AUTHORITY['GET /riders/:id/phone']!.capability,
      vendor: ADMIN_ROUTE_AUTHORITY['GET /vendors/:id/party-phone']!.capability,
    });
    expect(ADMIN_ROUTE_AUTHORITY['GET /drivers/:id/phone']!.capability).toBe(PERSON_CONTACT_CAPABILITIES.mover);
    // No grant read for this request (the capability hook did not run): masked, even for an ADMIN.
    expect(holdsPersonContact({ user: { role: 'ADMIN' } }, 'user')).toBe(false);
    expect(holdsPersonContact(null, 'user')).toBe(false);
    // No Admin row: the role's container, as the route decision itself uses.
    expect(holdsPersonContact({ user: { role: 'ADMIN' }, adminPermissions: null }, 'user')).toBe(true);
    expect(holdsPersonContact({ user: { role: 'CUSTOMER' }, adminPermissions: null }, 'user')).toBe(false);
    expect(holdsPersonContact({ user: { role: 'ADMIN' }, adminPermissions: [...SUPPORT_OPERATOR_CAPABILITIES] }, 'user')).toBe(false);
    expect(holdsPersonContact({ user: { role: 'ADMIN' }, adminPermissions: ['user.*'] }, 'user')).toBe(true);
    expect(holdsPersonContact({ user: { role: 'ADMIN' }, adminPermissions: ['user.*'] }, 'mover')).toBe(false);
  });

  it('the grant is read live: taking user.contact.read away masks the very next list read, same token', async () => {
    const before = await read('users', tokens['liveRevoke']!);
    expect(before.payload).toContain(phones.person);
    const admin = (await system(() => app.prisma.user.findMany({ where: { lastName: `P${RUN}`, admin: { permissions: { has: 'user.contact.read' } } }, select: { id: true, admin: { select: { permissions: true } } } })))
      .find((u) => u.admin!.permissions.length === 3)!;
    await system(() => app.prisma.admin.update({ where: { userId: admin.id }, data: { permissions: ['user.read', 'search.read'] } }));
    const after = await read('users', tokens['liveRevoke']!);
    expect(after.statusCode).toBe(200);
    expect(leaks(after.payload)).toEqual([]);
    const search = await read('search', tokens['liveRevoke']!);
    expect(leaks(search.payload)).toEqual([]);
    for (const person of search.json().data.users as Array<{ phone: string }>) expect(person.phone).toMatch(/•/);
  });
});
