import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { SosService } from '../modules/safety/sos.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getChannels } from '../providers/notifications/channels';
import { escalateOverdueOpsAlerts, syncOpsAlertReadReceipts, scanOpsAlerts, runOpsAlertDrillIfDue, acknowledgeOpsAlert } from '../modules/safety/ops-alert';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';

// Trip Guardian M4c — the graduated check-in ladder (§5.3, self-test §14-E):
// L2 soft check-in → L3 hard check-in with a server deadline → L4 auto-SOS.
// The full climb is driven with scripted GPS through FRESH GuardianService
// instances per tick (worker-restart proof); responses go through the real
// authed routes. Scripted timestamps sit in the PAST so the ladder's deadline
// arithmetic works against real-clock responses.

let app: FastifyInstance;
const emits: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];

const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
const phoneBase = 592_720_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Ladder',
      lastName: `U${seq}`,
      roles,
      activeRole: roles[0]!,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...extra,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'grd', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}





const post = (url: string, payload: unknown, token?: string) =>
  app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

beforeEach(() => { resetDevChannelLog(); emits.length = 0; });

afterAll(async () => {
  await app.prisma.opsAlert.deleteMany({ where: { OR: [{ id: { in: opsAlertIds } }, { sosAlertId: { in: alertIds } }] } }).catch(() => {});
  await app.prisma.evidenceBundle.deleteMany({ where: { sosAlertId: { in: alertIds } } }).catch(() => {});
  await app.prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } }).catch(() => {});
  delete process.env['GUARDIAN_AUTONOTIFY_CONTACTS'];
  await app.prisma.tripSafetySession.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.sosAlert.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { counterpartyUserId: { in: userIds } }] } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.emergencyContact.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});


// ---------------------------------------------------------------------------
// [S-19] War-room socket membership is not delivery acknowledgement.
//
// The register's red test: a connected socket that never ACKs — the fallback
// page and escalation must fire by the SLO. Around it: a human's
// acknowledgement (the SOS ack, or the explicit endpoint) meets the
// obligation; a read receipt is "seen", never "acknowledged"; an emergency
// that ends unacknowledged closes the alert and says so; the rollback pauses
// escalation and never downgrades the record; drills run the same path.
// ---------------------------------------------------------------------------

const io = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [{ id: 'connected-but-silent' }] }) } as unknown as Server;
const sos = () => new SosService(app.prisma, io);
const notifications = () => new NotificationService(app.prisma, io);
const alertIds: string[] = []; const opsAlertIds: string[] = [];
const ONCALL = `+5927${String(Date.now()).slice(-8)}`;
const opsAlertFor = (sosAlertId: string) => app.prisma.opsAlert.findFirstOrThrow({ where: { sosAlertId }, include: { recipients: true } });
const escalationPushes = (userId: string) => app.prisma.notification.count({ where: { userId, data: { path: ['kind'], equals: 'ops_alert_escalated' } } });
const oncallTexts = () => devChannelLog.filter((e) => e.channel === 'sms' && (e as { to?: string }).to === ONCALL).length;

async function activeSos() {
  const passenger = await makeUser(['CUSTOMER']);
  const admin = await makeUser(['ADMIN']);
  // a privileged session needs its assurance (the auth plugin refuses an ADMIN session without one)
  await app.prisma.session.updateMany({ where: { userId: admin.userId }, data: { authMethod: 'OTP' } });
  const alert = await sos().create({ actorUserId: passenger.userId, actorRole: 'CUSTOMER', immediate: true, lat: 6.8, lng: -58.15 });
  alertIds.push(alert.id);
  const page = await opsAlertFor(alert.id);
  opsAlertIds.push(page.id);
  return { passenger, admin, alert, page };
}

beforeEach(() => { process.env['OPS_ONCALL_PHONES'] = ONCALL; });
afterEach(() => { delete process.env['OPS_ONCALL_PHONES']; delete process.env['OPS_ALERT_ESCALATION_KILL']; });

describe('[S-19] the register’s red test: a connected socket that never acknowledges', () => {
  it('the page is a durable obligation with per-recipient delivery; nobody acknowledges; by the deadline it escalates — re-push, on-call text, level up — and keeps escalating', async () => {
    const { admin, alert, page } = await activeSos();
    expect(page.kind).toBe('SOS'); expect(page.acknowledgedAt).toBeNull();
    const me = page.recipients.find((r) => r.userId === admin.userId)!;
    expect(me).toBeDefined(); expect(me.deliveredAt).not.toBeNull(); expect(me.notificationId).toBeTruthy(); expect(me.ackedAt).toBeNull();
    // the room had a socket the whole time; that is not receipt
    const receipts = (await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: alert.id } })).deliveryReceipts as Record<string, unknown>;
    expect(receipts['socketListeners']).toBe(1);
    // before the deadline: nothing
    const before = await escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now: new Date(page.ackDeadlineAt.getTime() - 1000) });
    expect(before.escalated).not.toContain(page.id);
    // the deadline passes with no acknowledgement
    const t1 = new Date(page.ackDeadlineAt.getTime() + 1000);
    const first = await escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now: t1 });
    expect(first.escalated).toContain(page.id);
    expect((await opsAlertFor(alert.id)).escalationLevel).toBe(1);
    expect(await escalationPushes(admin.userId)).toBe(1);
    expect(oncallTexts()).toBe(1);
    expect(devChannelLog.find((e) => e.channel === 'sms' && (e as { to?: string }).to === ONCALL)).toMatchObject({ body: expect.stringContaining('UNACKNOWLEDGED') });
    // too soon to repeat
    const soon = await escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now: new Date(t1.getTime() + 10_000) });
    expect(soon.escalated).not.toContain(page.id);
    // and again after the repeat window
    const later = await escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now: new Date(t1.getTime() + 301_000) });
    expect(later.escalated).toContain(page.id);
    expect((await opsAlertFor(alert.id)).escalationLevel).toBe(2);
    expect(await escalationPushes(admin.userId)).toBe(2);
    const scan = await scanOpsAlerts(app.prisma, new Date(t1.getTime() + 301_000));
    expect(scan.unacknowledgedOverdue).toBeGreaterThanOrEqual(1);
  });

  it('a human’s acknowledgement — the SOS ack, or the explicit endpoint — meets the obligation and stops the escalation; a passenger cannot acknowledge', async () => {
    const a = await activeSos();
    await sos().ack(a.alert.id, a.admin.userId);
    const acked = await opsAlertFor(a.alert.id);
    expect(acked.acknowledgedBy).toBe(a.admin.userId);
    expect(acked.recipients.find((r) => r.userId === a.admin.userId)!.ackedAt).not.toBeNull();
    const res = await escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now: new Date(acked.ackDeadlineAt.getTime() + 1000) });
    expect(res.escalated).not.toContain(acked.id);
    const b = await activeSos();
    expect((await post(`/api/v1/safety/ops-alerts/${b.page.id}/ack`, {}, b.passenger.token)).statusCode).toBe(403);
    const ok = await post(`/api/v1/safety/ops-alerts/${b.page.id}/ack`, {}, b.admin.token);
    expect(ok.statusCode).toBe(200); expect(ok.json().data.acknowledged).toBe(true);
    expect((await opsAlertFor(b.alert.id)).acknowledgedBy).toBe(b.admin.userId);
    const list = await app.inject({ method: 'GET', url: '/api/v1/safety/ops-alerts', headers: { authorization: `Bearer ${b.admin.token}` } });
    expect(list.statusCode).toBe(200);
    expect((list.json().data as Array<{ id: string }>).some((r) => r.id === b.page.id)).toBe(false);
  });
});

describe('[S-19] seen is not acknowledged; the emergency ending; the rollback; drills', () => {
  it('a read receipt records SEEN and still escalates', async () => {
    const { admin, alert, page } = await activeSos();
    const me = page.recipients.find((r) => r.userId === admin.userId)!;
    await app.prisma.notification.update({ where: { id: me.notificationId! }, data: { isRead: true, readAt: new Date() } });
    expect(await syncOpsAlertReadReceipts(app.prisma)).toBeGreaterThanOrEqual(1);
    const seen = (await opsAlertFor(alert.id)).recipients.find((r) => r.userId === admin.userId)!;
    expect(seen.seenAt).not.toBeNull(); expect(seen.ackedAt).toBeNull();
    const res = await escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now: new Date(page.ackDeadlineAt.getTime() + 1000) });
    expect(res.escalated).toContain(page.id);
  });

  it('an emergency that ends unacknowledged closes the alert and says so', async () => {
    const { alert, page } = await activeSos();
    await app.prisma.sosAlert.update({ where: { id: alert.id }, data: { status: 'RESOLVED' } });
    const res = await escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now: new Date(page.ackDeadlineAt.getTime() + 1000) });
    expect(res.closed).toContain(page.id);
    expect(await opsAlertFor(alert.id)).toMatchObject({ acknowledgedAt: null, closeReason: 'sos-resolved-unacknowledged' });
  });

  it('the rollback pauses escalation and never downgrades the record to acknowledged', async () => {
    const { alert, page } = await activeSos();
    process.env['OPS_ALERT_ESCALATION_KILL'] = '1';
    const res = await escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now: new Date(page.ackDeadlineAt.getTime() + 1000) });
    expect(res.escalated).not.toContain(page.id);
    expect(await opsAlertFor(alert.id)).toMatchObject({ acknowledgedAt: null, escalationLevel: 0 });
    expect(oncallTexts()).toBe(0);
  });

  it('drills run the same path on schedule, once per interval, and the last drill’s acknowledgement latency is a gauge', async () => {
    await app.prisma.opsAlert.deleteMany({ where: { kind: 'DRILL' } });
    const first = await runOpsAlertDrillIfDue(app.prisma, notifications());
    expect(first.opened).toBeTruthy(); opsAlertIds.push(first.opened!);
    const drill = await app.prisma.opsAlert.findUniqueOrThrow({ where: { id: first.opened! } });
    expect(drill.kind).toBe('DRILL'); expect(drill.tenantId).toBeNull();
    expect((await runOpsAlertDrillIfDue(app.prisma, notifications())).opened).toBeNull();
    const superAdmin = await app.prisma.user.findFirst({ where: { roles: { has: 'SUPER_ADMIN' }, status: 'ACTIVE' }, select: { id: true } });
    await acknowledgeOpsAlert(app.prisma, { opsAlertId: drill.id, userId: superAdmin?.id ?? 'ops' });
    const scan = await scanOpsAlerts(app.prisma);
    expect(scan.lastDrillAckSeconds).not.toBeNull();
    expect(scan.lastDrillAckSeconds!).toBeGreaterThanOrEqual(0);
  });
});
