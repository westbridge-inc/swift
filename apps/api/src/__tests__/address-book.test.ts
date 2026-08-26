import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, beginRequestTenantContext } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [S14] The address book was APPEND-ONLY from the app. PUT /addresses/:id,
// DELETE /addresses/:id and PUT /addresses/:id/default have existed, been
// owner-scoped and been correct the whole time — with no caller anywhere in
// the client. Wiring them up is only safe if the behaviour underneath is the
// behaviour the screens now promise, so this pins it:
//
//   - editing writes, and CLEARS a field the customer emptied;
//   - deleting takes the cart's pointer with it (Cart.deliveryAddressId is a
//     bare string with no foreign key, so nothing else would);
//   - deleting the default promotes another one, so a customer is never left
//     with addresses and no default;
//   - default is exclusive;
//   - none of it reaches another customer's rows.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let userId: string;
let token: string;
let strangerId: string;
let strangerAddressId: string;
let vendorId: string;
const createdUserIds: string[] = [];

async function signIn(id: string): Promise<string> {
  const jwt = app.jwt.sign({ userId: id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: id, token: jwt, refreshToken: nanoid(48),
      deviceId: `addr-${nanoid(6)}`, deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return jwt;
}

async function makeCustomer(phone: string): Promise<string> {
  const u = await app.prisma.user.create({
    data: {
      phone, firstName: 'Addr', lastName: 'Book',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      customer: { create: {} },
    },
  });
  createdUserIds.push(u.id);
  return u.id;
}

async function addAddress(auth: Record<string, string>, label: string, isDefault = false) {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/customer/addresses', headers: auth,
    payload: {
      label, addressLine1: `${label} Street 1`, addressLine2: 'Flat 2',
      city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, isDefault,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { data: { id: string } }).data.id;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  registerErrorHandler(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  // Idempotent purge (house pattern: this file owns +59200798).
  const stale = await app.prisma.user.findMany({ where: { phone: { startsWith: '+59200798' } }, select: { id: true } });
  if (stale.length) {
    const ids = stale.map((u) => u.id);
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  userId = await makeCustomer('+59200798001');
  token = await signIn(userId);
  strangerId = await makeCustomer('+59200798002');

  const vendor = await app.prisma.vendor.findFirst({ where: { status: 'ACTIVE' }, select: { id: true } });
  vendorId = vendor!.id;
});

afterAll(async () => {
  await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('the address book can finally be corrected [S14]', () => {
  it('an edit writes the change, and EMPTYING a field actually clears it', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const id = await addAddress(auth, 'Typo');

    const res = await app.inject({
      method: 'PUT', url: `/api/v1/customer/addresses/${id}`, headers: auth,
      // The screen sends '' for a field the customer emptied. Sending
      // undefined would leave the old flat number standing — the route only
      // writes the keys it is given.
      payload: { label: 'Home', addressLine1: 'Correct Street 9', addressLine2: '', instructions: '' },
    });
    expect(res.statusCode).toBe(200);

    const row = await app.prisma.address.findUniqueOrThrow({ where: { id } });
    expect(row.label).toBe('Home');
    expect(row.addressLine1).toBe('Correct Street 9');
    expect(row.addressLine2).toBe('');
    expect(row.instructions).toBe('');
  });

  it("deleting an address takes the CART's pointer with it", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const id = await addAddress(auth, 'Doomed');
    await app.prisma.cart.deleteMany({ where: { customerId: userId } });
    await app.prisma.cart.create({ data: { customerId: userId, vendorId, deliveryAddressId: id } });

    const res = await app.inject({ method: 'DELETE', url: `/api/v1/customer/addresses/${id}`, headers: auth });
    expect(res.statusCode).toBe(200);

    // Cart.deliveryAddressId has NO foreign key — without the explicit clear
    // the cart keeps naming a row that no longer exists.
    const cart = await app.prisma.cart.findUniqueOrThrow({ where: { customerId: userId } });
    expect(cart.deliveryAddressId).toBeNull();
    expect(await app.prisma.address.findUnique({ where: { id } })).toBeNull();
  });

  it('deleting the default promotes another — a customer is never left with addresses and no default', async () => {
    const auth = { authorization: `Bearer ${token}` };
    await app.prisma.address.deleteMany({ where: { userId } });
    const first = await addAddress(auth, 'First', true);
    const second = await addAddress(auth, 'Second');

    const res = await app.inject({ method: 'DELETE', url: `/api/v1/customer/addresses/${first}`, headers: auth });
    expect(res.statusCode).toBe(200);

    const row = await app.prisma.address.findUniqueOrThrow({ where: { id: second } });
    expect(row.isDefault).toBe(true);
  });

  it('default is exclusive — setting one clears the other', async () => {
    const auth = { authorization: `Bearer ${token}` };
    await app.prisma.address.deleteMany({ where: { userId } });
    const a = await addAddress(auth, 'Alpha', true);
    const b = await addAddress(auth, 'Bravo');

    const res = await app.inject({ method: 'PUT', url: `/api/v1/customer/addresses/${b}/default`, headers: auth });
    expect(res.statusCode).toBe(200);

    const rows = await app.prisma.address.findMany({ where: { userId }, select: { id: true, isDefault: true } });
    expect(rows.filter((r) => r.isDefault).map((r) => r.id)).toEqual([b]);
    expect(rows.find((r) => r.id === a)!.isDefault).toBe(false);
  });

  it("none of it reaches another customer's address", async () => {
    const strangerToken = await signIn(strangerId);
    strangerAddressId = await addAddress({ authorization: `Bearer ${strangerToken}` }, 'Not Yours', true);

    const auth = { authorization: `Bearer ${token}` };
    for (const [method, url] of [
      ['PUT', `/api/v1/customer/addresses/${strangerAddressId}`],
      ['DELETE', `/api/v1/customer/addresses/${strangerAddressId}`],
      ['PUT', `/api/v1/customer/addresses/${strangerAddressId}/default`],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth, payload: { label: 'Hijacked' } });
      // 404, not 403: the owner check must not confirm the row exists.
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }

    const row = await app.prisma.address.findUniqueOrThrow({ where: { id: strangerAddressId } });
    expect(row.label).toBe('Not Yours');
    expect(row.isDefault).toBe(true);
  });
});
