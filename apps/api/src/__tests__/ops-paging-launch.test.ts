import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Server } from 'socket.io';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { beginRequestTenantContext, runWithoutTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { NotificationService, notifyAdmins } from '../modules/notification/notification.service';
import { pageOps } from '../modules/ops/ops-page';
import { openOpsAlert, escalateOverdueOpsAlerts, acknowledgeOpsAlert } from '../modules/safety/ops-alert';
import { SosService } from '../modules/safety/sos.service';
import { drainSosEscalations, stageEscalations } from '../modules/safety/sos-escalation';
import { ReviewDemoSosError } from '../modules/review/demo-policy';
import { OPS_WAR_ROOM, tenantWarRoom } from '../modules/safety/war-room';
import { devChannelLog, getChannels, resetDevChannelLog } from '../providers/notifications/channels';

// ---------------------------------------------------------------------------
// [L10 · launch paging] When someone presses SOS, a staffed person is paged
// and the page is acknowledged by a real recipient.
//  - 75: a page that resolves NOBODY to acknowledge it is due for escalation
//    at once: the on-call phones are texted, and the next sweep re-resolves
//    its recipients (every sweep, not once per escalation window). Never a
//    quiet success.
//  - 144: platform pages reach every SUPER_ADMIN in-app AND text every
//    OPS_ONCALL_PHONES number at open (coordinator ruling, 5 Oct 2026).
//  - M009: platform (null-tenant) alerts are listed and acknowledged only by
//    a SUPER_ADMIN; a tenant admin gets 403, and never sees another tenant's.
//  - M076: an acknowledgement is the acknowledger's receipt and the alert's
//    acknowledgedAt, committed together, or nothing.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const TENANT_B = `l10-paging-b-${RUN}`;
const TENANT_REVIEW = `l10-paging-review-${RUN}`;
const userIds: string[] = [];
const alertIds: string[] = [];
const phoneBase = 592_730_000_000 + Math.floor(Math.random() * 100_000_000);
const ONCALL = `+5926${String(Date.now()).slice(-6)}1`;
let seq = 0;
const SUITE_START = new Date();

const io = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) } as unknown as Server;
const notifications = () => new NotificationService(app.prisma, io);
const oncallTexts = () => devChannelLog.filter((e) => e.channel === 'sms' && (e as { to?: string }).to === ONCALL);

async function makeUser(roles: UserRole[], tenantId?: string) {
  seq += 1;
  const user = await runWithoutTenant(() => app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Pager', lastName: `L10${RUN}${seq}`, roles, activeRole: roles[0]!,
      status: 'ACTIVE', isPhoneVerified: true, ...(tenantId ? { tenantId } : {}),
    },
  }), 'test-fixture:l10-paging');
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await runWithoutTenant(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'l10', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + 86_400_000) } }), 'test-fixture:l10-paging');
  return { userId: user.id, token };
}

async function openAlert(tenantId: string | null, recipientIds: string[], title = `L10 page ${RUN} ${nanoid(4)}`) {
  const res = await runWithoutTenant(() => openOpsAlert(app.prisma, notifications(), { kind: 'PLATFORM', tenantId, title, body: 'A synthetic page.', data: { kind: 'l10_test' }, recipientIds }), 'test-fixture:l10-paging');
  alertIds.push(res.opsAlertId);
  return res;
}
const alertRow = (id: string) => runWithoutTenant(() => app.prisma.opsAlert.findUniqueOrThrow({ where: { id }, include: { recipients: true } }), 'test-read:l10-paging');
const request = (method: 'GET' | 'POST', url: string, token: string) => app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { payload: {} } : {}) });

let superAdmin: { userId: string; token: string };
let adminA: { userId: string; token: string };
let adminB: { userId: string; token: string };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  // Production opens a fresh per-request tenant store before auth (server.ts).
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
  await runWithoutTenant(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'L10 paging tenant B', slug: TENANT_B, isActive: true } }), 'test-fixture:l10-paging');
  await runWithoutTenant(() => app.prisma.tenant.create({ data: { id: TENANT_REVIEW, name: 'L10 paging review fiction', slug: TENANT_REVIEW, isActive: true, kind: 'REVIEW' } }), 'test-fixture:l10-paging');
  superAdmin = await makeUser(['SUPER_ADMIN']);
  adminA = await makeUser(['ADMIN']);
  adminB = await makeUser(['ADMIN'], TENANT_B);
});

beforeEach(() => { resetDevChannelLog(); process.env['OPS_ONCALL_PHONES'] = ONCALL; });
afterEach(() => { delete process.env['OPS_ONCALL_PHONES']; });

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: alertIds } } }).catch(() => {});
    await app.prisma.opsAlert.deleteMany({ where: { OR: [{ id: { in: alertIds } }, { title: { contains: RUN } }, { kind: 'DRILL', createdAt: { gte: SUITE_START } }] } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.prisma.tenant.delete({ where: { id: TENANT_B } }).catch(() => {});
    await app.prisma.tenant.delete({ where: { id: TENANT_REVIEW } }).catch(() => {});
  }, 'test-cleanup:l10-paging');
  await app.close();
});

describe('[75] a page with nobody to acknowledge it escalates at once — never a quiet success', () => {
  it('is due for escalation the moment it opens, texts the on-call list, and is pending, not delivered', async () => {
    const now = new Date();
    const page = await openAlert(null, []);
    expect(page.recipients).toBe(0);
    expect(page.oncallTexted).toBe(1);
    expect(oncallTexts()).toHaveLength(1);
    const row = await alertRow(page.opsAlertId);
    expect(row.ackDeadlineAt.getTime()).toBeLessThanOrEqual(now.getTime() + 1_000);
    const outcome = await pageOps({ prisma: app.prisma, redis: app.redis, notifications: notifications(), resolveRecipients: async () => [] }, { key: `ops_page:l10-${RUN}`, title: `L10 pending page ${RUN}`, body: 'b', data: { kind: 'l10_test' } });
    expect(outcome.status).toBe('pending');
    if (outcome.status === 'pending') alertIds.push(outcome.opsAlertId);
  });

  it('the very next sweep escalates it: recipients re-resolved, staff paged, on-call texted again', async () => {
    const page = await openAlert(null, []);
    resetDevChannelLog();
    const res = await runWithoutTenant(() => escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now: new Date(Date.now() + 1_000), limit: 1_000 }), 'test:l10-paging');
    expect(res.escalated).toContain(page.opsAlertId);
    const row = await alertRow(page.opsAlertId);
    expect(row.recipients.map((r) => r.userId)).toContain(superAdmin.userId);
    expect(row.escalationLevel).toBe(1);
    expect(oncallTexts().some((t) => (t as { body?: string }).body?.includes('UNACKNOWLEDGED'))).toBe(true);
    const pushed = await app.prisma.notification.count({ where: { userId: superAdmin.userId, data: { path: ['opsAlertId'], equals: page.opsAlertId } } });
    expect(pushed).toBeGreaterThanOrEqual(1);
  });

  it('re-resolves on EVERY sweep: a responder who appears inside the repeat window is attached and paged on the next tick', async () => {
    const page = await openAlert(null, []);
    const now = Date.now();
    // escalated a moment ago, so the repeat window is still closed
    await runWithoutTenant(() => app.prisma.opsAlert.update({ where: { id: page.opsAlertId }, data: { escalationLevel: 1, lastEscalatedAt: new Date(now), ackDeadlineAt: new Date(now - 60_000) } }), 'test:l10-paging');
    const res = await runWithoutTenant(() => escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now: new Date(now + 10_000), limit: 1_000 }), 'test:l10-paging');
    expect(res.escalated).not.toContain(page.opsAlertId);
    const row = await alertRow(page.opsAlertId);
    const mine = row.recipients.find((r) => r.userId === superAdmin.userId);
    expect(mine, 'the SUPER_ADMIN is attached on this tick').toBeDefined();
    expect(mine!.deliveredAt).not.toBeNull();
    expect(mine!.notificationId).toBeTruthy();
  });
});

describe('[144] platform pages: every SUPER_ADMIN in-app, plus a text to every on-call phone', () => {
  it('a staffed platform page reaches SUPER_ADMINs only (never a tenant ADMIN) and texts the on-call list at open', async () => {
    const res = await runWithoutTenant(() => openOpsAlert(app.prisma, notifications(), { kind: 'PLATFORM', tenantId: null, title: `L10 staffed ${RUN}`, body: 'Backups are not safe.', data: { kind: 'l10_test' } }), 'test:l10-paging');
    alertIds.push(res.opsAlertId);
    const row = await alertRow(res.opsAlertId);
    const ids = row.recipients.map((r) => r.userId);
    expect(ids).toContain(superAdmin.userId);
    expect(ids).not.toContain(adminA.userId);
    expect(ids).not.toContain(adminB.userId);
    const mine = row.recipients.find((r) => r.userId === superAdmin.userId)!;
    expect(mine.deliveredAt).not.toBeNull();
    expect(res.oncallTexted).toBe(1);
    expect(oncallTexts()).toHaveLength(1);
    expect((oncallTexts()[0] as { body?: string }).body).toContain(`L10 staffed ${RUN}`);
  });

  it('a tenant page reaches that tenant\'s ADMIN and the SUPER_ADMINs, and texts on-call too', async () => {
    const res = await runWithoutTenant(() => openOpsAlert(app.prisma, notifications(), { kind: 'SOS', tenantId: TENANT_B, title: `L10 tenant ${RUN}`, body: 'SOS.', data: { kind: 'l10_test' } }), 'test:l10-paging');
    alertIds.push(res.opsAlertId);
    const ids = (await alertRow(res.opsAlertId)).recipients.map((r) => r.userId);
    expect(ids).toEqual(expect.arrayContaining([adminB.userId, superAdmin.userId]));
    expect(ids).not.toContain(adminA.userId);
    expect(oncallTexts()).toHaveLength(1);
  });
});

describe('[M009] platform alerts belong to platform operators', () => {
  it('a tenant ADMIN lists only their own tenant\'s alerts; a SUPER_ADMIN lists the platform\'s and every tenant\'s', async () => {
    const platform = await openAlert(null, [superAdmin.userId]);
    const mine = await openAlert('swift-default', [adminA.userId]);
    const theirs = await openAlert(TENANT_B, [adminB.userId]);
    const asAdmin = await request('GET', '/api/v1/safety/ops-alerts', adminA.token);
    expect(asAdmin.statusCode).toBe(200);
    const adminIds = (asAdmin.json().data as Array<{ id: string; tenantId: string | null }>).map((r) => r.id);
    expect(adminIds).toContain(mine.opsAlertId);
    expect(adminIds).not.toContain(platform.opsAlertId);
    expect(adminIds).not.toContain(theirs.opsAlertId);
    const asSuper = await request('GET', '/api/v1/safety/ops-alerts', superAdmin.token);
    expect(asSuper.statusCode).toBe(200);
    const superIds = (asSuper.json().data as Array<{ id: string }>).map((r) => r.id);
    expect(superIds).toEqual(expect.arrayContaining([platform.opsAlertId, mine.opsAlertId, theirs.opsAlertId]));
  });

  it('a tenant ADMIN acknowledging a platform alert gets 403 and the alert stays open; another tenant\'s alert is not found', async () => {
    const platform = await openAlert(null, [superAdmin.userId]);
    const res = await request('POST', `/api/v1/safety/ops-alerts/${platform.opsAlertId}/ack`, adminA.token);
    expect(res.statusCode).toBe(403);
    expect((await alertRow(platform.opsAlertId)).acknowledgedAt).toBeNull();
    const theirs = await openAlert(TENANT_B, [adminB.userId]);
    const cross = await request('POST', `/api/v1/safety/ops-alerts/${theirs.opsAlertId}/ack`, adminA.token);
    expect(cross.statusCode).toBe(404);
    expect((await alertRow(theirs.opsAlertId)).acknowledgedAt).toBeNull();
  });

  it('a SUPER_ADMIN acknowledges a platform alert, with their receipt', async () => {
    const platform = await openAlert(null, [superAdmin.userId]);
    const res = await request('POST', `/api/v1/safety/ops-alerts/${platform.opsAlertId}/ack`, superAdmin.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.acknowledged).toBe(true);
    const row = await alertRow(platform.opsAlertId);
    expect(row.acknowledgedBy).toBe(superAdmin.userId);
    expect(row.recipients.find((r) => r.userId === superAdmin.userId)!.ackedAt).not.toBeNull();
  });

  it('a tenant ADMIN acknowledges their own tenant\'s alert', async () => {
    const mine = await openAlert('swift-default', [adminA.userId]);
    const res = await request('POST', `/api/v1/safety/ops-alerts/${mine.opsAlertId}/ack`, adminA.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.acknowledged).toBe(true);
  });

  it('only a platform operator can open a (platform) drill', async () => {
    const asAdmin = await request('POST', '/api/v1/safety/ops-alerts/drill', adminA.token);
    expect(asAdmin.statusCode).toBe(403);
  });
});

describe('[M076] an acknowledgement is a receipt and the alert, together, or nothing', () => {
  const ack = (opsAlertId: string, userId: string, observer?: Parameters<typeof acknowledgeOpsAlert>[1]['observer']) =>
    runWithoutTenant(() => acknowledgeOpsAlert(app.prisma, { opsAlertId, userId, ...(observer ? { observer } : {}) }), 'test:l10-paging');

  it('someone with no receipt and outside the alert\'s audience is refused; nothing is written', async () => {
    const platform = await openAlert(null, [superAdmin.userId]);
    const res = await ack(platform.opsAlertId, adminB.userId);
    expect(res.acknowledged).not.toContain(platform.opsAlertId);
    const row = await alertRow(platform.opsAlertId);
    expect(row.acknowledgedAt).toBeNull();
    expect(row.recipients.find((r) => r.userId === adminB.userId)).toBeUndefined();
  });

  it('a responder added since the page (in the audience today) acknowledges WITH a receipt row', async () => {
    const platform = await openAlert(null, []);
    const res = await ack(platform.opsAlertId, superAdmin.userId);
    expect(res.acknowledged).toContain(platform.opsAlertId);
    const row = await alertRow(platform.opsAlertId);
    expect(row.acknowledgedBy).toBe(superAdmin.userId);
    const receipt = row.recipients.find((r) => r.userId === superAdmin.userId);
    expect(receipt, 'the acknowledger has a receipt row').toBeDefined();
    expect(receipt!.ackedAt).not.toBeNull();
  });

  it('a failure between the receipt and the alert write leaves neither', async () => {
    const platform = await openAlert(null, [superAdmin.userId]);
    await expect(ack(platform.opsAlertId, superAdmin.userId, { betweenWrites: async () => { throw new Error('crash between writes'); } })).rejects.toThrow('crash between writes');
    const row = await alertRow(platform.opsAlertId);
    expect(row.acknowledgedAt).toBeNull();
    expect(row.recipients.find((r) => r.userId === superAdmin.userId)!.ackedAt).toBeNull();
  });

  it('two responders acknowledging at once: one wins, and only the winner holds a receipt', async () => {
    const second = await makeUser(['SUPER_ADMIN']);
    const platform = await openAlert(null, [superAdmin.userId, second.userId]);
    const [a, b] = await Promise.all([ack(platform.opsAlertId, superAdmin.userId), ack(platform.opsAlertId, second.userId)]);
    expect(a.acknowledged.length + b.acknowledged.length).toBe(1);
    const row = await alertRow(platform.opsAlertId);
    const receipts = row.recipients.filter((r) => r.ackedAt !== null);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.userId).toBe(row.acknowledgedBy);
  });
});

describe('[GUARDRAILS §3] an app-store reviewer\'s demo SOS never pages real operations', () => {
  it('a REVIEW-tenant page reaches no SUPER_ADMIN and texts no on-call phone: a new one is never opened (the review seal); one that already exists is never texted, escalated to the platform or given a SUPER_ADMIN', async () => {
    const reviewAdmin = await makeUser(['ADMIN'], TENANT_REVIEW);
    const res = await runWithoutTenant(() => openOpsAlert(app.prisma, notifications(), { kind: 'SOS', tenantId: TENANT_REVIEW, title: `L10 review SOS ${RUN}`, body: 'Demo.', data: { kind: 'l10_test' } }), 'test:l10-paging');
    expect(res).toEqual({ opsAlertId: '', recipients: 0, delivered: 0, oncallTexted: 0 });
    expect(oncallTexts()).toHaveLength(0);
    // A demo page that already exists (opened before the seal), overdue with nobody attached:
    // the sweep re-resolves its recipients and escalates it, but only inside the demo tenant.
    // (other open alerts may escalate in the same sweep: count only texts about this page)
    const reviewTexts = () => oncallTexts().filter((t) => ((t as { body?: string }).body ?? '').includes(`L10 review SOS ${RUN}`));
    const existing = await runWithoutTenant(() => app.prisma.opsAlert.create({ data: { tenantId: TENANT_REVIEW, kind: 'SOS', title: `L10 review SOS ${RUN}`, body: 'Demo.', ackDeadlineAt: new Date(Date.now() - 60_000) } }), 'test-fixture:l10-paging');
    alertIds.push(existing.id);
    const esc = await runWithoutTenant(() => escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now: new Date(), limit: 1_000 }), 'test:l10-paging');
    expect(esc.escalated).toContain(existing.id);
    expect(esc.platformPage).not.toContain(existing.id);
    expect(reviewTexts()).toHaveLength(0);
    const after = await alertRow(existing.id);
    expect(after.recipients.map((r) => r.userId)).toContain(reviewAdmin.userId);
    expect(after.recipients.map((r) => r.userId)).not.toContain(superAdmin.userId);
  });

  it('an admin notice about a REVIEW tenant reaches no SUPER_ADMIN', async () => {
    await makeUser(['ADMIN'], TENANT_REVIEW);
    await runWithoutTenant(() => notifyAdmins(app.prisma, notifications(), { tenantId: TENANT_REVIEW, title: 'Demo notice', body: 'Demo.', data: { kind: 'sos_marked_safe', probe: RUN } }), 'test:l10-paging');
    const reached = await app.prisma.notification.count({ where: { userId: superAdmin.userId, data: { path: ['probe'], equals: RUN } } });
    expect(reached).toBe(0);
  });

  it('a store-review demo SOS never reaches the platform war room: a new one is refused before it exists; one that already exists, and its repeat press, stay in the demo room; a real tenant\'s reach both', async () => {
    // A socket server that records every room an emit is addressed to.
    const emits: Array<{ event: string; rooms: string[]; sosAlertId: unknown }> = [];
    const capture = {
      to: (rooms: string | string[]) => ({ emit: (event: string, payload: { sosAlertId?: unknown }) => { emits.push({ event, rooms: [rooms].flat(), sosAlertId: payload?.sosAlertId }); return true; } }),
      in: () => ({ fetchSockets: async () => [] }),
    } as unknown as Server;
    const sos = new SosService(app.prisma, capture);
    const raised: Record<string, string> = {};
    try {
      // 1. The demo disposition: a reviewer's new SOS is refused before anything is written or emitted.
      const reviewer = await makeUser(['CUSTOMER'], TENANT_REVIEW);
      await expect(sos.create({ actorUserId: reviewer.userId, actorRole: 'CUSTOMER', immediate: true, lat: 6.8, lng: -58.15 })).rejects.toBeInstanceOf(ReviewDemoSosError);
      expect(await runWithoutTenant(() => app.prisma.sosAlert.count({ where: { actorUserId: reviewer.userId } }), 'test-read:l10-paging')).toBe(0);
      expect(emits).toHaveLength(0);
      // 2. A demo alert that already exists (raised before the seal): its live board event and a repeat press.
      const existing = await runWithoutTenant(() => app.prisma.sosAlert.create({ data: { actorUserId: reviewer.userId, actorRole: 'CUSTOMER', status: 'ACTIVE', triggerSource: 'BUTTON', triggeredAt: new Date(), tenantId: TENANT_REVIEW, triggerLat: 6.8, triggerLng: -58.15 } }), 'test-fixture:l10-paging');
      raised[TENANT_REVIEW] = existing.id;
      await runWithoutTenant(() => app.prisma.$transaction((tx) => stageEscalations(tx, existing)), 'test-fixture:l10-paging');
      await drainSosEscalations(app.prisma, capture, { alertIds: [existing.id] });
      await sos.create({ actorUserId: reviewer.userId, actorRole: 'CUSTOMER', immediate: true, lat: 6.81, lng: -58.16 });
      // 3. A real tenant's SOS and its repeat press.
      const person = await makeUser(['CUSTOMER'], TENANT_B);
      const real = await sos.create({ actorUserId: person.userId, actorRole: 'CUSTOMER', immediate: true, lat: 6.8, lng: -58.15 });
      raised[TENANT_B] = real.id;
      await drainSosEscalations(app.prisma, capture, { alertIds: [real.id] });
      await sos.create({ actorUserId: person.userId, actorRole: 'CUSTOMER', immediate: true, lat: 6.81, lng: -58.16 });

      const roomsFor = (tenantId: string, event: string) => emits.filter((e) => e.sosAlertId === raised[tenantId] && e.event === event).flatMap((e) => e.rooms);
      for (const event of ['sos:active', 'sos:retrigger']) {
        // Positive control: a real tenant's SOS reaches its own room AND the platform room.
        expect(roomsFor(TENANT_B, event), `real tenant ${event}`).toEqual(expect.arrayContaining([tenantWarRoom(TENANT_B), OPS_WAR_ROOM]));
        // The demo: only its own room, never the platform room.
        expect(roomsFor(TENANT_REVIEW, event), `review tenant ${event}`).toContain(tenantWarRoom(TENANT_REVIEW));
        expect(roomsFor(TENANT_REVIEW, event), `review tenant ${event}`).not.toContain(OPS_WAR_ROOM);
      }
    } finally {
      await runWithoutTenant(async () => {
        const ids = Object.values(raised);
        await app.prisma.evidenceBundle.deleteMany({ where: { sosAlertId: { in: ids } } }).catch(() => {});
        const pages = (await app.prisma.opsAlert.findMany({ where: { sosAlertId: { in: ids } }, select: { id: true } })).map((a) => a.id);
        await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: pages } } }).catch(() => {});
        await app.prisma.opsAlert.deleteMany({ where: { id: { in: pages } } }).catch(() => {});
        for (const id of ids) await app.prisma.notification.deleteMany({ where: { data: { path: ['sosAlertId'], equals: id } } }).catch(() => {});
        await app.prisma.sosAlert.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
      }, 'test-cleanup:l10-paging');
    }
  });
});

describe('[M009] a platform drill is a platform alert', () => {
  it('a SUPER_ADMIN\'s drill lands with no tenant, invisible to their own tenant\'s ADMIN', async () => {
    const res = await request('POST', '/api/v1/safety/ops-alerts/drill', superAdmin.token);
    expect(res.statusCode).toBe(200);
    const id = res.json().data.opsAlertId as string;
    alertIds.push(id);
    expect((await alertRow(id)).tenantId).toBeNull();
    const asAdmin = await request('GET', '/api/v1/safety/ops-alerts', adminA.token);
    expect((asAdmin.json().data as Array<{ id: string }>).map((r) => r.id)).not.toContain(id);
  });
});
