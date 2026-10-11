import type { PrismaClient, OpsAlertKind } from '@prisma/client';
import { NotificationService, adminAudienceFor, isReviewTenantId } from '../notification/notification.service';
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

/** The same audience `notifyAdmins` pages [NOC-A F45]: a tenant's ADMINs plus every SUPER_ADMIN; NULL = platform operators only.
 *  One predicate (adminAudienceWhere) so the outbox and notifyAdmins can never disagree [144]. */
async function adminRecipientIds(prisma: PrismaClient, tenantId: string | null): Promise<string[]> {
  const { where } = await adminAudienceFor(prisma, tenantId);
  const admins = await runWithoutTenant(() => prisma.user.findMany({ where, select: { id: true } }));
  return admins.map((a) => a.id);
}

/** [GUARDRAILS §3] The store-review fiction texts no on-call phone: its pages stay inside its own tenant. */
async function isFiction(prisma: PrismaClient, tenantId: string | null): Promise<boolean> {
  return (await adminAudienceFor(prisma, tenantId)).review;
}

/** Anything that can send one text: in production, `getChannels().sms` — the
 *  one outbound SMS seam, so every SMS rule (the non-production recipient
 *  allowlist, the provider deadline) applies to ops pages too. */
export type OpsSms = { sendSms: (to: string, body: string) => Promise<unknown> };

export interface OpsResponders {
  /** People paged in-app + push, who can acknowledge. */
  userIds: string[];
  /** Phones texted for every page (OPS_ONCALL_PHONES). They cannot acknowledge
   *  by text; they are woken up to open the app or call a SUPER_ADMIN. */
  oncallPhones: string[];
}

/**
 * [144 · OPS-PAGING] Who a page reaches, made explicit. Coordinator ruling
 * (5 Oct 2026, delegated build-time choice): launch responders are every
 * ACTIVE SUPER_ADMIN (in-app + push) PLUS a text to every configured
 * OPS_ONCALL_PHONES number; a tenant's page adds that tenant's ADMINs. No new
 * role at launch. Whether launch staff should hold SUPER_ADMIN or a narrower
 * responder role is an open owner question; this is today's behaviour.
 */
export async function resolveOpsResponders(prisma: PrismaClient, tenantId: string | null, env: Record<string, string | undefined> = process.env): Promise<OpsResponders> {
  return { userIds: await adminRecipientIds(prisma, tenantId), oncallPhones: (await isFiction(prisma, tenantId)) ? [] : onCallPhones(env) };
}

async function defaultOpsSms(): Promise<OpsSms | null> {
  try {
    const { getChannels } = await import('../../providers/notifications/channels');
    return getChannels().sms;
  } catch (err) {
    log().error({ err }, '[144] ops page: the SMS channel could not be built — on-call phones are NOT texted');
    return null;
  }
}

/** Text every on-call phone once, all at once (each send is bounded by the
 *  provider deadline, so the page delivery stays inside its worker lease
 *  however many phones are listed). A failed text is logged and counted,
 *  never thrown: the in-app page stands. */
async function textOnCall(sms: OpsSms | null, phones: string[], opsAlertId: string, text: string): Promise<number> {
  if (!sms || phones.length === 0) return 0;
  const results = await Promise.allSettled(phones.map((phone) => sms.sendSms(phone, text.slice(0, 480))));
  let sent = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') { sent += 1; opsAlertCounter.labels('oncall_sms').inc(); }
    else log().error({ err: r.reason, opsAlertId }, '[S-19] on-call SMS failed');
  }
  return sent;
}

/** Open the obligation and deliver it: one recipient row per admin, each
 *  with the persisted notification as its delivery proof, and a text to every
 *  on-call phone [144]. A page that resolves NOBODY to acknowledge it is due
 *  for escalation at once (its deadline is now), so the very next sweep
 *  re-resolves its recipients and escalates — never a quiet success [75]. */
export async function openOpsAlert(
  prisma: PrismaClient,
  notifications: NotificationService,
  input: { kind: OpsAlertKind; tenantId: string | null; sosAlertId?: string | null; title: string; body: string; data: Record<string, unknown>; now?: Date; recipientIds?: string[]; sms?: OpsSms | null; oncallPhones?: string[] },
): Promise<{ opsAlertId: string; recipients: number; delivered: number; oncallTexted: number }> {
  // The alert's tenant is the one named here (null = platform), never the
  // tenant of whatever request happens to open it [M009]: written unscoped.
  return runWithoutTenant(() => openOpsAlertUnscoped(prisma, notifications, input), 'ops-alert-open');
}

async function openOpsAlertUnscoped(
  prisma: PrismaClient,
  notifications: NotificationService,
  input: Parameters<typeof openOpsAlert>[2],
): Promise<{ opsAlertId: string; recipients: number; delivered: number; oncallTexted: number }> {
  const now = input.now ?? new Date();
  // [REVIEW-PARTNER] The store-review fiction pages no real operator: no obligation, no recipients.
  if (input.tenantId && await isReviewTenantId(prisma, input.tenantId)) {
    log().info({ kind: input.kind }, 'review-tenant send suppressed: ops alert');
    return { opsAlertId: '', recipients: 0, delivered: 0, oncallTexted: 0 };
  }
  // [R048-006] the recipient set is resolvable by the caller (a test seam; production uses the admin resolver)
  const userIds = input.recipientIds ?? (await adminRecipientIds(prisma, input.tenantId));
  const ackDeadlineAt = userIds.length === 0 ? now : new Date(now.getTime() + ackDeadlineSeconds() * 1000);
  const alert = await prisma.opsAlert.create({
    data: {
      tenantId: input.tenantId, kind: input.kind, sosAlertId: input.sosAlertId ?? null, title: input.title, body: input.body,
      ackDeadlineAt,
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
  // [144] The on-call list is texted for every page, through the one SMS seam.
  // (The store-review fiction returned above: its pages text nobody.)
  const phones = input.oncallPhones ?? onCallPhones();
  const sms = input.sms !== undefined ? input.sms : phones.length > 0 ? await defaultOpsSms() : null;
  const oncallTexted = await textOnCall(sms, phones, alert.id, `Swift ops: ${input.title}. ${input.body}`);
  opsAlertCounter.labels('opened').inc();
  if (userIds.length === 0) {
    opsAlertCounter.labels('zero_recipients').inc();
    log().error({ opsAlertId: alert.id, tenantId: input.tenantId, oncallTexted }, '[S-19] ops alert has NO recipients — nobody can acknowledge it; due for escalation now (on-call texted, recipients re-resolved on the next sweep)');
    if (oncallTexted === 0) {
      opsAlertCounter.labels('unreachable').inc();
      log().error({ opsAlertId: alert.id, tenantId: input.tenantId }, '[S-19] ops alert reached NOBODY: no SUPER_ADMIN and no on-call phone was texted');
    }
  }
  return { opsAlertId: alert.id, recipients: userIds.length, delivered, oncallTexted };
}

/** Test seam: runs inside the acknowledgement transaction, after the receipt
 *  is written and before the alert is marked. Never set in routes. */
export interface OpsAckObserver { betweenWrites?: (opsAlertId: string) => Promise<void> }

class AckLost extends Error {}

/**
 * A human acknowledged: the recipient's receipt and the alert, first ack wins.
 *
 * [M076] An acknowledgement is a person's receipt, or it is nothing. The
 * receipt (the acknowledger's recipient row, ackedAt) and the alert's
 * acknowledgedAt now commit in ONE transaction: an alert is never marked
 * acknowledged without the receipt of who acknowledged it, and a failure
 * between the two writes leaves neither. A responder who was not on the
 * original page (a SUPER_ADMIN added since) gets their receipt row in that
 * same transaction, but only if they are in the alert's audience today
 * (adminAudienceWhere: SUPER_ADMIN for a platform alert; the tenant's ADMINs
 * or a SUPER_ADMIN for a tenant's). Anyone else is refused.
 */
export async function acknowledgeOpsAlert(
  prisma: PrismaClient,
  input: { opsAlertId?: string; sosAlertId?: string; userId: string; now?: Date; observer?: OpsAckObserver },
): Promise<{ acknowledged: string[]; refused: string[] }> {
  const now = input.now ?? new Date();
  const alerts = await prisma.opsAlert.findMany({ where: { ...(input.opsAlertId ? { id: input.opsAlertId } : {}), ...(input.sosAlertId ? { sosAlertId: input.sosAlertId } : {}), acknowledgedAt: null }, select: { id: true, tenantId: true } });
  const acknowledged: string[] = []; const refused: string[] = [];
  for (const a of alerts) {
    const { where: audience } = await adminAudienceFor(prisma, a.tenantId);
    const eligible = await runWithoutTenant(() => prisma.user.count({ where: { AND: [{ id: input.userId }, audience] } }));
    try {
      const won = await prisma.$transaction(async (tx) => {
        const receipt = await tx.opsAlertRecipient.updateMany({ where: { opsAlertId: a.id, userId: input.userId }, data: { ackedAt: now, seenAt: now } });
        if (receipt.count !== 1) {
          if (eligible === 0) return false;
          await tx.opsAlertRecipient.create({ data: { tenantId: a.tenantId, opsAlertId: a.id, userId: input.userId, ackedAt: now, seenAt: now } });
        }
        await input.observer?.betweenWrites?.(a.id);
        const res = await tx.opsAlert.updateMany({ where: { id: a.id, acknowledgedAt: null }, data: { acknowledgedAt: now, acknowledgedBy: input.userId } });
        // Someone else acknowledged first: roll this receipt back with it.
        if (res.count !== 1) throw new AckLost();
        return true;
      });
      if (won) { acknowledged.push(a.id); opsAlertCounter.labels('acknowledged').inc(); } else { refused.push(a.id); opsAlertCounter.labels('ack_refused_no_receipt').inc(); }
    } catch (err) {
      if (!(err instanceof AckLost)) throw err;
    }
  }
  return { acknowledged, refused };
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
  sms: OpsSms | null,
  options: { now?: Date; limit?: number } = {},
): Promise<{ escalated: string[]; closed: string[]; platformPage: string[] }> {
  const now = options.now ?? new Date();
  const escalated: string[] = []; const closed: string[] = [];
  // Escalations the platform is paged about (queue.ts): never the store-review fiction's.
  const platformPage: string[] = [];
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
    // [R048-006 · 75] A page that found nobody staffed stays PENDING, not dark: EVERY sweep
    // re-resolves its recipients (not only once per escalation window), so an admin who
    // appears later is attached on the next tick.
    let attachedLate: string[] = [];
    if (a.recipients.length === 0) {
      const userIds = await adminRecipientIds(prisma, a.tenantId);
      if (userIds.length > 0) {
        await prisma.opsAlertRecipient.createMany({ data: userIds.map((userId) => ({ tenantId: a.tenantId, opsAlertId: a.id, userId })), skipDuplicates: true });
        a.recipients = await prisma.opsAlertRecipient.findMany({ where: { opsAlertId: a.id } });
        attachedLate = a.recipients.map((r) => r.id);
        opsAlertCounter.labels('recipients_attached_late').inc();
      }
    }
    const escalationDue = !(a.lastEscalatedAt && now.getTime() - a.lastEscalatedAt.getTime() < escalationRepeatSeconds() * 1000);
    if (!escalationDue || opsAlertEscalationKilled()) {
      if (escalationDue) opsAlertCounter.labels('escalation_killed').inc();
      // Not escalating on this pass: a recipient attached late still gets the page itself now.
      for (const r of a.recipients.filter((x) => attachedLate.includes(x.id))) {
        const id = await notifications.send({ userId: r.userId, type: 'SYSTEM_ANNOUNCEMENT', title: a.title, body: a.body, data: { kind: 'ops_alert_escalated', opsAlertId: a.id, sosAlertId: a.sosAlertId, level: a.escalationLevel } }).catch(() => null);
        if (id) await prisma.opsAlertRecipient.update({ where: { id: r.id }, data: { notificationId: id, deliveredAt: now } }).catch(() => null);
      }
      continue;
    }
    const level = a.escalationLevel + 1;
    const title = `⏰ UNACKNOWLEDGED (${level}×): ${a.title}`;
    const body = `Nobody has acknowledged this alert since ${a.createdAt.toISOString()}. ${a.body} Acknowledge it now.`;
    for (const r of a.recipients) {
      await notifications.send({ userId: r.userId, type: 'SYSTEM_ANNOUNCEMENT', title, body, data: { kind: 'ops_alert_escalated', opsAlertId: a.id, sosAlertId: a.sosAlertId, level } }).catch(() => null);
    }
    // The on-call tree: a text per configured phone, once per escalation.
    const fiction = await isFiction(prisma, a.tenantId);
    if (!fiction) await textOnCall(sms, onCallPhones(), a.id, `Swift ops: ${title}. ${a.body}`);
    await prisma.opsAlert.update({ where: { id: a.id }, data: { escalationLevel: level, lastEscalatedAt: now } });
    opsAlertCounter.labels('escalated').inc();
    if (level === 1) opsAlertCounter.labels('zero_ack_by_deadline').inc();
    log().error({ opsAlertId: a.id, sosAlertId: a.sosAlertId, level, recipients: a.recipients.length }, '[S-19] ops alert unacknowledged past its deadline — escalated');
    escalated.push(a.id);
    if (!fiction) platformPage.push(a.id);
  }
  return { escalated, closed, platformPage };
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
