import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Server } from 'socket.io';
import type { UserRole, UserStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { runWithoutTenant } from '../plugins/tenant-context';
import { NotificationService } from '../modules/notification/notification.service';
import { resolveOpsResponders } from '../modules/safety/ops-alert';
import { BACKUP_PAGE_TITLE, LAST_BACKUP_KEY, LAST_BACKUP_OFFSITE_KEY, pageBackupFreshness } from '../modules/ops/backup-freshness';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';

// ---------------------------------------------------------------------------
// [144 · 75] Who a page reaches is explicit and tested: every ACTIVE
// SUPER_ADMIN in-app (a tenant's page adds that tenant's ADMINs) plus a text
// to every configured OPS_ONCALL_PHONES number (coordinator ruling, 5 Oct
// 2026; whether launch staff hold SUPER_ADMIN or a narrower responder role is
// an open owner question, so this is today's audience). The stale-backup
// alarm is one such platform page: it reaches a recipient, durably.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const TENANT_B = `l10-resp-b-${RUN}`;
const userIds: string[] = [];
const phoneBase = 592_740_000_000 + Math.floor(Math.random() * 100_000_000);
const ONCALL_A = `+5927${String(Date.now()).slice(-6)}2`;
const ONCALL_B = `+5927${String(Date.now()).slice(-6)}3`;
let seq = 0;
const io = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) } as unknown as Server;

async function makeUser(roles: UserRole[], tenantId?: string, status: UserStatus = 'ACTIVE') {
  seq += 1;
  const user = await runWithoutTenant(() => app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Resp', lastName: `L10${RUN}${seq}`, roles, activeRole: roles[0]!, status, isPhoneVerified: true, ...(tenantId ? { tenantId } : {}) },
  }), 'test-fixture:l10-responders');
  userIds.push(user.id);
  return user.id;
}

let superAdmin: string; let suspendedSuper: string; let adminA: string; let adminB: string; let customer: string;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.ready();
  await runWithoutTenant(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'L10 responders tenant B', slug: TENANT_B, isActive: true } }), 'test-fixture:l10-responders');
  superAdmin = await makeUser(['SUPER_ADMIN']);
  suspendedSuper = await makeUser(['SUPER_ADMIN'], undefined, 'SUSPENDED');
  adminA = await makeUser(['ADMIN']);
  adminB = await makeUser(['ADMIN'], TENANT_B);
  customer = await makeUser(['CUSTOMER']);
});

beforeEach(() => resetDevChannelLog());
afterEach(() => { delete process.env['OPS_ONCALL_PHONES']; });

afterAll(async () => {
  await runWithoutTenant(async () => {
    const rows = await app.prisma.opsAlert.findMany({ where: { title: BACKUP_PAGE_TITLE }, select: { id: true } });
    await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: rows.map((r) => r.id) } } }).catch(() => {});
    await app.prisma.opsAlert.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }).catch(() => {});
    await app.prisma.platformConfig.deleteMany({ where: { key: { in: [LAST_BACKUP_KEY, LAST_BACKUP_OFFSITE_KEY] } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.prisma.tenant.delete({ where: { id: TENANT_B } }).catch(() => {});
  }, 'test-cleanup:l10-responders');
  await app.redis.del('ops_page:backup-freshness').catch(() => {});
  await app.close();
});

describe('[144] responder resolution is explicit', () => {
  it('a platform page: every ACTIVE SUPER_ADMIN, nobody else, plus every well-formed on-call phone', async () => {
    const env = { OPS_ONCALL_PHONES: ` ${ONCALL_A}, not-a-phone ,${ONCALL_B},` };
    const r = await resolveOpsResponders(app.prisma, null, env);
    expect(r.userIds).toContain(superAdmin);
    for (const excluded of [suspendedSuper, adminA, adminB, customer]) expect(r.userIds).not.toContain(excluded);
    expect(r.oncallPhones).toEqual([ONCALL_A, ONCALL_B]);
  });

  it('a tenant page: that tenant\'s ADMINs and every SUPER_ADMIN, never another tenant\'s ADMIN', async () => {
    const r = await resolveOpsResponders(app.prisma, TENANT_B, {});
    expect(r.userIds).toEqual(expect.arrayContaining([adminB, superAdmin]));
    expect(r.userIds).not.toContain(adminA);
    expect(r.userIds).not.toContain(customer);
    expect(r.oncallPhones).toEqual([]);
  });
});

describe('[75] the stale-backup page reaches a recipient', () => {
  it('a stale backup opens a durable platform page: the SUPER_ADMIN is notified, the on-call phone texted', async () => {
    process.env['OPS_ONCALL_PHONES'] = ONCALL_A;
    await runWithoutTenant(() => app.prisma.platformConfig.deleteMany({ where: { key: { in: [LAST_BACKUP_KEY, LAST_BACKUP_OFFSITE_KEY] } } }), 'test:l10-responders');
    await app.redis.del('ops_page:backup-freshness');
    const { result, page } = await runWithoutTenant(() => pageBackupFreshness({ prisma: app.prisma, redis: app.redis, notifications: new NotificationService(app.prisma, io) }), 'test:l10-responders');
    expect(result.stale).toBe(true);
    expect(page?.status).toBe('delivered');
    const alert = await runWithoutTenant(() => app.prisma.opsAlert.findFirstOrThrow({ where: { title: BACKUP_PAGE_TITLE, closedAt: null }, include: { recipients: true } }), 'test:l10-responders');
    expect(alert.kind).toBe('PLATFORM');
    expect(alert.tenantId).toBeNull();
    const mine = alert.recipients.find((r) => r.userId === superAdmin);
    expect(mine?.deliveredAt).not.toBeNull();
    const inbox = await app.prisma.notification.count({ where: { userId: superAdmin, data: { path: ['opsAlertId'], equals: alert.id } } });
    expect(inbox).toBe(1);
    expect(alert.recipients.map((r) => r.userId)).not.toContain(adminA);
    expect(devChannelLog.filter((e) => e.channel === 'sms' && (e as { to?: string }).to === ONCALL_A)).toHaveLength(1);
  });

  it('a fresh backup closes the open page', async () => {
    await runWithoutTenant(() => app.prisma.platformConfig.upsert({ where: { key: LAST_BACKUP_KEY }, create: { key: LAST_BACKUP_KEY, value: new Date().toISOString() }, update: { value: new Date().toISOString() } }), 'test:l10-responders');
    await runWithoutTenant(() => app.prisma.platformConfig.upsert({ where: { key: LAST_BACKUP_OFFSITE_KEY }, create: { key: LAST_BACKUP_OFFSITE_KEY, value: true }, update: { value: true } }), 'test:l10-responders');
    const { result, page } = await runWithoutTenant(() => pageBackupFreshness({ prisma: app.prisma, redis: app.redis, notifications: new NotificationService(app.prisma, io) }), 'test:l10-responders');
    expect(result.stale).toBe(false);
    expect(page).toBeNull();
    const open = await runWithoutTenant(() => app.prisma.opsAlert.count({ where: { title: BACKUP_PAGE_TITLE, closedAt: null } }), 'test:l10-responders');
    expect(open).toBe(0);
  });
});
