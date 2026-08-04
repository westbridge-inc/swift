import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { BookingService } from '../modules/booking/booking.service';
import { computeDaySlots, slotFitsConfig, strideMinutes } from '../modules/booking/availability';

// ---------------------------------------------------------------------------
// ONE-SLOT-ONE-PERSON — the availability engine (spec 2.1/2.5, SCH-A/E/F):
// windows MINUS exceptions MINUS bookings, honoring buffers + lead time, in
// ONE computation consumed by the picker endpoint AND reservation validation
// (a stale picker can never book into a blocked window). Blocks never leak a
// reason. The timezone convention is asserted across the boundary.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let bookings: BookingService;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_830_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Avl', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'avl-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeServiceVendor() {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vendorOwner = await app.prisma.vendorOwner.upsert({ where: { userId: owner.userId }, create: { userId: owner.userId }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id,
      name: `Avl Vendor ${seq}`, slug: `avl-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'SERVICE', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Window Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true, acceptingOrders: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Services', sortOrder: 0 } });
  const makeItem = (name: string) =>
    app.prisma.item.create({
      data: {
        vendorId: vendor.id, categoryId: category.id,
        name, basePrice: 3000, isAvailable: true,
        fulfillment: 'APPOINTMENT',
        bookingConfig: {
          durationMinutes: 60,
          slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '09:00', end: '17:00' })),
        },
      },
    });
  return { owner, vendor, itemA: await makeItem('Haircut'), itemB: await makeItem('Shave') };
}

function tomorrowParts() {
  const d = new Date(Date.now() + DAY);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
function tomorrowStr() {
  const p = tomorrowParts();
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
function tomorrowAt(hour: number, minute = 0): Date {
  const p = tomorrowParts();
  return new Date(Date.UTC(p.y, p.m - 1, p.d, hour, minute));
}

const getSlots = (itemId: string, token: string) =>
  app.inject({
    method: 'GET', url: `/api/v1/customer/items/${itemId}/slots?date=${tomorrowStr()}`,
    headers: { authorization: `Bearer ${token}` },
  });

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  await app.prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "bookings_item_slot_live_key" ON "bookings"("itemId", "slotStart") WHERE status <> 'CANCELLED'`,
  );
  bookings = new BookingService(app.prisma);
});

afterAll(async () => {
  await app.prisma.bookingException.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.booking.deleteMany({ where: { item: { vendorId: { in: createdVendorIds } } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('SCH-E: buffers + lead time (pure math table)', () => {
  const base = { itemId: 'i1', exceptions: [], takenStarts: [], now: new Date('2026-08-04T00:00:00Z') };
  const cfg = (over: object) => ({
    durationMinutes: 60,
    slots: [{ dayOfWeek: 3, start: '09:00', end: '12:00' }], // 2026-08-05 is a Wednesday
    ...over,
  });
  const day = { year: 2026, month: 8, day: 5 };

  it('no buffer: aligned hourly starts fill the window', () => {
    const slots = computeDaySlots({ ...base, ...day, config: cfg({}) });
    expect(slots.map((s) => s.toISOString())).toEqual([
      '2026-08-05T09:00:00.000Z', '2026-08-05T10:00:00.000Z', '2026-08-05T11:00:00.000Z',
    ]);
  });

  it('bufferMinutes widens the stride and the END still fits the service', () => {
    const slots = computeDaySlots({ ...base, ...day, config: cfg({ bufferMinutes: 15 }) });
    expect(slots.map((s) => s.toISOString())).toEqual([
      '2026-08-05T09:00:00.000Z', '2026-08-05T10:15:00.000Z', // 11:30 would end 12:30 — refused
    ]);
    expect(strideMinutes(cfg({ bufferMinutes: 15 }) as never)).toBe(75);
  });

  it('minNoticeMinutes hides too-soon slots; reservation refuses them too', () => {
    const now = new Date('2026-08-05T08:30:00Z');
    const slots = computeDaySlots({ ...base, ...day, now, config: cfg({ minNoticeMinutes: 120 }) });
    expect(slots.map((s) => s.toISOString())).toEqual(['2026-08-05T11:00:00.000Z']); // 09:00+10:00 < now+2h
    expect(slotFitsConfig(new Date('2026-08-05T09:00:00Z'), cfg({ minNoticeMinutes: 120 }) as never, now)).toBe('TOO_SOON');
    expect(slotFitsConfig(new Date('2026-08-05T11:00:00Z'), cfg({ minNoticeMinutes: 120 }) as never, now)).toBe('OK');
  });

  it('buffer alignment is enforced at reservation (off-grid start refused)', () => {
    expect(slotFitsConfig(new Date('2026-08-05T10:00:00Z'), cfg({ bufferMinutes: 15 }) as never, base.now)).toBe('OUTSIDE');
    expect(slotFitsConfig(new Date('2026-08-05T10:15:00Z'), cfg({ bufferMinutes: 15 }) as never, base.now)).toBe('OK');
  });
});

describe('SCH-A: exceptions subtract — picker AND reservation, no leakage', () => {
  it('full-day block empties the picker; window block hides exactly its span; delete restores', async () => {
    const { owner, itemA } = await makeServiceVendor();
    const auth = { authorization: `Bearer ${owner.token}` };

    const before = (await getSlots(itemA.id, owner.token)).json().data.slots as string[];
    expect(before.length).toBe(8); // 09..16 hourly

    // Afternoon window block 13:00–17:00 ("funeral in two taps").
    const block = await app.inject({
      method: 'POST', url: '/api/v1/vendor/bookings/exceptions', headers: auth,
      payload: { date: tomorrowStr(), start: '13:00', end: '17:00', reason: 'Funeral' },
    });
    expect(block.statusCode).toBe(200);

    const afternoon = (await getSlots(itemA.id, owner.token)).json().data.slots as string[];
    expect(afternoon.length).toBe(4); // 09,10,11,12 remain
    expect(afternoon.every((s) => new Date(s).getUTCHours() < 13)).toBe(true);

    // A stale picker cannot book into the block — same face as SLOT_TAKEN,
    // reason never leaks.
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await expect(bookings.reserveSlot(itemA.id, customer.userId, tomorrowAt(14))).rejects.toMatchObject({
      statusCode: 409, code: 'SLOT_TAKEN',
    });

    // Full-day block on top → nothing offerable.
    await app.inject({ method: 'POST', url: '/api/v1/vendor/bookings/exceptions', headers: auth, payload: { date: tomorrowStr() } });
    expect(((await getSlots(itemA.id, owner.token)).json().data.slots as string[]).length).toBe(0);

    // Unblock everything → the day comes back whole.
    const list = (await app.inject({ method: 'GET', url: '/api/v1/vendor/bookings/exceptions', headers: auth })).json().data as { id: string }[];
    for (const ex of list) {
      const del = await app.inject({ method: 'DELETE', url: `/api/v1/vendor/bookings/exceptions/${ex.id}`, headers: auth });
      expect(del.statusCode).toBe(200);
    }
    expect(((await getSlots(itemA.id, owner.token)).json().data.slots as string[]).length).toBe(8);
  });

  it('whole-vendor block hits every listing; listing block hits only its own', async () => {
    const { owner, itemA, itemB } = await makeServiceVendor();
    const auth = { authorization: `Bearer ${owner.token}` };

    // Listing-specific morning block on A only.
    await app.inject({
      method: 'POST', url: '/api/v1/vendor/bookings/exceptions', headers: auth,
      payload: { date: tomorrowStr(), start: '09:00', end: '12:00', itemId: itemA.id },
    });
    const a = (await getSlots(itemA.id, owner.token)).json().data.slots as string[];
    const b = (await getSlots(itemB.id, owner.token)).json().data.slots as string[];
    expect(a.length).toBe(5); // 12..16
    expect(b.length).toBe(8); // untouched

    // Whole-vendor full-day block → both listings empty.
    await app.inject({ method: 'POST', url: '/api/v1/vendor/bookings/exceptions', headers: auth, payload: { date: tomorrowStr() } });
    expect(((await getSlots(itemA.id, owner.token)).json().data.slots as string[]).length).toBe(0);
    expect(((await getSlots(itemB.id, owner.token)).json().data.slots as string[]).length).toBe(0);
  });

  it('a foreign vendor cannot block or read another store\'s calendar', async () => {
    const shopA = await makeServiceVendor();
    const shopB = await makeServiceVendor();
    // B blocks with A's item id → 404 (listing not in B's store).
    const res = await app.inject({
      method: 'POST', url: '/api/v1/vendor/bookings/exceptions',
      headers: { authorization: `Bearer ${shopB.owner.token}` },
      payload: { date: tomorrowStr(), itemId: shopA.itemA.id },
    });
    expect(res.statusCode).toBe(404);
    // A's slots unaffected by anything B does.
    expect(((await getSlots(shopA.itemA.id, shopA.owner.token)).json().data.slots as string[]).length).toBe(8);
  });
});

describe('SCH-F: the timezone convention holds across the boundary', () => {
  it('vendor-entered 09:00 ≡ the first offered slot\'s UTC face ≡ the stored booking instant', async () => {
    const { itemA, owner } = await makeServiceVendor();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');

    const first = ((await getSlots(itemA.id, owner.token)).json().data.slots as string[])[0]!;
    const instant = new Date(first);
    expect(instant.getUTCHours()).toBe(9); // the vendor's "09:00", verbatim on the UTC face
    expect(instant.getUTCMinutes()).toBe(0);

    const booking = await bookings.reserveSlot(itemA.id, customer.userId, instant);
    expect(booking.slotStart.toISOString()).toBe(first); // stored instant is byte-identical
    // The mobile picker formats with timeZone:'UTC' (CartScreen fmtSlot) —
    // rendering this instant shows 9:00 to the customer. One convention,
    // vendor-typed to customer-shown, zero offsets anywhere.
  });
});
