import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { NotificationService } from '../modules/notification/notification.service';
import { pageOps, resolveOpsPage } from '../modules/ops/ops-page';
import { escalateOverdueOpsAlerts } from '../modules/safety/ops-alert';
import { opsAlertCounter, opsPageCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [R048-006] A platform page is successful only with durable delivery intent
// to a staffed recipient. With nobody to reach, the page is an OPEN OpsAlert
// row (pending, escalation-eligible) and the dedupe key is released so the
// next probe retries — never a claimed key over nothing. With a recipient the
// page is delivered once per window. One open page per title, so a probe
// every thirty seconds does not storm the outbox. When the condition clears,
// the page is closed. The escalation sweep attaches recipients that appear
// after the page was opened.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const TITLE = `Job scheduler stalled [test ${RUN}]`;
const KEY = `ops_page:test-${RUN}`;
const userIds: string[] = [];
const alertIds: string[] = [];
const phoneBase = 592_780_000_000 + Math.floor(Math.random() * 100_000_000);

const pageCount = async (outcome: string) => (await opsPageCounter.get()).values.find((v) => v.labels['outcome'] === outcome)?.value ?? 0;
const alertCount = async (event: string) => (await opsAlertCounter.get()).values.find((v) => v.labels['event'] === event)?.value ?? 0;
const openAlerts = () => app.prisma.opsAlert.findMany({ where: { kind: 'PLATFORM', title: TITLE, closedAt: null }, include: { recipients: true } });

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.ready();
  vi.spyOn(NotificationService.prototype, 'send').mockImplementation(async () => `notif-${nanoid(6)}`);
});
afterAll(async () => {
  await runWithoutTenant(async () => {
    const rows = await app.prisma.opsAlert.findMany({ where: { OR: [{ id: { in: alertIds } }, { title: TITLE }] }, select: { id: true } });
    await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: rows.map((r) => r.id) } } }).catch(() => {});
    await app.prisma.opsAlert.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:ops-page');
  await app.redis.del(KEY).catch(() => {});
  await app.close();
});

const deps = (recipients: string[]) => ({ prisma: app.prisma, redis: app.redis, notifications: new NotificationService(app.prisma, app.io as never), resolveRecipients: async () => recipients });
const input = { key: KEY, title: TITLE, body: 'No scheduler heartbeat for 7 min.', data: { kind: 'ops_scheduler_stall', ageMs: 420_000 } };

describe('[R048-006] nobody staffed: the page is PENDING, durable and retryable — never a claimed key over nothing', () => {
  it('opens the outbox row with zero recipients, releases the dedupe key, counts it; a second probe finds the open page and opens no other', async () => {
    const before = await pageCount('zero_recipient_pending');
    const first = await pageOps(deps([]), input);
    expect(first.status).toBe('pending');
    alertIds.push((first as { opsAlertId: string }).opsAlertId);
    const rows = await openAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipients).toHaveLength(0);
    expect(rows[0]!.acknowledgedAt).toBeNull();
    expect(await app.redis.exists(KEY)).toBe(0); // released: the next probe retries instead of trusting a page that never happened
    expect(await pageCount('zero_recipient_pending')).toBe(before + 1);
    // the next probe, thirty seconds later
    const second = await pageOps(deps([]), input);
    expect(second.status).toBe('pending');
    expect((second as { opsAlertId: string }).opsAlertId).toBe(rows[0]!.id);
    expect(await openAlerts()).toHaveLength(1); // no storm
    expect(await app.redis.exists(KEY)).toBe(0);
  });

  it('the escalation sweep attaches an admin who appears later and notifies them on that pass', async () => {
    const admin = await runWithoutTenant(() => app.prisma.user.create({ data: { phone: `+${phoneBase + 1}`, firstName: 'Ops', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true } }), 'test-fixture:ops-page');
    userIds.push(admin.id);
    const [open] = await openAlerts();
    await app.prisma.opsAlert.update({ where: { id: open!.id }, data: { ackDeadlineAt: new Date(Date.now() - 60_000) } }); // overdue
    const before = await alertCount('recipients_attached_late');
    const sendSpy = vi.spyOn(NotificationService.prototype, 'send').mockImplementation(async () => `notif-${nanoid(6)}`);
    const res = await escalateOverdueOpsAlerts(app.prisma, new NotificationService(app.prisma, app.io as never), null, { now: new Date(), limit: 200 });
    expect(res.escalated).toContain(open!.id);
    expect(await alertCount('recipients_attached_late')).toBe(before + 1);
    const after = await app.prisma.opsAlert.findUniqueOrThrow({ where: { id: open!.id }, include: { recipients: true } });
    expect(after.recipients.map((r) => r.userId)).toContain(admin.id);
    expect(after.escalationLevel).toBeGreaterThanOrEqual(1);
    expect(sendSpy.mock.calls.some((c) => (c[0] as { userId: string }).userId === admin.id)).toBe(true);
    // and the page is now a delivered intent, not a pending one
    const again = await pageOps(deps([]), input);
    expect(again.status).toBe('deduped');
  });

  it('when the condition clears the open page is closed with its reason, and a fresh page can go out later', async () => {
    const before = await pageCount('resolved');
    const closed = await resolveOpsPage(app.prisma, TITLE);
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(await openAlerts()).toHaveLength(0);
    expect(await pageCount('resolved')).toBeGreaterThanOrEqual(before + 1);
    const row = await app.prisma.opsAlert.findFirst({ where: { title: TITLE, closedAt: { not: null } }, select: { closeReason: true } });
    expect(row?.closeReason).toBe('condition-cleared');
  });
});

describe('[R048-006] somebody staffed: delivered once per window', () => {
  it('opens the row with recipients, delivers, holds the dedupe key; the second probe inside the window is deduped; a stale key over a closed page does not hide a new page', async () => {
    const adminId = userIds[0]!;
    const before = await pageCount('delivered');
    const res = await pageOps(deps([adminId]), input);
    expect(res.status).toBe('delivered');
    expect((res as { recipients: number }).recipients).toBe(1);
    alertIds.push((res as { opsAlertId: string }).opsAlertId);
    const [row] = await openAlerts();
    expect(row!.recipients.map((r) => r.userId)).toEqual([adminId]);
    expect(row!.recipients[0]!.notificationId).not.toBeNull();
    expect(await app.redis.exists(KEY)).toBe(1);
    expect(await pageCount('delivered')).toBe(before + 1);
    const again = await pageOps(deps([adminId]), input);
    expect(again.status).toBe('deduped');
    expect(await openAlerts()).toHaveLength(1);
    // the condition clears (page closed), then recurs while the old key still lives: a NEW page opens, key or no key
    await resolveOpsPage(app.prisma, TITLE);
    const recurred = await pageOps(deps([adminId]), input);
    expect(recurred.status).toBe('deduped'); // the window from the delivered page still holds
    await app.redis.del(KEY);
    const afterWindow = await pageOps(deps([adminId]), input);
    expect(afterWindow.status).toBe('delivered');
    alertIds.push((afterWindow as { opsAlertId: string }).opsAlertId);
  });

  it('a delivery failure releases the key (the next probe re-pages) and leaves no half-open state', async () => {
    await resolveOpsPage(app.prisma, TITLE);
    await app.redis.del(KEY);
    const failing = { ...deps([userIds[0]!]), notifications: { send: async () => { throw new Error('provider down'); } } as unknown as NotificationService };
    // openOpsAlert catches per-recipient send failures and counts delivered=0 — the row exists with its recipient, intent is durable
    const res = await pageOps(failing, input);
    expect(res.status).toBe('delivered');
    alertIds.push((res as { opsAlertId: string }).opsAlertId);
    const [row] = await openAlerts();
    expect(row!.recipients).toHaveLength(1);
    expect(row!.recipients[0]!.deliveredAt).toBeNull(); // undelivered, escalation covers it
  });
});
