/**
 * [AUD-L4-016 · L04] The failed-delivery pager works under production's
 * CONTRACT tenant posture.
 *
 * Production's app login is walled per tenant (NOBYPASSRLS, not the table
 * owner); system work belongs on its own bypass-member login, with
 * TENANT_RLS_BIND=1 and TENANT_UNSCOPED_ACCESS=deny. A pager whose reads
 * stayed on the walled login would see ZERO failed rows: a failed SOS contact
 * text would page nobody in production while every test on the owner's login
 * stayed green.
 *
 * The suite runs the pager as the escalation tick runs it (named system work,
 * the production client shape over the walled login and the system login)
 * and asserts the effect through the suite's own owner connection: the real
 * failure is paged to on-call operations exactly once, and the store-review
 * fiction's failure — under the same posture — is not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { scopedPrisma as prisma, scopedClientFor } from '../plugins/prisma';
import { runAsSystem } from '../plugins/tenant-context';
import { NotificationService } from '../modules/notification/notification.service';
import { pageFailedSosEscalations } from '../modules/safety/sos-escalation';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const JOB = 'job:dispatch:promote-sos-grace';
const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, '0');
const TENANT_REAL = `aud-l4-016-posture-real-${RUN}`;
const TENANT_REVIEW = `aud-l4-016-posture-review-${RUN}`;
const ONCALL = `+5926${String(Date.now()).slice(-6)}3`;
const io = { to: () => ({ emit: () => true }), in: () => ({ fetchSockets: async () => [] }) } as unknown as Server;
const phoneBase = 592_742_000_000 + Math.floor(Math.random() * 50_000_000);
let seq = 0;
const phone = () => `+${phoneBase + (seq += 1)}`;

let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let probeRaw: PrismaClient;
let sysRaw: PrismaClient;
let walled: PrismaClient;
const userIds: string[] = [];
const alertIds: string[] = [];
let superAdminId = '';
let real = { alertId: '', rowId: '' };
let fiction = { alertId: '', rowId: '' };
const prior: Record<string, string | undefined> = {};

async function failedContactText(tenantId: string) {
  const user = await prisma.user.create({ data: {
    phone: phone(), firstName: 'Sos', lastName: `Posture ${RUN}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId, isPhoneVerified: true,
  } });
  userIds.push(user.id);
  const alert = await prisma.sosAlert.create({ data: { actorUserId: user.id, actorRole: 'CUSTOMER', status: 'ACTIVE', triggerSource: 'BUTTON', tenantId } });
  alertIds.push(alert.id);
  const row = await prisma.sosEscalation.create({ data: {
    tenantId, sosAlertId: alert.id, channel: 'CONTACT_SMS', targetKey: `target-${nanoid(6)}`, status: 'PENDING', attempts: 1, lastError: 'gateway down',
  } });
  return { alertId: alert.id, rowId: row.id };
}

beforeAll(async () => {
  logins = await createTenantProbeLogins(prisma, TEST_URL);
  await runAsSystem('test-setup', async () => {
    await prisma.tenant.create({ data: { id: TENANT_REAL, name: 'AUD-L4-016 posture real', slug: TENANT_REAL, isActive: true } });
    await prisma.tenant.create({ data: { id: TENANT_REVIEW, name: 'AUD-L4-016 posture review', slug: TENANT_REVIEW, isActive: true, kind: 'REVIEW' } });
    superAdminId = (await prisma.user.create({ data: {
      phone: phone(), firstName: 'Ops', lastName: `Posture ${RUN}`, roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    } })).id;
    userIds.push(superAdminId);
    real = await failedContactText(TENANT_REAL);
    fiction = await failedContactText(TENANT_REVIEW);
  });
  probeRaw = new PrismaClient({ datasourceUrl: logins.requestUrl });
  sysRaw = new PrismaClient({ datasourceUrl: logins.systemUrl });
  walled = scopedClientFor(probeRaw, sysRaw);
  for (const k of ['TENANT_RLS_BIND', 'TENANT_UNSCOPED_ACCESS', 'OPS_ONCALL_PHONES']) prior[k] = process.env[k];
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['OPS_ONCALL_PHONES'] = ONCALL;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    await runAsSystem('test-teardown', async () => {
      const opsAlerts = await prisma.opsAlert.findMany({ where: { sosAlertId: { in: alertIds } }, select: { id: true } });
      await prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: opsAlerts.map((a) => a.id) } } }).catch(() => {});
      await prisma.opsAlert.deleteMany({ where: { id: { in: opsAlerts.map((a) => a.id) } } }).catch(() => {});
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: userIds } }, ...alertIds.map((id) => ({ data: { path: ['sosAlertId'], equals: id } }))] } }).catch(() => {});
      await prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_REAL, TENANT_REVIEW] } } }).catch(() => {});
    });
  } finally {
    await probeRaw?.$disconnect().catch(() => {});
    await sysRaw?.$disconnect().catch(() => {});
    await logins?.cleanup();
  }
});

describe('[AUD-L4-016] the failed-delivery pager under the production CONTRACT posture', () => {
  it('reads the failed row on the system login and pages on-call operations once; the fiction’s failure is not paged', async () => {
    resetDevChannelLog();
    const res = await runAsSystem(JOB, () => pageFailedSosEscalations(walled, new NotificationService(walled, io), { alertIds: [real.alertId, fiction.alertId] }));
    expect(res.paged, 'the pager read nothing on the walled login: a failed SOS text would page nobody in production').toEqual([real.rowId]);

    const effect = await runAsSystem('test-read', async () => ({
      row: await prisma.sosEscalation.findUniqueOrThrow({ where: { id: real.rowId }, select: { failurePageOpsAlertId: true } }),
      realPages: await prisma.opsAlert.findMany({ where: { sosAlertId: real.alertId, kind: 'SOS' }, select: { id: true, title: true, tenantId: true } }),
      fictionPages: await prisma.opsAlert.count({ where: { sosAlertId: fiction.alertId } }),
      notices: await prisma.notification.count({ where: { userId: superAdminId, data: { path: ['sosAlertId'], equals: real.alertId } } }),
    }));
    expect(effect.realPages).toHaveLength(1);
    expect(effect.realPages[0]).toMatchObject({ title: 'URGENT: SOS contact text failed — call the person now', tenantId: TENANT_REAL });
    expect(effect.row.failurePageOpsAlertId).toBe(effect.realPages[0]!.id);
    expect(effect.notices, 'SUPER_ADMIN was not told in the app').toBe(1);
    expect(devChannelLog.filter((e) => e.channel === 'sms' && (e as { to?: string }).to === ONCALL), 'the on-call phone was not texted').toHaveLength(1);
    expect(effect.fictionPages, 'the store-review fiction paged real operations').toBe(0);

    // Exactly once under the posture too: the next tick pages nothing more.
    expect((await runAsSystem(JOB, () => pageFailedSosEscalations(walled, new NotificationService(walled, io), { alertIds: [real.alertId, fiction.alertId] }))).paged).toEqual([]);
  });
});
