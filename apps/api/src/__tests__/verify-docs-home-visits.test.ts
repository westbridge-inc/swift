/**
 * [VERIFY-DOCS · owner ruling 6 Oct 2026, ~21:25 GYT] POLICE CLEARANCE FOR HOME VISITS ONLY.
 *
 *  - Marketplace tradespeople (the services marketplace, SERVICE_PROVIDER) keep police clearance
 *    REQUIRED: their jobs are home visits, and the marketplace has no other kind.
 *  - A service BUSINESS (a SERVICE store) no longer needs one to open: its owner's ID is enough,
 *    and a police clearance is a document it MAY add.
 *  - A HOME-VISIT booking (a listing's "comes to you" mode: MOBILE, or BOTH with the customer
 *    choosing their place) is refused at checkout unless the owner holds an approved, current
 *    police clearance. The customer is told plainly; the owner is told what to do (once a day).
 *  - In-shop bookings are never affected.
 *  - Build 9 shows and uploads only `checklist`: an owner who offers home visits sees the police
 *    clearance there, so a build-9 owner can upload it — but it never gates the store.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as homeVisits from '../modules/verification/home-visits';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { customerRoutes } from '../modules/user/customer.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { DEFAULT_DOCUMENT_CHECKLISTS } from '../modules/ops/platform-config';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';
import { ownedVerificationFixture } from './helpers/verification-object';
import { cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';

const DAY = 86_400_000;
const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, '0');
const phoneBase = 592_006_400_000 + Math.floor(Math.random() * 90_000);
let app: FastifyInstance;
let service: VerificationService;
let adminId = '';
const users: string[] = [];
const orders: string[] = [];
let seq = 0;

async function person(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + seq}`, firstName: 'Home', lastName: `Visit${seq}`, roles, activeRole, countryCode: 'GY',
    isPhoneVerified: true, selfieCapturedAt: new Date(), status: 'ACTIVE',
    ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
  } });
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), deviceId: `hv-${RUN}-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } });
  return { userId: user.id, token };
}

/** A SERVICE store, live, with one appointment listing in the given mode. */
async function serviceStore(mode: 'AT_BUSINESS' | 'MOBILE' | 'BOTH' | null) {
  const owner = await person(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: vo.id, name: `Glow ${RUN} ${seq}`, slug: `glow-${RUN}-${seq}`, vendorType: 'SERVICE', phone: `+5926${String(seq).padStart(6, '0')}`,
    addressLine1: '3 Salon Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.801, longitude: -58.156,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
  } });
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Services', sortOrder: 0 } });
  const item = mode === null ? null : await app.prisma.item.create({ data: {
    vendorId: vendor.id, categoryId: category.id, name: `Braids ${mode}`, basePrice: 4000, fulfillment: 'APPOINTMENT',
    bookingConfig: { durationMinutes: 60, slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '08:00', end: '18:00' })), serviceMode: mode, serviceRadiusKm: 25 },
  } });
  return { ...owner, vendorId: vendor.id, vendorName: vendor.name, itemId: item?.id ?? '' };
}

/** Tomorrow at a Guyana wall-clock hour, as the instant the picker sends. */
function tomorrowAt(hours: number): Date {
  const [y, m, d] = guyanaDayKey(new Date()).split('-').map(Number);
  return instantOfGuyanaWallClock(new Date(Date.UTC(y!, m! - 1, d! + 1, hours, 0)));
}

async function customer() {
  const c = await person(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({ data: {
    userId: c.userId, label: 'Home', addressLine1: '9 Customer Close', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 6.81, longitude: -58.15, isDefault: true,
  } });
  return c;
}

async function book(c: { token: string; userId: string }, store: { vendorId: string; itemId: string }, hour: number, mode?: 'AT_BUSINESS' | 'MOBILE') {
  await app.prisma.cart.deleteMany({ where: { customerId: c.userId } });
  const added = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/items', headers: { authorization: `Bearer ${c.token}` },
    payload: { vendorId: store.vendorId, itemId: store.itemId, quantity: 1 } });
  expect(added.statusCode, added.body).toBeLessThan(300);
  const res = await app.inject({ method: 'POST', url: '/api/v1/customer/checkout', headers: { authorization: `Bearer ${c.token}` },
    payload: { paymentMethod: 'CASH', appointments: [{ itemId: store.itemId, slotStart: tomorrowAt(hour).toISOString(), ...(mode ? { mode } : {}) }] } });
  if (res.statusCode === 200) orders.push(res.json().data.order.id);
  return res;
}

/** One of the owner's documents, approved by a reviewer. */
async function approved(ownerId: string, docType: string, expiresAt?: Date) {
  const doc = await app.prisma.verificationDocument.create({ data: {
    userId: ownerId, role: 'VENDOR_OWNER', docType, status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1',
    fileUrl: await ownedVerificationFixture(app.prisma, ownerId, `hv-${docType}-${RUN}`),
  } });
  await service.approveDocument(doc.id, adminId, expiresAt);
  return doc.id;
}

/** A live store's owner: their ID approved (the store's own gate), then the police clearance. */
async function clearOwner(ownerId: string, expiresAt: Date) {
  await approved(ownerId, 'owner_national_id');
  return approved(ownerId, 'police_clearance', expiresAt);
}

const homeVisitNotices = (ownerId: string) => app.prisma.notification.count({ where: { userId: ownerId, title: 'Home visits are paused' } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
  adminId = (await person(['ADMIN'], 'ADMIN')).userId;
});

afterAll(async () => {
  if (!app) return;
  await app.prisma.booking.deleteMany({ where: { customerId: { in: users } } }).catch(() => {});
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orders } } }).catch(() => {});
  await app.prisma.order.deleteMany({ where: { id: { in: orders } } }).catch(() => {});
  await app.prisma.cart.deleteMany({ where: { customerId: { in: users } } }).catch(() => {});
  await cleanupPayerBillingClocks(app.prisma, users).catch(() => {});
  await app.prisma.notification.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
  await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  await app.close();
});

describe('[home visits] the lists', () => {
  it('a service business opens on its owner’s ID; police clearance is a document it may add', () => {
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE']).toEqual(['owner_national_id']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_OPTIONAL']).toEqual(['police_clearance']);
  });

  it('marketplace tradespeople keep police clearance REQUIRED (their jobs are home visits)', () => {
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_PROVIDER']).toEqual(['national_id', 'police_clearance']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_PROVIDER_OPTIONAL']).toBeUndefined();
  });

  it('the seeded Guyana row carries the same service lists', async () => {
    const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
    const stored = gy.documentChecklists as Record<string, string[]>;
    for (const key of ['SERVICE', 'SERVICE_OPTIONAL', 'SERVICE_PROVIDER']) expect(stored[key], key).toEqual(DEFAULT_DOCUMENT_CHECKLISTS[key]);
  });
});

describe('[home visits] what the owner is shown', () => {
  it('an in-shop business: the owner’s ID is the whole checklist; police clearance is optional', async () => {
    const store = await serviceStore('AT_BUSINESS');
    const status = await service.getStatus(store.userId, 'SERVICE');
    expect(status.checklist).toEqual(['owner_national_id']);
    expect(status.optional).toContain('police_clearance');
    expect(status.homeVisits).toEqual({ offered: false, cleared: false });
  });

  it('a business that offers home visits sees the police clearance in its checklist (build 9 can upload it) — but it never gates the store', async () => {
    const store = await serviceStore('BOTH');
    const status = await service.getStatus(store.userId, 'SERVICE');
    expect(status.checklist).toEqual(['owner_national_id', 'police_clearance']);
    expect(status.optional).not.toContain('police_clearance');
    expect(status.homeVisits).toEqual({ offered: true, cleared: false });
    // the store's gate is the owner's ID alone
    expect(await service.isRoleVerified(store.userId, 'SERVICE')).toBe(false);
    await approved(store.userId, 'owner_national_id');
    expect(await service.isRoleVerified(store.userId, 'SERVICE')).toBe(true);
    const after = await service.getStatus(store.userId, 'SERVICE');
    expect(after.roleVerified).toBe(true);
    expect(after.missing).toEqual(['police_clearance']);
  });

  it('a build-9 owner uploads the police clearance from the checklist it shows', async () => {
    const store = await serviceStore('MOBILE');
    const fileUrl = await ownedVerificationFixture(app.prisma, store.userId, `hv-b9-${RUN}`);
    const res = await app.inject({ method: 'POST', url: '/api/v1/verification/documents', headers: { authorization: `Bearer ${store.token}` },
      payload: { role: 'SERVICE', docType: 'police_clearance', fileUrl, consent: true, privacyNoticeVersion: 'v1' } });
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('[home visits] booking', () => {
  it('clearance that lapses after preflight cannot authorize a committed home visit', async () => {
    const store = await serviceStore('MOBILE');
    const pc = await clearOwner(store.userId, new Date(Date.now() + 200 * DAY));
    const c = await customer();
    const check = homeVisits.homeVisitsCleared;
    const preflight = vi.spyOn(homeVisits, 'homeVisitsCleared').mockImplementation(async (db, ownerId, now) => {
      const allowed = await check(db, ownerId, now);
      if (db === app.prisma && ownerId === store.userId && allowed) {
        await app.prisma.verificationDocument.update({ where: { id: pc }, data: { expiresAt: new Date(Date.now() - DAY) } });
      }
      return allowed;
    });
    try {
      const res = await book(c, store, 10);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('HOME_VISIT_UNAVAILABLE');
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
      expect(await app.prisma.booking.count({ where: { customerId: c.userId } })).toBe(0);
    } finally { preflight.mockRestore(); }
  });

  it('concurrent refusals give the owner one daily notice', async () => {
    const store = await serviceStore('MOBILE');
    const notifications = new NotificationService(app.prisma, app.io);
    await Promise.all(Array.from({ length: 4 }, () => homeVisits.tellOwnerHomeVisitsPaused(app.prisma, notifications, store.userId, store.vendorName)));
    expect(await homeVisitNotices(store.userId)).toBe(1);
  });
  it('a home visit is refused at checkout while the owner holds no approved police clearance; the customer and the owner are told plainly', async () => {
    const store = await serviceStore('MOBILE');
    const c = await customer();
    const res = await book(c, store, 10);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('HOME_VISIT_UNAVAILABLE');
    expect(res.json().error.message).toBe(`${store.vendorName} can't come to your home yet, so this service can't be booked right now. Please try again later.`);
    expect(await homeVisitNotices(store.userId)).toBe(1);
    // asked again the same day: the owner is not told twice
    expect((await book(c, store, 11)).statusCode).toBe(409);
    expect(await homeVisitNotices(store.userId)).toBe(1);
    const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: store.userId, title: 'Home visits are paused' } });
    expect(notice.body).toContain('police clearance');
  });

  it('a BOTH listing: the home visit is refused with the in-shop alternative named, and the in-shop booking goes through', async () => {
    const store = await serviceStore('BOTH');
    const c = await customer();
    const home = await book(c, store, 10, 'MOBILE');
    expect(home.statusCode).toBe(409);
    expect(home.json().error.message).toBe(`${store.vendorName} can't come to your home yet. You can book this service at their place instead.`);
    // the default for BOTH (no choice made) is a visit too
    expect((await book(c, store, 11)).statusCode).toBe(409);
    expect((await book(c, store, 12, 'AT_BUSINESS')).statusCode).toBe(200);
  });

  it('an in-shop listing is never affected', async () => {
    const store = await serviceStore('AT_BUSINESS');
    expect((await book(await customer(), store, 10)).statusCode).toBe(200);
    expect(await homeVisitNotices(store.userId)).toBe(0);
  });

  it('with an approved, current police clearance the home visit books; once it lapses, it is refused again', async () => {
    const store = await serviceStore('MOBILE');
    const pc = await clearOwner(store.userId, new Date(Date.now() + 200 * DAY));
    const c = await customer();
    expect((await book(c, store, 10)).statusCode).toBe(200);
    expect((await service.getStatus(store.userId, 'SERVICE')).homeVisits).toEqual({ offered: true, cleared: true });
    await app.prisma.verificationDocument.update({ where: { id: pc }, data: { expiresAt: new Date(Date.now() - DAY) } });
    expect((await book(c, store, 12)).statusCode).toBe(409);
  });
});
