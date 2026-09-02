import type { PrismaClient, OpsAlertKind } from '@prisma/client';
import { NotificationService } from '../notification/notification.service';
import { runWithoutTenant } from '../../plugins/tenant-context';
import { log } from '../../utils/logger';
import { opsAlertCounter, opsAlertGauge } from '../../plugins/observability';

/**
 * [S-19] War-room socket membership is not delivery acknowledgement.
 *
 * Stop-ship register S-19: the SOS fan-out counted the sockets in the
 * war-room and wrote that number as if it were an audience. A connected but
 * backgrounded or broken client, a lost event, or no consumer at all all
 * count the same — the record implied presence while no human saw the SOS.
 *
 * An ops page is now an OpsAlert: a durable obligation with a row PER
 * RECIPIENT (delivered = the notification persisted; seen = the device's
 * read receipt; acked = a human acknowledged) and an ACKNOWLEDGEMENT
 * DEADLINE. Nobody acknowledged by the deadline → the alert escalates: every
 * recipient is pushed again, the on-call tree is texted, the platform is
 * paged, and it repeats until a human acknowledges it or the emergency
 * ends. A read receipt is "seen", never "acknowledged". Listener counts are
 * diagnostic only. Periodic drills exercise the same path with real people.
 * The rollback pauses escalation and never downgrades emit to delivered.
 */
export const ackDeadlineSeconds = () => { const n = Number(process.env['OPS_ALERT_ACK_DEADLINE_SECONDS'] ?? 120); return Number.isFinite(n) && n > 0 ? n : 120; };
export const escalationRepeatSeconds = () => { const n = Number(process.env['OPS_ALERT_ESCALATION_REPEAT_SECONDS'] ?? 300); return Number.isFinite(n) && n > 0 ? n : 300; };
export const drillIntervalDays = () => { const n = Number(process.env['OPS_ALERT_DRILL_INTERVAL_DAYS'] ?? 7); return Number.isFinite(n) && n >= 0 ? n : 7; };
export const onCallPhones = (env: Record<string, string | undefined> = process.env): string[] => (env['OPS_ONCALL_PHONES'] ?? '').split(',').map((p) => p.trim()).filter((p) => /^\+[1-9]\d{6,14}$/.test(p));
export const opsAlertEscalationKilled = (env: Record<string, string | undefined> = process.env) => env['OPS_ALERT_ESCALATION_KILL'] === '1';

/** The same audience `notifyAdmins` pages [NOC-A F45]: a tenant's ADMINs plus every SUPER_ADMIN; NULL = platform operators only. */
async function adminRecipientIds(prisma: PrismaClient, tenantId: string | null): Promise<string[]> {
  const admins = await runWithoutTenant(() => prisma.user.findMany({
    where: tenantId
      ? { status: 'ACTIVE', roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] }, OR: [{ tenantId }, { roles: { has: 'SUPER_ADMIN' } }] }
      : { status: 'ACTIVE', roles: { has: 'SUPER_ADMIN' } },
    select: { id: true },
  }));
  return admins.map((a) => a.id);
}

/** Open the obligation and deliver it: one recipient row per admin, each
 *  with the persisted notification as its delivery proof. */
export async function openOpsAlert(
  prisma: PrismaClient,
  notifications: NotificationService,
  input: { kind: OpsAlertKind; tenantId: string | null; sosAlertId?: string | null; title: string; body: string; data: Record<string, unknown>; now?: Date },
): Promise<{ opsAlertId: string; recipients: number; delivered: number }> {
  const now = input.now ?? new Date();
  const userIds = await adminRecipientIds(prisma, input.tenantId);
  const alert = await prisma.opsAlert.create({
    data: {
      tenantId: input.tenantId, kind: input.kind, sosAlertId: input.sosAlertId ?? null, title: input.title, body: input.body,
      ackDeadlineAt: new Date(now.getTime() + ackDeadlineSeconds() * 1000),
      recipients: { create: userIds.map((userId) => ({ tenantId: input.tenantId, userId })) },
    },
    include: { recipients: true },
  });
  let delivered = 0;
  for (const r of alert.recipients) {
    try {
      const id = await notifications.send({ userId: r.userId, type: 'SYSTEM_ANNOUNCEMENT', title: input.title, body: input.body, data: { ...input.data, opsAlertId: alert.id } });
      if (id) { delivered += 1; await prisma.opsAlertRecipient.update({ where: { id: r.id }, data: { notificationId: id, deliveredAt: now } }); }
    } catch (err) {
      log().error({ err, opsAlertId: alert.id, userId: r.userId }, '[S-19] ops alert delivery failed for a recipient — escalation covers it');
    }
  }
  opsAlertCounter.labels('opened').inc();
  if (userIds.length === 0) { opsAlertCounter.labels('zero_recipients').inc(); log().error({ opsAlertId: alert.id, tenantId: input.tenantId }, '[S-19] ops alert has NO recipients — nobody can acknowledge it'); }
  return { opsAlertId: alert.id, recipients: userIds.length, delivered };
}

/** A human acknowledged: the recipient row and the alert, first ack wins. */
export async function acknowledgeOpsAlert(prisma: PrismaClient, input: { opsAlertId?: string; sosAlertId?: string; userId: string; now?: Date }): Promise<{ acknowledged: string[] }> {
  const now = input.now ?? new Date();
  const alerts = await prisma.opsAlert.findMany({ where: { ...(input.opsAlertId ? { id: input.opsAlertId } : {}), ...(input.sosAlertId ? { sosAlertId: input.sosAlertId } : {}), acknowledgedAt: null }, select: { id: true } });
  const acknowledged: string[] = [];
  for (const a of alerts) {
    await prisma.opsAlertRecipient.updateMany({ where: { opsAlertId: a.id, userId: input.userId }, data: { ackedAt: now, seenAt: now } });
    const res = await prisma.opsAlert.updateMany({ where: { id: a.id, acknowledgedAt: null }, data: { acknowledgedAt: now, acknowledgedBy: input.userId } });
    if (res.count === 1) { acknowledged.push(a.id); opsAlertCounter.labels('acknowledged').inc(); }
  }
  return { acknowledged };
}

/** A read receipt is SEEN — diagnostic, never acknowledgement. */
export async function syncOpsAlertReadReceipts(prisma: PrismaClient): Promise<number> {
  const rows = await prisma.opsAlertRecipient.findMany({ where: { seenAt: null, notificationId: { not: null }, opsAlert: { acknowledgedAt: null, closedAt: null } }, select: { id: true, notificationId: true }, take: 500 });
  let seen = 0;
  for (const r of rows) {
    const n = await prisma.notification.findUnique({ where: { id: r.notificationId! }, select: { readAt: true } });
    if (n?.readAt) { await prisma.opsAlertRecipient.update({ where: { id: r.id }, data: { seenAt: n.readAt } }); seen += 1; }
  }
  return seen;
}

const TERMINAL_SOS = new Set(['RESOLVED', 'CANCELLED']);

/** Past the deadline with no acknowledgement: escalate, and keep escalating. */
export async function escalateOverdueOpsAlerts(
  prisma: PrismaClient,
  notifications: NotificationService,
  sms: { sendSms: (to: string, body: string) => Promise<unknown> } | null,
  options: { now?: Date; limit?: number } = {},
): Promise<{ escalated: string[]; closed: string[] }> {
  const now = options.now ?? new Date();
  const escalated: string[] = []; const closed: string[] = [];
  const overdue = await prisma.opsAlert.findMany({
    where: { acknowledgedAt: null, closedAt: null, ackDeadlineAt: { lte: now } },
    include: { recipients: true },
    orderBy: { ackDeadlineAt: 'asc' },
    take: options.limit ?? 50,
  });
  for (const a of overdue) {
    // The emergency ended before anyone acknowledged: close, and say so.
    if (a.sosAlertId) {
      const sos = await prisma.sosAlert.findUnique({ where: { id: a.sosAlertId }, select: { status: true } });
      if (!sos || TERMINAL_SOS.has(sos.status)) {
        await prisma.opsAlert.update({ where: { id: a.id }, data: { closedAt: now, closeReason: sos ? `sos-${sos.status.toLowerCase()}-unacknowledged` : 'sos-gone' } });
        opsAlertCounter.labels('closed_unacknowledged').inc(); closed.push(a.id); continue;
      }
    }
    if (a.lastEscalatedAt && now.getTime() - a.lastEscalatedAt.getTime() < escalationRepeatSeconds() * 1000) continue;
    if (opsAlertEscalationKilled()) { opsAlertCounter.labels('escalation_killed').inc(); continue; }
    const level = a.escalationLevel + 1;
    const title = `⏰ UNACKNOWLEDGED (${level}×): ${a.title}`;
    const body = `Nobody has acknowledged this alert since ${a.createdAt.toISOString()}. ${a.body} Acknowledge it now.`;
    for (const r of a.recipients) {
      await notifications.send({ userId: r.userId, type: 'SYSTEM_ANNOUNCEMENT', title, body, data: { kind: 'ops_alert_escalated', opsAlertId: a.id, sosAlertId: a.sosAlertId, level } }).catch(() => null);
    }
    // The on-call tree: a text per configured phone, once per escalation.
    if (sms) {
      for (const phone of onCallPhones()) {
        await sms.sendSms(phone, `Swift ops: ${title}. ${a.body}`.slice(0, 480)).then(() => opsAlertCounter.labels('oncall_sms').inc()).catch((err) => log().error({ err, opsAlertId: a.id }, '[S-19] on-call SMS failed'));
      }
    }
    await prisma.opsAlert.update({ where: { id: a.id }, data: { escalationLevel: level, lastEscalatedAt: now } });
    opsAlertCounter.labels('escalated').inc();
    if (level === 1) opsAlertCounter.labels('zero_ack_by_deadline').inc();
    log().error({ opsAlertId: a.id, sosAlertId: a.sosAlertId, level, recipients: a.recipients.length }, '[S-19] ops alert unacknowledged past its deadline — escalated');
    escalated.push(a.id);
  }
  return { escalated, closed };
}

export interface OpsAlertScan {
  unacknowledgedOverdue: number;
  oldestOverdueSeconds: number;
  zeroRecipients: number;
  lastDrillAckSeconds: number | null;
}

/** [S-19 · operations] What ops should be paged on: zero ACK by deadline, and alerts nobody can acknowledge. */
export async function scanOpsAlerts(prisma: PrismaClient, now = new Date()): Promise<OpsAlertScan> {
  const overdue = await prisma.opsAlert.findMany({ where: { acknowledgedAt: null, closedAt: null, ackDeadlineAt: { lte: now } }, select: { ackDeadlineAt: true }, orderBy: { ackDeadlineAt: 'asc' }, take: 200 });
  const zero = await prisma.opsAlert.count({ where: { acknowledgedAt: null, closedAt: null, recipients: { none: {} } } });
  const drill = await prisma.opsAlert.findFirst({ where: { kind: 'DRILL', acknowledgedAt: { not: null } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, acknowledgedAt: true } });
  const scan: OpsAlertScan = {
    unacknowledgedOverdue: overdue.length,
    oldestOverdueSeconds: overdue[0] ? Math.max(0, Math.round((now.getTime() - overdue[0].ackDeadlineAt.getTime()) / 1000)) : 0,
    zeroRecipients: zero,
    lastDrillAckSeconds: drill?.acknowledgedAt ? Math.round((drill.acknowledgedAt.getTime() - drill.createdAt.getTime()) / 1000) : null,
  };
  opsAlertGauge.labels('unacknowledged_overdue').set(scan.unacknowledgedOverdue);
  opsAlertGauge.labels('oldest_overdue_seconds').set(scan.oldestOverdueSeconds);
  opsAlertGauge.labels('zero_recipients').set(scan.zeroRecipients);
  opsAlertGauge.labels('last_drill_ack_seconds').set(scan.lastDrillAckSeconds ?? -1);
  return scan;
}

/** [S-19 · operations] Periodic drills: the same obligation, the same
 *  deadline, the same escalation — with real people, on a schedule. */
export async function runOpsAlertDrillIfDue(prisma: PrismaClient, notifications: NotificationService, now = new Date()): Promise<{ opened: string | null }> {
  const days = drillIntervalDays();
  if (days === 0) return { opened: null };
  const last = await prisma.opsAlert.findFirst({ where: { kind: 'DRILL' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (last && now.getTime() - last.createdAt.getTime() < days * 86_400_000) return { opened: null };
  const res = await openOpsAlert(prisma, notifications, {
    kind: 'DRILL', tenantId: null, title: '🧪 Ops alert drill — acknowledge now',
    body: `This is a scheduled drill of the SOS paging path. Acknowledge it within ${ackDeadlineSeconds()} seconds; an unacknowledged drill escalates exactly like a real SOS would.`,
    data: { kind: 'ops_alert_drill' }, now,
  });
  opsAlertCounter.labels('drill').inc();
  return { opened: res.opsAlertId };
}
