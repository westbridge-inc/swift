import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { SosStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { beginRequestTenantContext, runWithoutTenant } from '../plugins/tenant-context';

// ---------------------------------------------------------------------------
// [73 · MOBILE-SAFETY] The person who raised an SOS can find it again after
// the app restarts (an owner-only read of their live alerts, state only), and
// "I'm safe" is idempotent: a repeated tap, two taps racing, or a retry after
// a lost response sets ONE timestamp and pages ops ONCE — and a flag whose
// notice never went out is delivered on the next tap. A pending or closed
// alert is never flagged and never pages.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
const alertIds: string[] = [];
let seq = 0;
const phoneBase = 592_790_000_000 + Math.floor(Math.random() * 100_000_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'Owner', lastName: `L10${RUN}${seq}`, roles, activeRole: roles[0]!, isPhoneVerified: true, status: 'ACTIVE' } });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
    await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'own', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
    return { userId: user.id, token };
  }, 'test-fixture:l10-sos-owner');
}

async function makeAlert(actorUserId: string, status: SosStatus, extra: Record<string, unknown> = {}) {
  return runWithoutTenant(async () => {
    const a = await app.prisma.sosAlert.create({ data: { actorUserId, actorRole: 'CUSTOMER', status, triggerSource: 'BUTTON', triggeredAt: new Date(), triggerLat: 6.8, triggerLng: -58.15, triggerNote: 'synthetic private note', ...extra } });
    alertIds.push(a.id);
    return a;
  }, 'test-fixture:l10-sos-owner');
}

const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const post = (url: string, token: string) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: {} });
const alertRow = (id: string) => runWithoutTenant(() => app.prisma.sosAlert.findUniqueOrThrow({ where: { id } }), 'test-read:l10-sos-owner');
const markedSafeNotices = (sosAlertId: string) => runWithoutTenant(() => app.prisma.notification.count({ where: { AND: [{ data: { path: ['kind'], equals: 'sos_marked_safe' } }, { data: { path: ['sosAlertId'], equals: sosAlertId } }] } }), 'test-read:l10-sos-owner');

let owner: { userId: string; token: string };
let stranger: { userId: string; token: string };
let opsAdmin: { userId: string; token: string };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
  owner = await makeUser(['CUSTOMER']);
  stranger = await makeUser(['CUSTOMER']);
  opsAdmin = await makeUser(['SUPER_ADMIN']);
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.notification.deleteMany({ where: { OR: alertIds.map((id) => ({ data: { path: ['sosAlertId'], equals: id } })) } }).catch(() => {});
    await app.prisma.alertDelivery.deleteMany({ where: { recipientId: { in: userIds } } }).catch(() => {});
    await app.prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:l10-sos-owner');
  await app.close();
});

describe('[73] the owner finds their live alert again after a restart', () => {
  it('lists only the caller\'s own live alerts, state only — no coordinates, notes or anyone else\'s alert', async () => {
    const live = await makeAlert(owner.userId, 'ACTIVE');
    const pending = await makeAlert(owner.userId, 'TRIGGER_PENDING', { graceEndsAt: new Date(Date.now() + 30_000) });
    const closed = await makeAlert(owner.userId, 'RESOLVED');
    const foreign = await makeAlert(stranger.userId, 'ACTIVE');
    const res = await get('/api/v1/safety/sos/owned-active', owner.token);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<Record<string, unknown>>;
    const ids = rows.map((r) => r['id']);
    expect(ids).toEqual(expect.arrayContaining([live.id, pending.id]));
    expect(ids).not.toContain(closed.id);
    expect(ids).not.toContain(foreign.id);
    for (const row of rows) {
      expect(row['actorUserId']).toBe(owner.userId);
      for (const hidden of ['triggerLat', 'triggerLng', 'triggerNote', 'deliveryReceipts', 'counterpartyUserId']) expect(row).not.toHaveProperty(hidden);
    }
  });

  it('pages with a cursor pinned to the caller: another person\'s alert id is not a cursor', async () => {
    const foreign = await makeAlert(stranger.userId, 'ACTIVE');
    const res = await get(`/api/v1/safety/sos/owned-active?cursor=${foreign.id}`, owner.token);
    expect(res.statusCode).toBe(400);
  });

  it('the owner reads one alert back as state only; someone else gets 403', async () => {
    const live = await makeAlert(owner.userId, 'ACTIVE');
    const mine = await get(`/api/v1/safety/sos/${live.id}`, owner.token);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data).not.toHaveProperty('triggerNote');
    expect(mine.json().data.status).toBe('ACTIVE');
    expect((await get(`/api/v1/safety/sos/${live.id}`, stranger.token)).statusCode).toBe(403);
  });

  it('keeps the tenant wall: the owner\'s alert written in another tenant is neither listed nor readable; their platform (no-tenant) alert is both (DS759)', async () => {
    const me = await makeUser(['CUSTOMER']);
    const otherTenant = `l10-owner-b-${RUN}`;
    await runWithoutTenant(() => app.prisma.tenant.create({ data: { id: otherTenant, name: 'L10 owner tenant B', slug: otherTenant, isActive: true } }), 'test-fixture:l10-sos-owner');
    try {
      const elsewhere = await makeAlert(me.userId, 'ACTIVE', { tenantId: otherTenant, orderId: `l10-own-b-${RUN}` });
      const platform = await makeAlert(me.userId, 'ACTIVE', { tenantId: null, orderId: `l10-own-p-${RUN}` });
      const listed = (await get('/api/v1/safety/sos/owned-active', me.token)).json().data.map((r: { id: string }) => r.id);
      expect(listed).toContain(platform.id);
      expect(listed).not.toContain(elsewhere.id);
      expect((await get(`/api/v1/safety/sos/${platform.id}`, me.token)).statusCode).toBe(200);
      // Not a 403: another tenant's row is not acknowledged to exist.
      expect((await get(`/api/v1/safety/sos/${elsewhere.id}`, me.token)).statusCode).toBe(404);
      expect((await post(`/api/v1/safety/sos/${elsewhere.id}/mark-safe`, me.token)).statusCode).toBe(404);
      expect((await alertRow(elsewhere.id)).userSafeFlaggedAt).toBeNull();
    } finally {
      await runWithoutTenant(async () => {
        await app.prisma.sosAlert.deleteMany({ where: { tenantId: otherTenant } }).catch(() => {});
        await app.prisma.tenant.delete({ where: { id: otherTenant } }).catch(() => {});
      }, 'test-cleanup:l10-sos-owner');
    }
  });

  it('pages across every live alert: newest first, each once, and the last page carries no cursor (DS759)', async () => {
    const me = await makeUser(['CUSTOMER']);
    const base = Date.now();
    const made = [];
    for (let i = 0; i < 3; i += 1) made.push(await makeAlert(me.userId, 'ACTIVE', { orderId: `l10-own-page-${RUN}-${i}`, triggeredAt: new Date(base - i * 60_000) }));
    const first = (await get('/api/v1/safety/sos/owned-active?limit=2', me.token)).json();
    expect(first.data.map((r: { id: string }) => r.id)).toEqual([made[0]!.id, made[1]!.id]);
    expect(first.nextCursor).toBe(made[1]!.id);
    const second = (await get(`/api/v1/safety/sos/owned-active?limit=2&cursor=${first.nextCursor}`, me.token)).json();
    expect(second.data.map((r: { id: string }) => r.id)).toEqual([made[2]!.id]);
    expect(second.nextCursor).toBeNull();
  });
});

describe('[73] "I\'m safe" is idempotent', () => {
  it('a repeated tap keeps the first timestamp and pages ops once', async () => {
    const live = await makeAlert(owner.userId, 'ACTIVE');
    const first = await post(`/api/v1/safety/sos/${live.id}/mark-safe`, owner.token);
    expect(first.statusCode).toBe(200);
    const flaggedAt = first.json().data.userSafeFlaggedAt as string;
    expect(flaggedAt).toBeTruthy();
    const second = await post(`/api/v1/safety/sos/${live.id}/mark-safe`, owner.token);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.userSafeFlaggedAt).toBe(flaggedAt);
    expect((await alertRow(live.id)).userSafeFlaggedAt?.toISOString()).toBe(flaggedAt);
    const perAdmin = await runWithoutTenant(() => app.prisma.notification.count({ where: { userId: opsAdmin.userId, data: { path: ['sosAlertId'], equals: live.id } } }), 'test-read:l10-sos-owner');
    expect(perAdmin).toBe(1);
    expect((await alertRow(live.id)).status).toBe('ACTIVE'); // never closes the case
  });

  it('two taps racing set one timestamp and page each admin once', async () => {
    const live = await makeAlert(owner.userId, 'ACKNOWLEDGED');
    const [a, b] = await Promise.all([post(`/api/v1/safety/sos/${live.id}/mark-safe`, owner.token), post(`/api/v1/safety/sos/${live.id}/mark-safe`, owner.token)]);
    expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200);
    expect(a.json().data.userSafeFlaggedAt).toBe(b.json().data.userSafeFlaggedAt);
    const perAdmin = await runWithoutTenant(() => app.prisma.notification.count({ where: { userId: opsAdmin.userId, data: { path: ['sosAlertId'], equals: live.id } } }), 'test-read:l10-sos-owner');
    expect(perAdmin).toBe(1);
  });

  it('a flag whose notice never went out (crash between the two) is delivered by the next tap, once', async () => {
    const flaggedAt = new Date(Date.now() - 5_000);
    const live = await makeAlert(owner.userId, 'ACTIVE', { userSafeFlaggedAt: flaggedAt });
    expect(await markedSafeNotices(live.id)).toBe(0);
    const retry = await post(`/api/v1/safety/sos/${live.id}/mark-safe`, owner.token);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data.userSafeFlaggedAt).toBe(flaggedAt.toISOString());
    const perAdmin = () => runWithoutTenant(() => app.prisma.notification.count({ where: { userId: opsAdmin.userId, data: { path: ['sosAlertId'], equals: live.id } } }), 'test-read:l10-sos-owner');
    expect(await perAdmin()).toBe(1);
    await post(`/api/v1/safety/sos/${live.id}/mark-safe`, owner.token);
    expect(await perAdmin()).toBe(1);
  });

  it.each(['TRIGGER_PENDING', 'RESOLVED', 'CANCELLED'] as const)('a %s alert is never flagged and never pages', async (status) => {
    const alert = await makeAlert(owner.userId, status, status === 'TRIGGER_PENDING' ? { graceEndsAt: new Date(Date.now() + 30_000) } : {});
    const res = await post(`/api/v1/safety/sos/${alert.id}/mark-safe`, owner.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.userSafeFlaggedAt).toBeNull();
    expect((await alertRow(alert.id)).userSafeFlaggedAt).toBeNull();
    expect(await markedSafeNotices(alert.id)).toBe(0);
  });

  it('someone else cannot mark another person\'s alert safe', async () => {
    const live = await makeAlert(owner.userId, 'ACTIVE');
    expect((await post(`/api/v1/safety/sos/${live.id}/mark-safe`, stranger.token)).statusCode).toBe(403);
    expect((await alertRow(live.id)).userSafeFlaggedAt).toBeNull();
  });
});
