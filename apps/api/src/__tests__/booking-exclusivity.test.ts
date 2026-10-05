import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { BookingService } from '../modules/booking/booking.service';
import { AppError } from '../utils/errors';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';

// The founder's question, answered as tests: when one person books a time,
// nobody else can hold the same time — not by UI politeness but by the live
// partial unique (bookings_item_slot_live_key). And the slot they took stops
// being OFFERED to everyone else.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });

const userIds: string[] = [];
const vendorIds: string[] = [];
const itemIds: string[] = [];
let seq = 0;
const phoneBase = 592_012_000_000 + Math.floor(Math.random() * 8_000_000);

async function makeCustomer() {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Slot', lastName: `U${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
  });
  userIds.push(user.id);
  return user;
}

/** A SERVICE listing bookable every weekday 09:00–17:00 in 60-minute slots. */
async function makeBookableItem() {
  seq += 1;
  const owner = await makeCustomer();
  const vOwner = await prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: vOwner.id, name: `Salon ${seq}`, slug: `salon-${nanoid(8).toLowerCase()}`,
      vendorType: 'SERVICE', phone: `+${phoneBase + 700_000 + seq}`,
      addressLine1: '8 Slot Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const menuCat = await prisma.category.create({ data: { vendorId: vendor.id, name: 'Appointments', sortOrder: 1 } });
  const item = await prisma.item.create({
    data: {
      vendorId: vendor.id, categoryId: menuCat.id, name: `Cut & Style ${seq}`, basePrice: 3000,
      fulfillment: 'APPOINTMENT', isAvailable: true,
      bookingConfig: {
        durationMinutes: 60,
        slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '09:00', end: '17:00' })),
      } as never,
    },
  });
  itemIds.push(item.id);
  return item;
}

/** Tomorrow at a Guyana wall-clock hour, as the TRUE instant the slot happens
 *  (10:00 local is 14:00Z) — inside the 09:00–17:00 window, always in the
 *  future, whatever zone the host runs in. */
function tomorrowAt(hour: number): Date {
  const [y, m, d] = guyanaDayKey(new Date()).split('-').map(Number);
  return instantOfGuyanaWallClock(new Date(Date.UTC(y!, m! - 1, d! + 1, hour)));
}
const tomorrowAt10 = () => tomorrowAt(10);

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.booking.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('one slot, one person — the exclusivity law', () => {
  it('two SIMULTANEOUS reservations of the same slot resolve to exactly one winner', async () => {
    const svc = new BookingService(prisma);
    const item = await makeBookableItem();
    const a = await makeCustomer();
    const b = await makeCustomer();
    const slot = tomorrowAt10();

    const results = await Promise.allSettled([
      svc.reserveSlot(item.id, a.id, slot),
      svc.reserveSlot(item.id, b.id, slot),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(((lost[0] as PromiseRejectedResult).reason as AppError).message).toContain('just taken');

    // The database holds exactly ONE live row for that slot.
    const rows = await prisma.booking.count({ where: { itemId: item.id, slotStart: slot, status: { not: 'CANCELLED' } } });
    expect(rows).toBe(1);
  });

  it('a cancelled booking frees the slot for the next person', async () => {
    const svc = new BookingService(prisma);
    const item = await makeBookableItem();
    const a = await makeCustomer();
    const b = await makeCustomer();
    const slot = tomorrowAt10();

    const first = await svc.reserveSlot(item.id, a.id, slot);
    await expect(svc.reserveSlot(item.id, b.id, slot)).rejects.toThrow('just taken');
    await svc.cancelBooking(first.id, a.id);
    const second = await svc.reserveSlot(item.id, b.id, slot);
    expect(second.customerId).toBe(b.id);
  });

  it('a booked slot stops being OFFERED — the picker never shows it to others', async () => {
    const svc = new BookingService(prisma);
    const item = await makeBookableItem();
    const a = await makeCustomer();
    const slot = tomorrowAt10();
    await svc.reserveSlot(item.id, a.id, slot);

    // The same candidate math the customer slots endpoint runs: generate the
    // day's aligned starts on the slot's GUYANA date as true instants,
    // subtract non-cancelled bookings.
    const [y, m, d] = guyanaDayKey(slot).split('-').map(Number);
    const candidates: Date[] = [];
    for (let t = 9 * 60; t + 60 <= 17 * 60; t += 60) {
      candidates.push(instantOfGuyanaWallClock(new Date(Date.UTC(y!, m! - 1, d!, Math.floor(t / 60), t % 60))));
    }
    const taken = new Set(
      (await prisma.booking.findMany({
        where: { itemId: item.id, status: { not: 'CANCELLED' }, slotStart: { in: candidates } },
        select: { slotStart: true },
      })).map((r) => r.slotStart.toISOString()),
    );
    const offered = candidates.filter((c) => !taken.has(c.toISOString()));
    expect(offered.map((o) => o.toISOString())).not.toContain(slot.toISOString());
    expect(offered).toHaveLength(candidates.length - 1);
  });

  it('slots outside the provider-set windows are refused outright', async () => {
    const svc = new BookingService(prisma);
    const item = await makeBookableItem();
    const a = await makeCustomer();
    const late = tomorrowAt(20); // 20:00 in Guyana — outside 09:00–17:00
    await expect(svc.reserveSlot(item.id, a.id, late)).rejects.toThrow('not offered');
  });
});
