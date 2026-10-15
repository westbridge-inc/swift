/**
 * [R23 · research C10 · DPA s.4(1)(e)] A CUSTOMER ACCOUNT UNUSED FOR 12 MONTHS IS CLOSED, AFTER A NOTICE.
 *
 *  - Unused for the window: told in the app and by text that the account closes in 30 days.
 *  - Any use after the notice (sign-in, a session refresh, an order) cancels it.
 *  - Thirty days on, still unused: the ordinary account-deletion pipeline closes it (status
 *    DEACTIVATED, phone tombstoned); its blockers (a live order) keep the account.
 *  - Never touched: partners, staff, store-review people, anyone under a legal hold, anyone
 *    younger than the window. Append-only records stay. Every run writes a receipt.
 *
 * Continues the inactivity-sweep test design drafted in the VERIFY-DOCS PR-V2 work
 * (fix/verify-docs-retention), narrowed to customers per research C10.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PrismaClient, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { inactivitySweep, inactivityNoticeText, INACTIVITY_NOTICE_TITLE, INACTIVITY_RECEIPT_CLASS } from '../modules/user/inactivity';
import { gsm7Parts, isGsm7 } from '../utils/sms-text';
import type { SmsProvider } from '../providers/notifications/channels';

const DAY = 86_400_000;
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-6);
let app: FastifyInstance;
const users: string[] = [];
const orders: string[] = [];
let seq = 0;
const texts: Array<{ to: string; body: string }> = [];
const sms: SmsProvider = { async sendSms(to, body) { texts.push({ to, body }); return { ref: 'r23' }; } };
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'inactive-accounts-test');
/** The sweep reads people; in the shared test database it may only ever see this suite's. */
const peopleScope = (): PrismaClient => app.prisma.$extends({ query: { user: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { id: { in: [...users] } }] } });
} } } }) as unknown as PrismaClient;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const sweep = (now?: Date) => system(() => inactivitySweep({ prisma: peopleScope(), io: app.io, log: quiet as never, sms }, now));

async function person(opts: { role?: UserRole; ageDays?: number; activeDaysAgo?: number | null } = {}) {
  seq += 1;
  const role = opts.role ?? 'CUSTOMER';
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59277${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Quiet', lastName: `Account${seq}`, activeRole: role, roles: [role],
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, createdAt: new Date(Date.now() - (opts.ageDays ?? 500) * DAY),
    lastActiveAt: opts.activeDaysAgo == null ? null : new Date(Date.now() - opts.activeDaysAgo * DAY),
    ...(role === 'CUSTOMER' ? { customer: { create: {} } } : {}),
  } }));
  users.push(u.id);
  return u.id;
}
const userOf = (id: string) => system(() => app.prisma.user.findUniqueOrThrow({ where: { id }, select: { status: true, phone: true, inactivityNoticeAt: true } }));

async function order(customerId: string, status: 'DELIVERED' | 'PREPARING', touchedDaysAgo: number) {
  const o = await system(() => app.prisma.order.create({ data: {
    orderNumber: `IA-${RUN}-${nanoid(6)}`, customerId, orderType: 'TAXI', status,
    pickupLat: 6.8, pickupLng: -58.15, deliveryLat: 6.82, deliveryLng: -58.17, pickupAddress: 'pickup fixture', deliveryAddress: 'destination fixture',
    subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, totalAmount: 1500, deliveryFee: 0, paymentMethod: 'CASH',
  } }));
  orders.push(o.id);
  const at = new Date(Date.now() - touchedDaysAgo * DAY);
  await system(() => app.prisma.$executeRaw`UPDATE orders SET "updatedAt" = ${at}, "placedAt" = ${at} WHERE id = ${o.id}`);
  return o.id;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin);
  await app.ready();
  await system(() => app.prisma.platformConfig.deleteMany({ where: { key: 'accounts.inactive_customer_days' } }));
});

afterAll(async () => {
  // consent, audit and deletion-receipt rows are append-only evidence: only what this suite made and may delete goes.
  await system(async () => {
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orders } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
  });
  await app.close();
});

describe('[R23] the notice says what happens, in plain words, by text and in the app', () => {
  it('the text is GSM-7, one or two parts, names Swift, the day and the way to keep the account', () => {
    const t = inactivityNoticeText(new Date('2026-11-15T12:00:00Z'));
    expect(t.title).toBe(INACTIVITY_NOTICE_TITLE);
    expect(t.sms).toBe('Swift: you have not used your account for 12 months. Sign in before 15 November 2026 to keep it. Otherwise we close it in 30 days and delete your data.');
    expect(isGsm7(t.sms)).toBe(true);
    expect(gsm7Parts(t.sms)).toBeLessThanOrEqual(2);
    expect(t.body).toContain('before 15 November 2026');
    expect(t.body).toContain('in 30 days');
  });
});

describe('[R23] 12 months without use: a notice, then the deletion pipeline', () => {
  it('a customer unused for over a year is told; 30 days later, still unused, the account is closed', async () => {
    const u = await person({ activeDaysAgo: 400 });
    const first = await sweep();
    expect(first.noticed).toBe(1);
    const told = await userOf(u);
    expect(told.inactivityNoticeAt).not.toBeNull();
    expect(told.status).toBe('ACTIVE');
    const notice = await system(() => app.prisma.notification.findFirst({ where: { userId: u, title: INACTIVITY_NOTICE_TITLE } }));
    expect(notice?.body).toMatch(/in 30 days/);
    expect(texts.filter((t) => t.body.startsWith('Swift: you have not used your account'))).toHaveLength(1);
    // the same day again: nothing more
    expect((await sweep()).noticed).toBe(0);
    expect(await system(() => app.prisma.notification.count({ where: { userId: u, title: INACTIVITY_NOTICE_TITLE } }))).toBe(1);
    // 29 days on: still open
    expect((await sweep(new Date(Date.now() + 29 * DAY))).deleted).toBe(0);
    expect((await userOf(u)).status).toBe('ACTIVE');
    // 31 days on: closed by the ordinary pipeline
    const closing = await sweep(new Date(Date.now() + 31 * DAY));
    expect(closing.deleted).toBe(1);
    const closed = await userOf(u);
    expect(closed.status).toBe('DEACTIVATED');
    expect(closed.phone).toBe(`deleted:${u}`);
  });

  it('use after the notice cancels it: a sign-in, a refreshed session, an order', async () => {
    const signIn = await person({ activeDaysAgo: 400 });
    const refreshed = await person({ activeDaysAgo: 400 });
    const ordered = await person({ activeDaysAgo: 400 });
    expect((await sweep()).noticed).toBe(3);
    await system(() => app.prisma.user.update({ where: { id: signIn }, data: { lastActiveAt: new Date(Date.now() + DAY) } }));
    await system(() => app.prisma.session.create({ data: {
      userId: refreshed, token: `ia-${nanoid(24)}`, refreshToken: nanoid(48), deviceId: 'r23', deviceType: 'test',
      expiresAt: new Date(Date.now() + 60 * DAY), rotatedAt: new Date(Date.now() + DAY),
    } }));
    await order(ordered, 'DELIVERED', -1);
    const later = await sweep(new Date(Date.now() + 31 * DAY));
    expect(later.revived).toBe(3);
    expect(later.deleted).toBe(0);
    for (const id of [signIn, refreshed, ordered]) {
      const row = await userOf(id);
      expect(row.status, id).toBe('ACTIVE');
      expect(row.inactivityNoticeAt, id).toBeNull();
    }
  });

  it('never told: a recent user, a recent order or session, partners, staff, a legal hold, anyone younger than a year', async () => {
    const recent = await person({ activeDaysAgo: 60 });
    const recentOrder = await person({ activeDaysAgo: 400 });
    await order(recentOrder, 'DELIVERED', 20);
    const recentSession = await person({ activeDaysAgo: 400 });
    await system(() => app.prisma.session.create({ data: {
      userId: recentSession, token: `ia-${nanoid(24)}`, refreshToken: nanoid(48), deviceId: 'r23', deviceType: 'test',
      expiresAt: new Date(Date.now() + 60 * DAY), createdAt: new Date(Date.now() - 400 * DAY), rotatedAt: new Date(Date.now() - 10 * DAY),
    } }));
    const mover = await person({ role: 'MOVER', activeDaysAgo: 400 });
    const store = await person({ role: 'VENDOR_OWNER', activeDaysAgo: 400 });
    const staff = await person({ role: 'ADMIN', activeDaysAgo: 400 });
    const held = await person({ activeDaysAgo: 400 });
    await system(() => app.prisma.docLegalHold.create({ data: {
      subjectUserId: held, reason: `hold ${RUN}`, ownerId: held, placedBy: held, reviewBy: new Date(Date.now() + 30 * DAY),
    } }));
    const young = await person({ ageDays: 100, activeDaysAgo: null });
    expect((await sweep()).noticed).toBe(0);
    for (const id of [recent, recentOrder, recentSession, mover, store, staff, held, young]) {
      expect((await userOf(id)).inactivityNoticeAt, id).toBeNull();
    }
  });

  it('the pipeline\'s blockers keep the account: a live order', async () => {
    const u = await person({ activeDaysAgo: 400 });
    expect((await sweep()).noticed).toBe(1);
    await order(u, 'PREPARING', 400); // a live order untouched for over a year still blocks deletion
    const run = await sweep(new Date(Date.now() + 31 * DAY));
    expect(run.blocked).toBe(1);
    expect(run.deleted).toBe(0);
    expect((await userOf(u)).status).toBe('ACTIVE');
  });

  it('closing leaves the append-only records in place, and every run writes a receipt', async () => {
    const u = await person({ activeDaysAgo: 400 });
    await system(() => app.prisma.auditLog.create({ data: { userId: u, action: `INACTIVITY_TEST_${RUN}`, entity: 'User', entityId: u } }));
    const before = await system(() => app.prisma.retentionSweepReceipt.count({ where: { dataClass: INACTIVITY_RECEIPT_CLASS } }));
    await sweep();
    await sweep(new Date(Date.now() + 31 * DAY));
    expect((await userOf(u)).status).toBe('DEACTIVATED');
    expect(await system(() => app.prisma.auditLog.count({ where: { action: `INACTIVITY_TEST_${RUN}` } }))).toBe(1);
    expect(await system(() => app.prisma.retentionSweepReceipt.count({ where: { dataClass: INACTIVITY_RECEIPT_CLASS } }))).toBe(before + 2);
  });

  it('the window is a setting; a nonsense value falls back to 12 months', async () => {
    const u = await person({ activeDaysAgo: 250, ageDays: 300 });
    try {
      await system(() => app.prisma.platformConfig.upsert({ where: { key: 'accounts.inactive_customer_days' }, create: { key: 'accounts.inactive_customer_days', value: 200 }, update: { value: 200 } }));
      expect((await sweep()).noticed).toBe(1);
      await system(() => app.prisma.user.update({ where: { id: u }, data: { inactivityNoticeAt: null } }));
      await system(() => app.prisma.platformConfig.update({ where: { key: 'accounts.inactive_customer_days' }, data: { value: 5 } }));
      expect((await sweep()).noticed).toBe(0);
    } finally {
      await system(() => app.prisma.platformConfig.deleteMany({ where: { key: 'accounts.inactive_customer_days' } }));
    }
  });
});
