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
      isPhoneVerified: true,
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

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token?: string) {
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
function nextUtc(dayOfWeek: number, hours: number, minutes: number): Date {
  const d = new Date(Date.now() + DAY);
  d.setUTCHours(hours, minutes, 0, 0);
  while (d.getUTCDay() !== dayOfWeek || d.getTime() <= Date.now()) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
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
  const slot = nextUtc(5, 10, 0); // next Friday 10:00 UTC

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
    const sunday = nextUtc(0, 10, 0);
    await expect(booking.reserveSlot(serviceItemId, customerId, sunday)).rejects.toMatchObject({ code: 'SLOT_OUTSIDE_HOURS' });

    const misaligned = nextUtc(6, 10, 7);
    await expect(booking.reserveSlot(serviceItemId, customerId, misaligned)).rejects.toMatchObject({ code: 'SLOT_OUTSIDE_HOURS' });

    await expect(
      booking.reserveSlot(serviceItemId, customerId, new Date(Date.now() - DAY)),
    ).rejects.toMatchObject({ code: 'SLOT_IN_PAST' });

    const burger = await app.prisma.item.findFirstOrThrow({ where: { vendorId, name: 'CSV Burger' } });
    await expect(
      booking.reserveSlot(burger.id, customerId, nextUtc(6, 11, 0)),
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
