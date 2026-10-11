import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import os from 'node:os';
import path from 'node:path';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { BookingService } from '../modules/booking/booking.service';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';

// ---------------------------------------------------------------------------
// catalogue: CSV import with row-level errors, instant availability
// in customer-facing paths, double-booking impossible under concurrency,
// malformed images rejected, one code path for goods AND services.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let booking: BookingService;
let vendorToken: string;
let vendorId: string;
let customerToken: string;
let customerId: string;

const createdUserIds: string[] = [];

let seq = 0;
async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200066${String(seq).padStart(2, '0')}`,
      firstName: 'Step6',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: 'step6-test',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeVendor(owned: { userId: string }, opts: { verified: boolean }) {
  seq += 1;
  const owner = await app.prisma.vendorOwner.create({ data: { userId: owned.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Catalogue Vendor ${seq}`,
      slug: `catalogue-vendor-${seq}`,
      vendorType: 'RESTAURANT',
      phone: `+5920007${String(seq).padStart(3, '0')}`,
      addressLine1: '1 Catalogue Street',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.8,
      longitude: -58.15,
      status: 'ACTIVE',
      acceptingOrders: true,
      isCurrentlyOpen: true,
      isVerified: opts.verified,
    },
  });
  return vendor.id;
}

function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

function multipartBody(filename: string, mime: string, content: Buffer) {
  const boundary = `----swift${nanoid(8)}`;
  const head = Buffer.from(
    `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Next occurrence of a UTC weekday at hh:mm, at least one day out. */
/** The next given weekday (from tomorrow) at a Guyana wall-clock time, as the
 *  TRUE instant the slot happens — what the picker sends and the row stores. */
function nextGuyana(dayOfWeek: number, hours: number, minutes: number): Date {
  const [y, m, d] = guyanaDayKey(new Date()).split('-').map(Number);
  for (let i = 1; i <= 7; i++) {
    const day = new Date(Date.UTC(y!, m! - 1, d! + i));
    if (day.getUTCDay() !== dayOfWeek) continue;
    return instantOfGuyanaWallClock(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hours, minutes)));
  }
  throw new Error('unreachable: every weekday occurs within seven days');
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  process.env['UPLOAD_DIR'] = path.join(os.tmpdir(), 'swift-step6-uploads');

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  booking = new BookingService(app.prisma);

  const vendorUser = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  vendorToken = vendorUser.token;
  vendorId = await makeVendor(vendorUser, { verified: true });

  const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
  customerToken = customer.token;
  customerId = customer.userId;
});

afterAll(async () => {
  if (createdUserIds.length) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('CSV import', () => {
  it('serves the template', async () => {
    const res = await inject('GET', '/api/v1/vendor/items/import/template', undefined, vendorToken);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.split('\n')[0]).toBe(
      'category,name,description,basePrice,sku,unit,stockQuantity,isAvailable,fulfillment,imageUrl',
    );
  });

  it('imports the good rows of a messy file and reports the bad ones by row', async () => {
    const messy = [
      'category,name,description,basePrice,sku,unit,stockQuantity,isAvailable,fulfillment,imageUrl',
      'Mains,CSV Burger,"Juicy, with cheese",1500,,,,true,DELIVERY,', // ok (quoted comma)
      'Mains,CSV Fries,Crispy,abc,,,,true,,', // bad price
      ',CSV Orphan,No category,900,,,,,,', // missing category
      '', // blank line
      'Drinks,CSV Mauby,Bark brew,400,,,12,false,,', // ok (new category, unavailable)
      'Services,CSV Trim,"30 min",2000,,,,true,APPOINTMENT,', // ok (a service — same code path)
    ].join('\n');

    const res = await inject('POST', '/api/v1/vendor/items/import', { csv: messy }, vendorToken);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;

    expect(data.imported).toBe(3);
    expect(data.failedCount).toBe(2);
    expect(data.failures.map((f: { row: number }) => f.row).sort()).toEqual([3, 4]);
    expect(data.failures[0].errors.length).toBeGreaterThan(0);

    const imported = await app.prisma.item.findMany({
      where: { vendorId, name: { startsWith: 'CSV ' } },
    });
    expect(imported).toHaveLength(3);

    const mauby = imported.find((i) => i.name === 'CSV Mauby')!;
    expect(mauby.isAvailable).toBe(false);
    expect(mauby.stockQuantity).toBe(12);

    const trim = imported.find((i) => i.name === 'CSV Trim')!;
    expect(trim.fulfillment).toBe('APPOINTMENT');

    // Categories were created on demand
    const drinks = await app.prisma.category.findFirst({ where: { vendorId, name: 'Drinks' } });
    expect(drinks).not.toBeNull();
  });

  it('rejects a file over the row cap with a clear error', async () => {
    const header = 'category,name,description,basePrice,sku,unit,stockQuantity,isAvailable,fulfillment,imageUrl';
    const rows = Array.from({ length: 5001 }, (_, i) => `Bulk,Item ${i},,100,,,,,,`);
    const res = await inject('POST', '/api/v1/vendor/items/import', { csv: [header, ...rows].join('\n') }, vendorToken);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('TOO_MANY_ROWS');
  });

  it.each(['/items/import', '/items/import/automap'])('bounds CSV before expansion on %s', async (route) => {
    const before = await app.prisma.item.count({ where: { vendorId } });
    for (const [csv, code] of [
      ['category,name,basePrice\n' + 'Mains,Bounded,100\n'.repeat(5001), 'TOO_MANY_ROWS'],
      [Array(101).fill('name').join(',') + '\nx', 'CSV_TOO_WIDE'],
      ['name\n"' + 'x'.repeat(2049) + '"', 'CSV_CELL_TOO_LONG'],
    ]) {
      const response = await inject('POST', '/api/v1/vendor' + route, { csv }, vendorToken);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe(code);
    }
    expect(await app.prisma.item.count({ where: { vendorId } })).toBe(before);
  });

  it('the listing gate applies to imports too', async () => {
    const unverifiedUser = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    await makeVendor(unverifiedUser, { verified: false });

    const res = await inject('POST', '/api/v1/vendor/items/import', {
      csv: 'category,name,basePrice\nMains,Nope,100',
    }, unverifiedUser.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('VERIFICATION_REQUIRED');
  });
});

describe('Availability toggle — instant customer-facing effect', () => {
  let itemId: string;

  beforeAll(async () => {
    const category = await app.prisma.category.findFirstOrThrow({ where: { vendorId, name: 'Mains' } });
    const item = await app.prisma.item.create({
      data: { vendorId, categoryId: category.id, name: 'Toggle Burger', basePrice: 1200 },
    });
    itemId = item.id;
  });

  it('an available item can be added to a customer cart', async () => {
    const res = await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 }, customerToken);
    expect(res.statusCode).toBe(201);
  });

  it('flipping it off blocks the very next add-to-cart', async () => {
    const toggle = await inject('PUT', `/api/v1/vendor/items/${itemId}/availability`, { isAvailable: false }, vendorToken);
    expect(toggle.statusCode).toBe(200);

    const res = await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 }, customerToken);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ITEM_NOT_FOUND');
  });

  afterAll(async () => {
    await app.prisma.cart.deleteMany({ where: { customerId } });
  });
});

describe('Bookings — double-booking is impossible at the data layer', () => {
  let serviceItemId: string;
  const slot = nextGuyana(5, 10, 0); // next Friday 10:00 in Guyana (14:00Z)

  beforeAll(async () => {
    const category = await app.prisma.category.create({
      data: { vendorId, name: 'Appointments', sortOrder: 9 },
    });
    const item = await app.prisma.item.create({
      data: {
        vendorId,
        categoryId: category.id,
        name: 'Step6 Haircut',
        basePrice: 2000,
        fulfillment: 'APPOINTMENT',
        bookingConfig: {
          durationMinutes: 30,
          slots: [
            { dayOfWeek: 5, start: '09:00', end: '17:00' },
            { dayOfWeek: 6, start: '09:00', end: '17:00' },
          ],
        },
      },
    });
    serviceItemId = item.id;
  });

  it('5 concurrent reservations on one slot resolve to exactly one winner', async () => {
    const customers = await Promise.all(
      Array.from({ length: 5 }, () => makeUserWithSession(['CUSTOMER'], 'CUSTOMER')),
    );

    const results = await Promise.allSettled(
      customers.map((c) => booking.reserveSlot(serviceItemId, c.userId, slot)),
    );

    const wins = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'SLOT_TAKEN',
    );
    expect(wins).toHaveLength(1);
    expect(conflicts).toHaveLength(4);

    const live = await app.prisma.booking.count({
      where: { itemId: serviceItemId, slotStart: slot, status: { not: 'CANCELLED' } },
    });
    expect(live).toBe(1);
  });

  it('cancelling frees the slot for someone else', async () => {
    const winner = await app.prisma.booking.findFirstOrThrow({
      where: { itemId: serviceItemId, slotStart: slot, status: 'RESERVED' },
    });
    await booking.cancelBooking(winner.id, winner.customerId);

    const next = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rebooked = await booking.reserveSlot(serviceItemId, next.userId, slot);
    expect(rebooked.status).toBe('RESERVED');
  });

  it('rejects slots outside configured hours, misaligned starts, past times, and non-bookable listings', async () => {
    const sunday = nextGuyana(0, 10, 0);
    await expect(booking.reserveSlot(serviceItemId, customerId, sunday)).rejects.toMatchObject({ code: 'SLOT_OUTSIDE_HOURS' });

    const misaligned = nextGuyana(6, 10, 7);
    await expect(booking.reserveSlot(serviceItemId, customerId, misaligned)).rejects.toMatchObject({ code: 'SLOT_OUTSIDE_HOURS' });

    await expect(
      booking.reserveSlot(serviceItemId, customerId, new Date(Date.now() - DAY)),
    ).rejects.toMatchObject({ code: 'SLOT_IN_PAST' });

    const burger = await app.prisma.item.findFirstOrThrow({ where: { vendorId, name: 'CSV Burger' } });
    await expect(
      booking.reserveSlot(burger.id, customerId, nextGuyana(6, 11, 0)),
    ).rejects.toMatchObject({ code: 'NOT_BOOKABLE' });
  });
});

describe('Image upload — validated, behind the StorageProvider', () => {
  let itemId: string;

  beforeAll(async () => {
    const item = await app.prisma.item.findFirstOrThrow({ where: { vendorId, name: 'CSV Burger' } });
    itemId = item.id;
  });

  it('accepts a real PNG and stores a URL', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 1),
    ]);
    const { payload, contentType } = multipartBody('burger.png', 'image/png', png);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/vendor/items/${itemId}/image`,
      payload,
      headers: { 'content-type': contentType, authorization: `Bearer ${vendorToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.imageUrl).toContain('/uploads/items/');
  });

  it('rejects content that does not match an image format (spoofed mime)', async () => {
    const fake = Buffer.from('#!/bin/sh\necho not an image\n'.repeat(4));
    const { payload, contentType } = multipartBody('evil.png', 'image/png', fake);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/vendor/items/${itemId}/image`,
      payload,
      headers: { 'content-type': contentType, authorization: `Bearer ${vendorToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_IMAGE');
  });

  it('rejects disallowed declared types outright', async () => {
    const { payload, contentType } = multipartBody('notes.txt', 'text/plain', Buffer.from('hello'));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/vendor/items/${itemId}/image`,
      payload,
      headers: { 'content-type': contentType, authorization: `Bearer ${vendorToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_IMAGE_TYPE');
  });
});

describe('One code path for all four vendor types', () => {
  it('the same vendor endpoints listed a burger and a haircut', async () => {
    const res = await inject('GET', '/api/v1/vendor/items', undefined, vendorToken);
    expect(res.statusCode).toBe(200);
    const items = res.json().data as Array<{ name: string; fulfillment: string }>;
    const kinds = new Set(items.map((i) => i.fulfillment));
    expect(kinds.has('DELIVERY')).toBe(true);
    expect(kinds.has('APPOINTMENT')).toBe(true);
  });
});


describe('deleting a menu item archives its order and booking references', () => {
  // This block's orders and bookings reference the shared customer: remove
  // them before the file's own cleanup deletes the people.
  const fixtureOrderIds: string[] = [];
  afterAll(async () => {
    await app.prisma.booking.deleteMany({ where: { customerId } });
    await app.prisma.cart.deleteMany({ where: { customerId } });
    await app.prisma.order.deleteMany({ where: { id: { in: fixtureOrderIds } } });
  });

  async function archiveFixture(fulfillment: 'DELIVERY' | 'APPOINTMENT' = 'DELIVERY') {
    const category = await app.prisma.category.create({ data: { vendorId, name: `Archive ${nanoid(8)}` } });
    const item = await app.prisma.item.create({ data: {
      vendorId, categoryId: category.id, name: 'Archive fixture', basePrice: 500, fulfillment,
      stockQuantity: 0, isAvailable: false, autoHiddenAt: new Date(),
      optionGroups: { create: { name: 'Size', options: { create: { name: 'Small', additionalPrice: 0 } } } },
    } });
    const order = await app.prisma.order.create({ data: {
      orderNumber: `ARCHIVE-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment,
      customerId, vendorId, status: 'PENDING', paymentMethod: 'CASH',
      deliveryAddress: 'Fixture', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 500, subtotalMarkup: 0, subtotalCustomer: 500, deliveryFee: 0, totalAmount: 500,
      items: { create: { itemId: item.id, name: item.name, quantity: 1, basePrice: 500, markedUpPrice: 500, markupAmount: 0, totalBase: 500, totalMarkup: 0, totalCustomer: 500 } },
    } });
    fixtureOrderIds.push(order.id);
    const response = await inject('DELETE', `/api/v1/vendor/items/${item.id}`, undefined, vendorToken);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.deleted).toBe(true); // keep the shipped client contract
    return { item, order, category };
  }

  it('retains the item and option history while hiding it from the editable menu', async () => {
    const { item } = await archiveFixture();
    const stored = await app.prisma.item.findUnique({ where: { id: item.id }, include: { optionGroups: { include: { options: true } } } });
    expect(stored).toMatchObject({ isAvailable: false, autoHiddenAt: null, archivedAt: expect.any(Date) });
    expect(stored?.optionGroups[0]?.options).toHaveLength(1);
    const menu = await inject('GET', '/api/v1/vendor/items', undefined, vendorToken);
    expect(menu.statusCode).toBe(200);
    expect(menu.json().data.some((row: { id: string }) => row.id === item.id)).toBe(false);
    const categories = await inject('GET', '/api/v1/vendor/categories', undefined, vendorToken);
    expect(categories.json().data.some((row: { items: Array<{ id: string }> }) => row.items.some((entry) => entry.id === item.id))).toBe(false);
  });

  it('an open order still cancels and restocks once without making an archived item saleable', async () => {
    const { item, order } = await archiveFixture();
    const response = await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, { reason: 'Fixture cancellation' }, customerToken);
    expect(response.statusCode, response.body).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
    expect(await app.prisma.item.findUnique({ where: { id: item.id } })).toMatchObject({ stockQuantity: 1, isAvailable: false, autoHiddenAt: null });
    expect(await app.prisma.stockMovement.count({ where: { orderId: order.id, itemId: item.id, reason: 'CANCEL_RESTOCK' } })).toBe(1);
    expect((await inject('POST', `/api/v1/customer/orders/${order.id}/cancel`, { reason: 'Fixture retry' }, customerToken)).statusCode).toBe(400);
  });

  it('a stale menu editor cannot restore an archived item to availability', async () => {
    const { item } = await archiveFixture();
    for (const suffix of ['', '/availability']) {
      const response = await inject('PUT', `/api/v1/vendor/items/${item.id}${suffix}`, { isAvailable: true }, vendorToken);
      expect(response.statusCode, response.body).toBe(404);
    }
    expect(await app.prisma.item.findUnique({ where: { id: item.id } })).toMatchObject({ isAvailable: false, archivedAt: expect.any(Date) });
  });

  it('every editor of a listing treats an archived one as gone, and a second delete finds nothing', async () => {
    const { item } = await archiveFixture();
    const attempts: Array<[string, () => ReturnType<typeof inject>]> = [
      ['adjust stock', () => inject('POST', `/api/v1/vendor/items/${item.id}/adjust`, { delta: 1, reason: 'RECEIVED' }, vendorToken)],
      ['add an option group', () => inject('POST', `/api/v1/vendor/items/${item.id}/option-groups`, { name: 'Extra' }, vendorToken)],
      ['read its category suggestions', () => inject('GET', `/api/v1/vendor/items/${item.id}/category-suggestions`, undefined, vendorToken)],
      ['close a date for it', () => inject('POST', '/api/v1/vendor/bookings/exceptions', { itemId: item.id, date: '2031-01-06' }, vendorToken)],
      ['delete it again', () => inject('DELETE', `/api/v1/vendor/items/${item.id}`, undefined, vendorToken)],
    ];
    for (const [what, attempt] of attempts) {
      const response = await attempt();
      expect(response.statusCode, `${what}: ${response.body}`).toBe(404);
    }
    expect(await app.prisma.item.findUnique({ where: { id: item.id } })).toMatchObject({ isAvailable: false, stockQuantity: 0, archivedAt: expect.any(Date) });
  });

  it('an archived listing is not on the storefront and cannot be added to a cart', async () => {
    const { item } = await archiveFixture();
    const store = await inject('GET', `/api/v1/customer/vendors/${vendorId}`, undefined, customerToken);
    expect(store.statusCode, store.body).toBe(200);
    expect(JSON.stringify(store.json().data)).not.toContain(item.id);
    const add = await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId: item.id, quantity: 1 }, customerToken);
    expect(add.statusCode).toBe(404);
  });

  it('the database itself refuses to make an archived listing available again', async () => {
    const { item } = await archiveFixture();
    await expect(app.prisma.item.update({ where: { id: item.id }, data: { isAvailable: true } })).rejects.toThrow(/items_archived_unavailable/);
    await expect(app.prisma.item.update({ where: { id: item.id }, data: { autoHiddenAt: new Date() } })).rejects.toThrow(/items_archived_unavailable/);
    expect(await app.prisma.item.findUnique({ where: { id: item.id } })).toMatchObject({ isAvailable: false, autoHiddenAt: null });
  });

  it('does not erase an existing booking when the service listing is deleted', async () => {
    const category = await app.prisma.category.create({ data: { vendorId, name: `Archive service ${nanoid(8)}` } });
    const item = await app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Booked fixture', basePrice: 500, fulfillment: 'APPOINTMENT' } });
    const held = await app.prisma.booking.create({ data: { itemId: item.id, customerId, slotStart: new Date(Date.now() + DAY), slotEnd: new Date(Date.now() + DAY + 1800000) } });
    expect((await inject('DELETE', `/api/v1/vendor/items/${item.id}`, undefined, vendorToken)).statusCode).toBe(200);
    expect(await app.prisma.booking.findUnique({ where: { id: held.id } })).toMatchObject({ itemId: item.id, status: 'RESERVED' });
    await booking.cancelBooking(held.id, customerId);
    expect((await app.prisma.booking.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('CANCELLED');
  });
});
