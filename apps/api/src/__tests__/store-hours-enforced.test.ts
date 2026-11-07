import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { wordFreeTag } from './helpers/fixture-ids';
import { guyanaDayKey, guyanaWallClockParts, instantOfGuyanaWallClock } from '../utils/guyana-day';
import {
  clockMinutes, hoursAllowNow, nextOpeningWords, ownStoreHoursView, storeOpenNow, type HoursRow,
} from '../modules/vendor/store-hours';

// ---------------------------------------------------------------------------
// [STORE-HOURS · owner 6 Nov 2026] "The days in dashboard I mark it's closed,
// orders still come through, vs when I click close store it actually stops
// taking orders."
//
// Open now = the manual switch AND (no hours set, OR the Guyana time now is
// inside today's hours, or last night's hours that run past midnight, and today
// is not marked closed). Checkout refuses outside it (VENDOR_CLOSED, the code
// build-12 phones already handle); every list that says "open" agrees with it.
// A booking-only cart keeps its exception (a booking is for a later time).
//
// The rule is pure (fixed instants below); the routes run on real PostgreSQL,
// with each store's hours set around the real Guyana time now.
// ---------------------------------------------------------------------------

/** The TRUE instant of a Guyana wall-clock time. */
const gy = (y: number, m: number, d: number, hour: number, minute = 0) => instantOfGuyanaWallClock(new Date(Date.UTC(y, m - 1, d, hour, minute)));
// 8 Nov 2026 is a Sunday, 9 Nov a Monday, 14 Nov a Saturday, 15 Nov a Sunday.
const SUN = 0; const MON = 1; const SAT = 6;
const week = (day: (dow: number) => Omit<HoursRow, 'dayOfWeek'>): HoursRow[] => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, ...day(dayOfWeek) }));
const open = (openTime: string, closeTime: string) => ({ openTime, closeTime, isClosed: false });
const CLOSED = { openTime: '', closeTime: '', isClosed: true };

describe('[STORE-HOURS] the rule, at fixed Guyana times', () => {
  it('the instants are the days these tests say they are', () => {
    expect(guyanaWallClockParts(gy(2026, 11, 8, 12)).dayOfWeek).toBe(SUN);
    expect(guyanaWallClockParts(gy(2026, 11, 9, 12)).dayOfWeek).toBe(MON);
    expect(guyanaWallClockParts(gy(2026, 11, 14, 12)).dayOfWeek).toBe(SAT);
  });

  it('no hours set: open at any time (unchanged)', () => {
    for (const h of [0, 3, 12, 23]) expect(hoursAllowNow([], gy(2026, 11, 9, h))).toBe(true);
  });

  it('a day marked closed is closed all day; the same time on an open day is open', () => {
    const hours = week((d) => (d === MON ? CLOSED : open('08:00', '22:00')));
    expect(hoursAllowNow(hours, gy(2026, 11, 9, 12))).toBe(false);
    expect(hoursAllowNow(hours, gy(2026, 11, 10, 12))).toBe(true);
  });

  it('outside the hours is closed, inside is open; opens on the minute, closes on the minute', () => {
    const hours = week(() => open('08:00', '22:00'));
    expect(hoursAllowNow(hours, gy(2026, 11, 9, 7, 59))).toBe(false);
    expect(hoursAllowNow(hours, gy(2026, 11, 9, 8, 0))).toBe(true);
    expect(hoursAllowNow(hours, gy(2026, 11, 9, 21, 59))).toBe(true);
    expect(hoursAllowNow(hours, gy(2026, 11, 9, 22, 0))).toBe(false);
    expect(hoursAllowNow(hours, gy(2026, 11, 9, 2, 0))).toBe(false);
  });

  it('hours that cross midnight: Saturday 18:00-02:00 is open at 01:00 on Sunday, even with Sunday closed', () => {
    const hours = week((d) => (d === SAT ? open('18:00', '02:00') : d === SUN ? CLOSED : open('09:00', '17:00')));
    expect(hoursAllowNow(hours, gy(2026, 11, 14, 23, 30))).toBe(true); // Saturday night
    expect(hoursAllowNow(hours, gy(2026, 11, 15, 1, 0))).toBe(true); // Sunday 01:00, Saturday's shift
    expect(hoursAllowNow(hours, gy(2026, 11, 15, 2, 0))).toBe(false); // Saturday's shift has ended
    expect(hoursAllowNow(hours, gy(2026, 11, 15, 12, 0))).toBe(false); // Sunday is closed
    expect(hoursAllowNow(hours, gy(2026, 11, 14, 17, 0))).toBe(false); // Saturday before it opens
  });

  it('a missing day (other days set) is closed, as the store page says "Closed today"', () => {
    const hours = week(() => open('08:00', '22:00')).filter((h) => h.dayOfWeek !== MON);
    expect(hoursAllowNow(hours, gy(2026, 11, 9, 12))).toBe(false);
  });

  it('typed times are read leniently; a time that cannot be read never closes the store (the switch decides)', () => {
    expect(clockMinutes('08:00')).toBe(480);
    expect(clockMinutes('8:30')).toBe(510);
    expect(clockMinutes('8pm')).toBe(1200);
    expect(clockMinutes('8:15 PM')).toBe(1215);
    expect(clockMinutes('12am')).toBe(0);
    expect(clockMinutes('12 p.m.')).toBe(720);
    expect(clockMinutes('20.15')).toBe(1215);
    expect(clockMinutes('24:00')).toBe(1440);
    for (const bad of ['', '8ish', '25:00', '13pm', '7:75']) expect(clockMinutes(bad), bad).toBeNull();
    const unreadable = week(() => open('morning', 'late'));
    expect(hoursAllowNow(unreadable, gy(2026, 11, 9, 3))).toBe(true);
    // 00:00-00:00 is round the clock.
    expect(hoursAllowNow(week(() => open('00:00', '00:00')), gy(2026, 11, 9, 3))).toBe(true);
  });

  it('times typed without am/pm are read the way that never closes a store early', () => {
    // "8:00 - 10:00" on the phone's free-text editor may mean 8 am to 10 pm: it is open at 9 pm.
    expect(hoursAllowNow(week(() => open('8:00', '10:00')), gy(2026, 11, 9, 21))).toBe(true);
    expect(hoursAllowNow(week(() => open('8:00', '10:00')), gy(2026, 11, 9, 23))).toBe(false);
    // "8:00 - 12:00" may mean 8 am to midnight.
    expect(hoursAllowNow(week(() => open('8:00', '12:00')), gy(2026, 11, 9, 23, 30))).toBe(true);
    // "10:00 - 2:00" is longer as typed (10 am to 2 am) than as 10 am to 2 pm: open at 1 am.
    expect(hoursAllowNow(week(() => open('10:00', '2:00')), gy(2026, 11, 10, 1))).toBe(true);
    // am/pm said, or a closing time after noon, is read exactly as written.
    expect(hoursAllowNow(week(() => open('8:00 am', '10:00 am')), gy(2026, 11, 9, 21))).toBe(false);
    expect(hoursAllowNow(week(() => open('08:00', '22:00')), gy(2026, 11, 9, 22, 30))).toBe(false);
    expect(hoursAllowNow(week(() => open('18:00', '02:00')), gy(2026, 11, 9, 12))).toBe(false);
  });

  it('says when it opens next', () => {
    const hours = week((d) => (d === MON ? CLOSED : open('08:00', '22:00')));
    expect(nextOpeningWords(hours, gy(2026, 11, 8, 6))).toBe('today at 8:00 am'); // Sunday 06:00
    expect(nextOpeningWords(hours, gy(2026, 11, 8, 23))).toBe('on Tuesday at 8:00 am'); // Sunday night, Monday closed
    expect(nextOpeningWords(hours, gy(2026, 11, 10, 23))).toBe('tomorrow at 8:00 am');
    expect(nextOpeningWords(week(() => CLOSED), gy(2026, 11, 9, 12))).toBeNull();
  });

  it('THE rule: the switch AND the hours; the App Review fiction keeps the switch alone', () => {
    const hours = week(() => open('08:00', '22:00'));
    const night = gy(2026, 11, 9, 23);
    const noon = gy(2026, 11, 9, 12);
    expect(storeOpenNow({ isCurrentlyOpen: true }, hours, noon)).toBe(true);
    expect(storeOpenNow({ isCurrentlyOpen: false }, hours, noon)).toBe(false);
    expect(storeOpenNow({ isCurrentlyOpen: true }, hours, night)).toBe(false);
    expect(storeOpenNow({ isCurrentlyOpen: true, isSynthetic: true }, hours, night)).toBe(true);
    expect(storeOpenNow({ isCurrentlyOpen: false, isSynthetic: true }, hours, noon)).toBe(false);
    expect(ownStoreHoursView({ isCurrentlyOpen: true, operatingHours: hours }, night)).toEqual({ closedByHoursNow: true, opensNext: 'tomorrow at 8:00 am' });
    expect(ownStoreHoursView({ isCurrentlyOpen: true, operatingHours: hours }, noon)).toEqual({ closedByHoursNow: false, opensNext: null });
    // The switch off is the switch's own words, not the hours'.
    expect(ownStoreHoursView({ isCurrentlyOpen: false, operatingHours: hours }, night)).toEqual({ closedByHoursNow: false, opensNext: null });
  });
});

// ---------------------------------------------------------------------------
// Routes on real PostgreSQL.
// ---------------------------------------------------------------------------

// This file's fixture block (+5920871nnn): no other file uses it.
const PHONE_PREFIX = '+5920871';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let seq = 0;
const userIds: string[] = [];
const vendorIds: string[] = [];
type Actor = { userId: string; token: string };

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
/** Minutes after midnight, Guyana time, now. */
const nowMinutes = () => { const p = guyanaWallClockParts(new Date()); return p.hour * 60 + p.minute; };
const today = () => guyanaWallClockParts(new Date()).dayOfWeek;
/**
 * Hours set around the real time now, with three hours of margin either side, and the SAME on every day the run could
 * reach: a window that would pass midnight runs past it (yesterday's hours cover the small hours), and a closed day is
 * today AND tomorrow, so a run at 23:59 or one that crosses midnight reads the same answer.
 */
const FIXTURE_HOURS = {
  closedToday: () => { const d = today(); return week((day) => (day === d || day === (d + 1) % 7 ? CLOSED : open('00:00', '23:59'))); },
  outside: () => { const t = nowMinutes(); return week(() => open(hhmm((t + 180) % 1440), hhmm((t + 360) % 1440))); },
  inside: () => { const t = nowMinutes(); return week(() => open(hhmm((t + 1260) % 1440), hhmm((t + 180) % 1440))); },
  none: () => [] as HoursRow[],
};

function tomorrowTen(): Date {
  const [y, m, d] = guyanaDayKey(new Date()).split('-').map(Number);
  return instantOfGuyanaWallClock(new Date(Date.UTC(y!, m! - 1, d! + 1, 10, 0)));
}

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `HRS-${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: `hrs-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}
const customer = (name = 'Cy') => makeUser(name, ['CUSTOMER'], 'CUSTOMER');

/** A live store with one goods item and one bookable listing (09:00-17:00 every day), and these weekly hours. */
async function makeStore(name: string, hours: HoursRow[], flags: Partial<{ isCurrentlyOpen: boolean }> = {}) {
  const owner = await makeUser(`${name}Owner`, ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const v = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `HRS ${name} ${wordFreeTag(6)}`, slug: `hrs-${name.toLowerCase()}-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
      phone: `${PHONE_PREFIX}${String(900 - vendorIds.length).padStart(3, '0')}`, addressLine1: '9 Clock Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', isVerified: true,
      isCurrentlyOpen: flags.isCurrentlyOpen ?? true, acceptingOrders: true,
      operatingHours: { create: hours },
    },
  });
  vendorIds.push(v.id);
  const category = await app.prisma.category.create({ data: { vendorId: v.id, name: 'Counter', sortOrder: 0 } });
  const goods = await app.prisma.item.create({ data: { vendorId: v.id, categoryId: category.id, name: `HRS ${name} Bake`, basePrice: 500, isAvailable: true } });
  const booking = await app.prisma.item.create({
    data: {
      vendorId: v.id, categoryId: category.id, name: `HRS ${name} Fitting`, basePrice: 2000, isAvailable: true, fulfillment: 'APPOINTMENT',
      bookingConfig: { durationMinutes: 60, slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '09:00', end: '17:00' })) },
    },
  });
  return { vendorId: v.id, name: v.name, goodsId: goods.id, bookingId: booking.id, owner };
}
type Store = Awaited<ReturnType<typeof makeStore>>;

function call(method: 'GET' | 'POST' | 'DELETE', url: string, token?: string, payload?: unknown) {
  return app.inject({
    method, url,
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}
const ordersOf = (who: Actor) => app.prisma.order.count({ where: { customerId: who.userId } });

/** A pickup checkout of the store's goods item. */
async function buyGoods(store: Store) {
  const a = await customer();
  expect((await call('POST', '/api/v1/customer/cart/items', a.token, { vendorId: store.vendorId, itemId: store.goodsId, quantity: 1 })).statusCode).toBe(201);
  const res = await call('POST', '/api/v1/customer/checkout', a.token, { paymentMethod: 'CASH', fulfillmentSelections: { [store.vendorId]: 'PICKUP' } });
  return { a, res };
}

/** Every customer surface's "open now" for this store. */
async function surfacesSay(store: Store) {
  const c = await customer('Looker');
  const page = await call('GET', `/api/v1/customer/vendors/${store.vendorId}`, c.token);
  expect(page.statusCode, page.body).toBe(200);
  const openList = await call('GET', `/api/v1/customer/vendors?open=true&search=${encodeURIComponent(store.name)}`, c.token);
  expect(openList.statusCode, openList.body).toBe(200);
  const searchList = await call('GET', `/api/v1/customer/vendors?search=${encodeURIComponent(store.name)}`, c.token);
  const home = await call('GET', '/api/v1/customer/home', c.token);
  expect(home.statusCode, home.body).toBe(200);
  const feed = home.json().data;
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
  const inSearch = (searchList.json().data as Array<{ id: string; isCurrentlyOpen: boolean }>).find((v) => v.id === store.vendorId);
  return {
    storePage: page.json().data.isCurrentlyOpen as boolean,
    browseOpenOnly: ids(openList.json().data).includes(store.vendorId),
    browseCard: inSearch?.isCurrentlyOpen,
    homeOpen: ids(feed.openVendors).includes(store.vendorId),
    homeClosed: ids(feed.closedVendors).includes(store.vendorId),
  };
}
const agreeing = (open: boolean) => ({ storePage: open, browseOpenOnly: open, browseCard: open, homeOpen: open, homeClosed: !open });

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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
});

afterAll(async () => {
  const orders = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: userIds } }, { vendorId: { in: vendorIds } }] }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: [...orderIds, ...userIds] } }] }, 'test-cleanup:store-hours fixtures');
  if (orderIds.length > 0) {
    await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
  }
  await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: userIds } }] } });
  await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...vendorIds] } } });
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.booking.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[STORE-HOURS] checkout is the authority', () => {
  it('a day marked closed refuses: VENDOR_CLOSED, words that say when it opens, no order', async () => {
    const store = await makeStore('ClosedDay', FIXTURE_HOURS.closedToday());
    const { a, res } = await buyGoods(store);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('VENDOR_CLOSED');
    // Today and tomorrow are closed: it opens the day after (or "tomorrow", if the run crossed midnight).
    expect(res.json().error.message).toMatch(new RegExp(`^${store.name} is closed right now \\(outside its opening hours\\)\\. It opens (tomorrow|on [A-Z][a-z]+day) at 12:00 am\\.$`));
    expect(await ordersOf(a)).toBe(0);
    // The manual switch is never written.
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.vendorId } })).isCurrentlyOpen).toBe(true);
  });

  it('outside the hours refuses: VENDOR_CLOSED, no order', async () => {
    const store = await makeStore('Outside', FIXTURE_HOURS.outside());
    const { a, res } = await buyGoods(store);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('VENDOR_CLOSED');
    expect(res.json().error.message).toContain('outside its opening hours');
    expect(await ordersOf(a)).toBe(0);
  });

  it('inside the hours: the order is placed', async () => {
    const store = await makeStore('Inside', FIXTURE_HOURS.inside());
    const { a, res } = await buyGoods(store);
    expect(res.statusCode, res.body).toBe(200);
    expect(await ordersOf(a)).toBe(1);
  });

  it('no hours set: the order is placed (unchanged)', async () => {
    const store = await makeStore('NoHours', FIXTURE_HOURS.none());
    const { a, res } = await buyGoods(store);
    expect(res.statusCode, res.body).toBe(200);
    expect(await ordersOf(a)).toBe(1);
  });

  it('the switch off still refuses inside the hours, in its own words', async () => {
    const store = await makeStore('SwitchOff', FIXTURE_HOURS.inside(), { isCurrentlyOpen: false });
    const { a, res } = await buyGoods(store);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'VENDOR_CLOSED', message: `${store.name} is currently not accepting orders` });
    expect(await ordersOf(a)).toBe(0);
  });

  it('a booking-only cart keeps its exception on a day marked closed (a booking is for a later time)', async () => {
    const store = await makeStore('Booking', FIXTURE_HOURS.closedToday());
    const a = await customer('Bea');
    expect((await call('POST', '/api/v1/customer/cart/items', a.token, { vendorId: store.vendorId, itemId: store.bookingId, quantity: 1 })).statusCode).toBe(201);
    const slot = tomorrowTen();
    const res = await call('POST', '/api/v1/customer/checkout', a.token, { paymentMethod: 'CASH', appointments: [{ itemId: store.bookingId, slotStart: slot.toISOString() }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(await ordersOf(a)).toBe(1);
  });
});

describe('[STORE-HOURS] every list agrees with checkout', () => {
  for (const [label, hours, orderable] of [
    ['a day marked closed', FIXTURE_HOURS.closedToday, false],
    ['outside the hours', FIXTURE_HOURS.outside, false],
    ['inside the hours', FIXTURE_HOURS.inside, true],
    ['no hours set', FIXTURE_HOURS.none, true],
  ] as const) {
    it(`${label}: the store page, browse, open-only browse and Home say ${orderable ? 'open' : 'closed'}, as checkout decides`, async () => {
      const store = await makeStore(`Agree${label.length}`, hours());
      const { res } = await buyGoods(store);
      expect(res.statusCode === 200, res.body).toBe(orderable);
      expect(await surfacesSay(store)).toEqual(agreeing(orderable));
    });
  }

  it('open-only browse pages and counts by THE rule: a store closed by its hours never empties page 1 or the total, under any sort', async () => {
    const tag = wordFreeTag(6);
    // The store closed by its hours ranks first by rating, so a filter after the cut would empty page 1.
    const shut = await makeStore(`Paging${tag}`, FIXTURE_HOURS.closedToday());
    const openStore = await makeStore(`Paging${tag}`, FIXTURE_HOURS.inside());
    await app.prisma.vendor.update({ where: { id: shut.vendorId }, data: { averageRating: 4.9 } });
    await app.prisma.vendor.update({ where: { id: openStore.vendorId }, data: { averageRating: 3.1 } });
    const c = await customer('Pager');
    for (const sort of ['rating', 'top_rated', 'popular', 'name']) {
      const res = await call('GET', `/api/v1/customer/vendors?open=true&limit=1&page=1&sort=${sort}&search=${encodeURIComponent(`Paging${tag}`)}`, c.token);
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json().data as Array<{ id: string; isCurrentlyOpen: boolean }>).map((v) => [v.id, v.isCurrentlyOpen]), sort).toEqual([[openStore.vendorId, true]]);
      expect(res.json().meta.total, sort).toBe(1);
    }
    // Without open=true a search lists both, the open one first (open-first), whatever the rating.
    const all = await call('GET', `/api/v1/customer/vendors?limit=1&page=1&search=${encodeURIComponent(`Paging${tag}`)}`, c.token);
    expect((all.json().data as Array<{ id: string }>).map((v) => v.id)).toEqual([openStore.vendorId]);
    expect(all.json().meta.total).toBe(2);
  });

  it('the store\'s own dashboard is told its hours close it now, and when they open; the switch stays on', async () => {
    const closed = await makeStore('OwnClosed', FIXTURE_HOURS.closedToday());
    const openStore = await makeStore('OwnOpen', FIXTURE_HOURS.inside());
    for (const [store, expected] of [[closed, { closedByHoursNow: true, opensNext: expect.stringMatching(/^(tomorrow|on [A-Z][a-z]+day) at 12:00 am$/) }], [openStore, { closedByHoursNow: false, opensNext: null }]] as const) {
      const res = await call('GET', '/api/v1/vendor/profile', store.owner.token);
      expect(res.statusCode, res.body).toBe(200);
      type Mine = { id: string; isCurrentlyOpen: boolean; closedByHoursNow: boolean; opensNext: string | null };
      const mine = (res.json().data.vendors as Mine[]).find((v) => v.id === store.vendorId)!;
      expect({ isCurrentlyOpen: mine.isCurrentlyOpen, closedByHoursNow: mine.closedByHoursNow, opensNext: mine.opensNext }).toEqual({ isCurrentlyOpen: true, ...expected });
    }
  });
});
