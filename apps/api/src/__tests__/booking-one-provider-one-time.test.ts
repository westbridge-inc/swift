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
import { hasRoom, peakOverlap } from '../modules/booking/availability';
import { isBookingExclusionViolation } from '../modules/booking/one-at-a-time';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';

// ---------------------------------------------------------------------------
// [BOOK-S1] ONE PROVIDER, ONE TIME. A business is the resource a booking
// takes, not the listing: a person who lists "Haircut" and "Beard trim" can be
// booked for one of them at 10:00, never both. Every live booking of the
// business is subtracted from every listing's picker; an overlap is refused
// per business (an advisory lock per business plus one overlap rule, and for a
// business that takes one booking at a time, a database exclusion constraint);
// a business may say it serves several at once (capacity). The listing's
// opening times may not overlap each other, and the gap after each booking and
// the minimum notice are the business's to set — an older app's save keeps
// them.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const RUN = wordFreeTag(6);
let app: FastifyInstance;
let svc: BookingService;
const userIds: string[] = [];
const vendorIds: string[] = [];
const tenantIds: string[] = [];
let seq = 0;

const EVERY_DAY = (start: string, end: string) => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start, end }));

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Book', lastName: `S${seq}`, roles, activeRole, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'book-s1', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

/** A Services business with two listings on one person's time: a 60-minute
 *  "Haircut" and a 30-minute "Beard trim", both open 09:00–17:00 every day. */
async function makeBusiness() {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vendorOwner = await app.prisma.vendorOwner.upsert({ where: { userId: owner.userId }, create: { userId: owner.userId }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name: `One Chair ${RUN} ${seq}`, slug: `one-chair-${RUN}-${nanoid(6).toLowerCase()}`,
      vendorType: 'SERVICE', phone: testPhone(), addressLine1: '1 Chair Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true, acceptingOrders: true,
    },
  });
  vendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Services', sortOrder: 0 } });
  const makeItem = (name: string, durationMinutes: number, slots = EVERY_DAY('09:00', '17:00')) =>
    app.prisma.item.create({
      data: {
        vendorId: vendor.id, categoryId: category.id, name, basePrice: 2000, isAvailable: true,
        fulfillment: 'APPOINTMENT', bookingConfig: { durationMinutes, slots },
      },
    });
  return { owner, vendor, haircut: await makeItem('Haircut', 60), beard: await makeItem('Beard trim', 30), makeItem };
}

const customer = () => makeUser(['CUSTOMER'], 'CUSTOMER');

function tomorrowParts() {
  const [y, m, d] = guyanaDayKey(new Date()).split('-').map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
}
function tomorrowKey() {
  const p = tomorrowParts();
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
/** Tomorrow at a Guyana wall-clock time, as the true instant. */
function at(hour: number, minute = 0): Date {
  const p = tomorrowParts();
  return instantOfGuyanaWallClock(new Date(Date.UTC(p.y, p.m - 1, p.d, hour, minute)));
}

const liveBookingsOf = (vendorId: string) =>
  app.prisma.booking.count({ where: { item: { vendorId }, status: { not: 'CANCELLED' } } });

const slotsOf = (itemId: string, token: string) =>
  app.inject({ method: 'GET', url: `/api/v1/customer/items/${itemId}/slots?date=${tomorrowKey()}`, headers: { authorization: `Bearer ${token}` } });

const putItem = (itemId: string, token: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/v1/vendor/items/${itemId}`, headers: { authorization: `Bearer ${token}` }, payload });

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
  svc = new BookingService(app.prisma);
});

afterAll(async () => {
  await app.prisma.booking.deleteMany({ where: { item: { vendorId: { in: vendorIds } } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
  await app.close();
});

describe('one business, one time — across its listings', () => {
  it('"Haircut" at 10:00 then "Beard trim" at 10:00 at the same business: the second is refused', async () => {
    const { vendor, haircut, beard } = await makeBusiness();
    const a = await customer();
    const b = await customer();
    await svc.reserveSlot(haircut.id, a.userId, at(10));
    await expect(svc.reserveSlot(beard.id, b.userId, at(10))).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
    expect(await liveBookingsOf(vendor.id)).toBe(1);
  });

  it('a 60-minute booking at 09:00 refuses another listing at 09:30 (an overlap, not only the same start)', async () => {
    const { haircut, beard } = await makeBusiness();
    await svc.reserveSlot(haircut.id, (await customer()).userId, at(9));
    await expect(svc.reserveSlot(beard.id, (await customer()).userId, at(9, 30))).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
  });

  it('control: back to back is fine (10:00 ends when 11:00 starts), and another business is untouched', async () => {
    const one = await makeBusiness();
    const other = await makeBusiness();
    await svc.reserveSlot(one.haircut.id, (await customer()).userId, at(10));
    await expect(svc.reserveSlot(one.beard.id, (await customer()).userId, at(11))).resolves.toMatchObject({ status: 'RESERVED' });
    await expect(svc.reserveSlot(one.beard.id, (await customer()).userId, at(9, 30))).resolves.toMatchObject({ status: 'RESERVED' });
    await expect(svc.reserveSlot(other.beard.id, (await customer()).userId, at(10))).resolves.toMatchObject({ status: 'RESERVED' });
  });

  it('a cancelled booking gives the business its time back for every listing', async () => {
    const { haircut, beard } = await makeBusiness();
    const a = await customer();
    const first = await svc.reserveSlot(haircut.id, a.userId, at(10));
    await expect(svc.reserveSlot(beard.id, (await customer()).userId, at(10, 30))).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    await svc.cancelBooking(first.id, a.userId);
    await expect(svc.reserveSlot(beard.id, (await customer()).userId, at(10, 30))).resolves.toMatchObject({ status: 'RESERVED' });
  });

  it('checkout refuses a time another listing of the business already holds (the fail-fast twin)', async () => {
    const { haircut, beard } = await makeBusiness();
    await svc.reserveSlot(haircut.id, (await customer()).userId, at(10));
    await expect(svc.assertSlotFree(beard.id, at(10, 30))).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
    await expect(svc.assertSlotFree(beard.id, at(11))).resolves.toBeUndefined();
  });

  it('PARALLEL, on real PostgreSQL: eight people race for overlapping times on two listings — exactly one wins', async () => {
    const { vendor, haircut, beard } = await makeBusiness();
    const racers = await Promise.all(Array.from({ length: 8 }, () => customer()));
    const results = await Promise.allSettled(racers.map((r, i) => {
      const [itemId, slot] = i % 2 === 0 ? [haircut.id, at(10)] : [beard.id, at(10, 30)];
      // Half of them reserve inside a caller's transaction, the way acceptance does.
      return i % 4 < 2
        ? svc.reserveSlot(itemId, r.userId, slot)
        : app.prisma.$transaction((tx) => svc.reserveSlot(itemId, r.userId, slot, undefined, tx));
    }));
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(7);
    for (const l of lost) expect(l.reason).toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
    expect(await liveBookingsOf(vendor.id)).toBe(1);
  });
});

describe('the picker subtracts every live booking of the business', () => {
  it('after "Haircut" is booked 10:00–11:00, "Beard trim" no longer offers 10:00 or 10:30, and still offers 09:30 and 11:00', async () => {
    const { haircut, beard } = await makeBusiness();
    const c = await customer();
    const before = (await slotsOf(beard.id, c.token)).json().data.slots as string[];
    expect(before).toEqual(expect.arrayContaining([at(9, 30), at(10), at(10, 30), at(11)].map((d) => d.toISOString())));
    await svc.reserveSlot(haircut.id, (await customer()).userId, at(10));
    const after = (await slotsOf(beard.id, c.token)).json().data.slots as string[];
    expect(after).not.toContain(at(10).toISOString());
    expect(after).not.toContain(at(10, 30).toISOString());
    expect(after).toContain(at(9, 30).toISOString());
    expect(after).toContain(at(11).toISOString());
    expect(after).toHaveLength(before.length - 2);
  });
});

describe('a business may serve several at once (capacity)', () => {
  it('capacity 2: two overlapping bookings are taken, a third that would make three at once is refused', async () => {
    const { owner, vendor, haircut, beard } = await makeBusiness();
    const set = await app.inject({ method: 'PUT', url: '/api/v1/vendor/profile', headers: { authorization: `Bearer ${owner.token}` }, payload: { bookingCapacity: 2 } });
    expect(set.statusCode).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).bookingCapacity).toBe(2);
    await svc.reserveSlot(haircut.id, (await customer()).userId, at(10));
    await svc.reserveSlot(beard.id, (await customer()).userId, at(10, 30));
    await expect(svc.reserveSlot(haircut.id, (await customer()).userId, at(10))).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    // A time that overlaps only one of them still has room.
    await expect(svc.reserveSlot(beard.id, (await customer()).userId, at(10))).resolves.toMatchObject({ status: 'RESERVED' });
    const rows = await app.prisma.booking.findMany({ where: { vendorId: vendor.id, status: { not: 'CANCELLED' } }, select: { exclusive: true } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.exclusive === false)).toBe(true);
  });

  it('PARALLEL with capacity 2: eight people race for overlapping times — exactly two win (the lock, not the exclusion, holds this)', async () => {
    const { vendor, haircut, beard } = await makeBusiness();
    await app.prisma.vendor.update({ where: { id: vendor.id }, data: { bookingCapacity: 2 } });
    const racers = await Promise.all(Array.from({ length: 8 }, () => customer()));
    const results = await Promise.allSettled(racers.map((r, i) => (i % 2 === 0
      ? svc.reserveSlot(haircut.id, r.userId, at(10))
      : app.prisma.$transaction((tx) => svc.reserveSlot(beard.id, r.userId, at(10, 30), undefined, tx)))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    for (const l of results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) expect(l.reason).toMatchObject({ code: 'SLOT_TAKEN' });
    expect(await liveBookingsOf(vendor.id)).toBe(2);
  });

  it('capacity 2: a move that would make three at once is refused, and the booking stays where it was', async () => {
    const { vendor, haircut, beard } = await makeBusiness();
    await app.prisma.vendor.update({ where: { id: vendor.id }, data: { bookingCapacity: 2 } });
    await svc.reserveSlot(haircut.id, (await customer()).userId, at(10));
    await svc.reserveSlot(beard.id, (await customer()).userId, at(10, 30));
    const a = await customer();
    const mine = await svc.reserveSlot(beard.id, a.userId, at(13));
    await expect(svc.rescheduleBooking(mine.id, at(10, 30), { customerId: a.userId })).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    expect((await app.prisma.booking.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('RESERVED');
    // Two at once is still fine.
    await expect(svc.rescheduleBooking(mine.id, at(9, 30), { customerId: a.userId })).resolves.toMatchObject({ moved: true });
  });

  it('the capacity is a small whole number: 0 and 21 are refused', async () => {
    const { owner } = await makeBusiness();
    for (const bookingCapacity of [0, 21, 1.5]) {
      const res = await app.inject({ method: 'PUT', url: '/api/v1/vendor/profile', headers: { authorization: `Bearer ${owner.token}` }, payload: { bookingCapacity } });
      expect(res.statusCode, String(bookingCapacity)).toBe(400);
    }
  });
});

describe('the database holds the line for a one-at-a-time business', () => {
  it('a write that skips the service cannot put two overlapping live bookings on one business', async () => {
    const { vendor, haircut, beard } = await makeBusiness();
    const a = await customer();
    await app.prisma.booking.create({ data: { itemId: haircut.id, vendorId: vendor.id, customerId: a.userId, slotStart: at(10), slotEnd: at(11) } });
    await expect(app.prisma.booking.create({
      data: { itemId: beard.id, vendorId: vendor.id, customerId: a.userId, slotStart: at(10, 30), slotEnd: at(11) },
    })).rejects.toThrow(/bookings_vendor_one_at_a_time/);
    // The service reads that refusal as "the slot was just taken", never as a server fault.
    const refusal = await app.prisma.booking.create({
      data: { itemId: beard.id, vendorId: vendor.id, customerId: a.userId, slotStart: at(10, 45), slotEnd: at(11, 15) },
    }).catch((e: unknown) => e);
    expect(isBookingExclusionViolation(refusal)).toBe(true);
    expect(isBookingExclusionViolation(new Error('connection reset'))).toBe(false);
    // A cancelled row never holds time.
    await expect(app.prisma.booking.create({
      data: { itemId: beard.id, vendorId: vendor.id, customerId: a.userId, slotStart: at(10, 30), slotEnd: at(11), status: 'CANCELLED' },
    })).resolves.toBeTruthy();
  });

  it('a booking names its listing\'s own business, or it is refused', async () => {
    const one = await makeBusiness();
    const other = await makeBusiness();
    const a = await customer();
    await expect(app.prisma.booking.create({
      data: { itemId: one.haircut.id, vendorId: other.vendor.id, customerId: a.userId, slotStart: at(12), slotEnd: at(13) },
    })).rejects.toThrow(/BOOK-S1/);
  });

  it('the service stamps the business on the row', async () => {
    const { vendor, beard } = await makeBusiness();
    const b = await svc.reserveSlot(beard.id, (await customer()).userId, at(14));
    expect(b).toMatchObject({ vendorId: vendor.id, exclusive: true });
  });
});

describe('moving a booking', () => {
  it('cannot move into the time another listing of the business holds', async () => {
    const { haircut, beard } = await makeBusiness();
    const a = await customer();
    await svc.reserveSlot(haircut.id, (await customer()).userId, at(10));
    const mine = await svc.reserveSlot(beard.id, a.userId, at(12));
    await expect(svc.rescheduleBooking(mine.id, at(10, 30), { customerId: a.userId })).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
    const still = await app.prisma.booking.findUniqueOrThrow({ where: { id: mine.id } });
    expect(still.status).toBe('RESERVED');
  });

  it('may move to a time that overlaps its own old time (it no longer holds that time once it moves)', async () => {
    const { makeItem } = await makeBusiness();
    // A stored listing from before overlapping opening times were refused: two grids, 09:00 and 09:30.
    const legacy = await makeItem('Colour', 60, [...EVERY_DAY('09:00', '17:00'), ...EVERY_DAY('09:30', '17:30')]);
    const a = await customer();
    const mine = await svc.reserveSlot(legacy.id, a.userId, at(10));
    const moved = await svc.rescheduleBooking(mine.id, at(10, 30), { customerId: a.userId });
    expect(moved.moved).toBe(true);
    expect(moved.booking.slotStart.toISOString()).toBe(at(10, 30).toISOString());
  });
});

describe('the listing\'s booking settings', () => {
  it('two opening times on the same day that overlap are refused (400); the same times on different days are fine', async () => {
    const { owner, haircut } = await makeBusiness();
    const overlapping = await putItem(haircut.id, owner.token, {
      bookingConfig: { durationMinutes: 60, slots: [{ dayOfWeek: 1, start: '09:00', end: '12:00' }, { dayOfWeek: 1, start: '09:30', end: '12:30' }] },
    });
    expect(overlapping.statusCode).toBe(400);
    const stored = await app.prisma.item.findUniqueOrThrow({ where: { id: haircut.id } });
    expect((stored.bookingConfig as { slots: unknown[] }).slots).toHaveLength(7);
    const splitDays = await putItem(haircut.id, owner.token, {
      bookingConfig: { durationMinutes: 60, slots: [{ dayOfWeek: 1, start: '09:00', end: '12:00' }, { dayOfWeek: 2, start: '09:30', end: '12:30' }, { dayOfWeek: 1, start: '13:00', end: '17:00' }] },
    });
    expect(splitDays.statusCode).toBe(200);
  });

  it('accepts the gap after each booking and the minimum notice; an older app\'s save (without them) keeps them', async () => {
    const { owner, beard } = await makeBusiness();
    const set = await putItem(beard.id, owner.token, {
      bookingConfig: { durationMinutes: 30, slots: EVERY_DAY('09:00', '17:00'), serviceMode: 'AT_BUSINESS', bufferMinutes: 15, minNoticeMinutes: 120 },
    });
    expect(set.statusCode).toBe(200);
    const read = async () => (await app.prisma.item.findUniqueOrThrow({ where: { id: beard.id } })).bookingConfig as Record<string, unknown>;
    expect(await read()).toMatchObject({ bufferMinutes: 15, minNoticeMinutes: 120 });
    // The build-9 editor sends duration, windows and mode only.
    const legacySave = await putItem(beard.id, owner.token, {
      bookingConfig: { durationMinutes: 45, slots: EVERY_DAY('10:00', '16:00'), serviceMode: 'AT_BUSINESS' },
    });
    expect(legacySave.statusCode).toBe(200);
    expect(await read()).toMatchObject({ durationMinutes: 45, bufferMinutes: 15, minNoticeMinutes: 120 });
    // An explicit 0 clears the gap; the notice stays.
    await putItem(beard.id, owner.token, { bookingConfig: { durationMinutes: 45, slots: EVERY_DAY('10:00', '16:00'), bufferMinutes: 0 } });
    expect(await read()).toMatchObject({ bufferMinutes: 0, minNoticeMinutes: 120 });
  });

  it('the gap after a booking holds for the business\'s other listings too', async () => {
    const { owner, haircut, beard } = await makeBusiness();
    await putItem(haircut.id, owner.token, { bookingConfig: { durationMinutes: 60, slots: EVERY_DAY('09:00', '17:00'), bufferMinutes: 30 } });
    await svc.reserveSlot(haircut.id, (await customer()).userId, at(9));
    // 09:00–10:00 plus a 30-minute gap: the beard trim at 10:00 waits for 10:30.
    await expect(svc.reserveSlot(beard.id, (await customer()).userId, at(10))).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    await expect(svc.reserveSlot(beard.id, (await customer()).userId, at(10, 30))).resolves.toMatchObject({ status: 'RESERVED' });
    // And the beard trim's picker says the same.
    const slots = (await slotsOf(beard.id, owner.token)).json().data.slots as string[];
    expect(slots).not.toContain(at(10).toISOString());
    expect(slots).toContain(at(11).toISOString());
  });
});

describe('the wall on the row', () => {
  it('a booking carries its business\'s tenant, derived by the database from the business', async () => {
    const tenantId = `book-s1-${RUN}`;
    const item = await runWithoutTenant(async () => {
      await app.prisma.tenant.create({ data: { id: tenantId, name: 'Booking fiction', slug: tenantId, kind: 'REVIEW' } });
      tenantIds.push(tenantId);
      const ownerUser = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'T', lastName: 'W', activeRole: 'VENDOR_OWNER', tenantId, isSynthetic: true } });
      userIds.push(ownerUser.id);
      const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
      const vendor = await app.prisma.vendor.create({ data: {
        tenantId, isSynthetic: true, ownerId: vo.id, name: `Fiction Chair ${RUN}`, slug: `fiction-chair-${RUN}`, vendorType: 'SERVICE', phone: testPhone(),
        addressLine1: '1', city: 'Georgetown', region: 'D', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
      } });
      vendorIds.push(vendor.id);
      const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, tenantId, name: 'Services' } });
      return app.prisma.item.create({ data: {
        vendorId: vendor.id, tenantId, categoryId: cat.id, name: 'Fiction cut', basePrice: 1000, isAvailable: true,
        fulfillment: 'APPOINTMENT', bookingConfig: { durationMinutes: 30, slots: EVERY_DAY('09:00', '17:00') },
      } });
    }, 'book-s1-lineage-test');
    const shopper = await customer();
    // Work with no tenant bound (a job's): the row is written unstamped and the database derives the tenant.
    const derived = await runWithoutTenant(() => svc.reserveSlot(item.id, shopper.userId, at(15)), 'book-s1-lineage-test');
    expect(derived.tenantId).toBe(tenantId);
    // A request of that tenant: the wall stamps it, and it agrees with the business.
    const stamped = await runWithTenant(tenantId, () => svc.reserveSlot(item.id, shopper.userId, at(16)));
    expect(stamped.tenantId).toBe(tenantId);
    // The other tenant's request cannot even see the listing.
    await expect(runWithTenant('swift-default', () => svc.reserveSlot(item.id, shopper.userId, at(12)))).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the one overlap rule (pure)', () => {
  const t = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 29, h, m));
  const span = (a: Date, b: Date) => ({ start: a, end: b });
  it('back to back never stacks: [10, 11) and [11, 12) are one at a time', () => {
    const busy = [span(t(10), t(11)), span(t(11), t(12))];
    expect(peakOverlap(span(t(10, 30), t(11, 30)), busy)).toBe(1);
    expect(hasRoom(span(t(10, 30), t(11, 30)), busy, 2)).toBe(true);
    expect(hasRoom(span(t(10, 30), t(11, 30)), busy, 1)).toBe(false);
    expect(hasRoom(span(t(9), t(10)), busy, 1)).toBe(true);
  });
  it('counts what is held at one moment, not every booking the span touches', () => {
    const busy = [span(t(9), t(10)), span(t(9, 30), t(10, 30)), span(t(11), t(12))];
    expect(peakOverlap(span(t(9), t(12)), busy)).toBe(2);
    expect(hasRoom(span(t(9), t(12)), busy, 3)).toBe(true);
    expect(hasRoom(span(t(9), t(12)), busy, 2)).toBe(false);
  });
});
