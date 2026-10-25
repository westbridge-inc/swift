import { createHash } from 'node:crypto';
import type { PrismaClient, OpsAlertKind, OpsAlert, OpsAlertRecipient } from '@prisma/client';
import { NotificationService, adminAudienceFor, isReviewTenantId, notifyAdmins } from '../notification/notification.service';
import { runWithoutTenant } from '../../plugins/tenant-context';
import { log } from '../../utils/logger';
import { opsAlertCounter, opsAlertGauge } from '../../plugins/observability';
import { smsAccepted } from '../../providers/notifications/sms-outcome';
import { ownerWallSystem } from '../../lib/owner-rls';

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

/**
 * [DRILL-STORM · GUARDRAILS §3] The ladder is bounded, never silenced.
 *
 * Staging, 25 Oct 2026: one weekly drill nobody acknowledged had re-paged
 * every responder and texted every on-call phone every five minutes for
 * seventeen days ("UNACKNOWLEDGED (4976×)"), beside the next two weeks'
 * drills and an "OVERDUE" platform page for each every fifteen minutes. A
 * page storm drowns a real SOS and burns the on-call phone. Now:
 *  - a DRILL is a test of the path: nobody acknowledging it within its window
 *    (OPS_ALERT_DRILL_WINDOW_SECONDS, 15 min) is the finding. It is closed as
 *    a FAILED drill (closeReason drill-failed-unacknowledged, kept and listed),
 *    platform operators get ONE summary notice, and it never pages again;
 *  - a REAL alert (SOS, a platform page) keeps escalating until a human
 *    acknowledges it or its emergency ends, on a backoff: 5, 10, 20 minutes,
 *    then every 15 (SOS) or 30 (anything else) minutes, forever;
 *  - a person is re-paged at most OPS_ALERT_REPAGE_MAX_PER_HOUR (12) times an
 *    hour, and the on-call list texted as often: every alert owed at that
 *    moment travels in ONE push (one inbox notice per person, updated in place,
 *    that replaces the last one on the phone) and ONE text. A re-page held by
 *    the spacing is not dropped: it goes out in the next one (a send that fails
 *    after its claim waits for the next escalation, as before). The first
 *    escalation of an SOS is never held by the spacing, for a person or for
 *    the on-call phones;
 *  - the platform is paged ("OVERDUE") once per alert, at its first escalation.
 * First pages are never limited: a new alert always pages at once.
 */
export const escalationMaxRepeatSeconds = (kind: OpsAlertKind) => {
  const name = kind === 'SOS' ? 'OPS_ALERT_SOS_MAX_REPEAT_SECONDS' : 'OPS_ALERT_ESCALATION_MAX_REPEAT_SECONDS';
  const fallback = kind === 'SOS' ? 900 : 1800;
  const n = Number(process.env[name] ?? fallback);
  return Math.max(Number.isFinite(n) && n > 0 ? n : fallback, escalationRepeatSeconds());
};
/** Seconds between escalation `level` and the next: the repeat, doubling, to the kind's ceiling. */
export const escalationIntervalSeconds = (kind: OpsAlertKind, level: number) =>
  Math.min(escalationMaxRepeatSeconds(kind), escalationRepeatSeconds() * 2 ** Math.min(Math.max(level - 1, 0), 20));
export const repageMaxPerHour = () => { const n = Number(process.env['OPS_ALERT_REPAGE_MAX_PER_HOUR'] ?? 12); return Number.isInteger(n) && n >= 1 && n <= 60 ? n : 12; };
/** The least time between two re-pages of one person (and two texts to the on-call list). */
export const repageSpacingSeconds = () => Math.ceil(3600 / repageMaxPerHour());
export const drillWindowSeconds = () => { const n = Number(process.env['OPS_ALERT_DRILL_WINDOW_SECONDS'] ?? 900); return Math.max(Number.isFinite(n) && n > 0 ? n : 900, ackDeadlineSeconds()); };
export const DRILL_FAILED_REASON = 'drill-failed-unacknowledged';
/** The one escalation notice a person holds (inbox dedupe key), and the push key that replaces it on the phone. */
export const OPS_UNACKED_KEY = 'ops-alert-unacked';
/** [DRILL-STORM] Where a page is acknowledged: the console's Ops alerts screen (plain ASCII: it travels by SMS too). */
export const ACK_WHERE = 'Mission Control > Ops alerts';

/** [DRILL-STORM · REVIEW-F S4] A moment as the responder reads it: "25 Oct, 12:35 pm Guyana time" (never raw UTC). */
export function guyanaTime(at: Date): string {
  const day = at.toLocaleDateString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'short' });
  const time = at.toLocaleTimeString('en-US', { timeZone: 'America/Guyana', hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase().replace(/\s/g, ' ');
  // (newer ICU puts a narrow no-break space before am/pm: plain ASCII, it travels by SMS)
  return `${day}, ${time} Guyana time`;
}

/** "2 minutes", "15 minutes", "90 seconds". */
export function durationWords(seconds: number): string {
  if (seconds % 60 === 0) { const m = seconds / 60; return m === 1 ? '1 minute' : `${m} minutes`; }
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

/** What a drill tells the people it pages. */
export function drillBody(manual: boolean): string {
  return `${manual ? 'A manual' : 'This is a scheduled'} drill of the SOS paging path. Acknowledge it in ${ACK_WHERE} within ${durationWords(ackDeadlineSeconds())}. If nobody does, it escalates like a real SOS for ${durationWords(drillWindowSeconds())}, then closes as a FAILED drill and stops paging.`;
}
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
 *  never thrown: the in-app page stands.
 *  [AUD-L8b-008] Returns the texts the PROVIDER ACCEPTED: a send that resolved
 *  without leaving Swift (the non-production recipient list, the review seal,
 *  a hand-off) is not a phone that was texted (sms-outcome.ts). */
async function textOnCall(sms: OpsSms | null, phones: string[], opsAlertId: string, text: string): Promise<number> {
  if (!sms || phones.length === 0) return 0;
  const results = await Promise.allSettled(phones.map((phone) => sms.sendSms(phone, text.slice(0, 480))));
  let sent = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && smsAccepted(r.value)) { sent += 1; opsAlertCounter.labels('oncall_sms').inc(); }
    else if (r.status === 'fulfilled') { opsAlertCounter.labels('oncall_sms_not_sent').inc(); log().error({ opsAlertId }, '[AUD-L8b-008] an on-call text was not sent (held before the provider) — not counted as texted'); }
    else log().error({ err: r.reason, opsAlertId }, '[S-19] on-call SMS failed');
  }
  return sent;
}

/** Open the obligation and deliver it: one recipient row per admin, each
 *  with the persisted notification as its inbox record, and a text to every
 *  on-call phone [144]. A page that resolves NOBODY to acknowledge it is due
 *  for escalation at once (its deadline is now), so the very next sweep
 *  re-resolves its recipients and escalates — never a quiet success [75].
 *
 *  [AUD-L8b-008 · AUD-G7-003] What the page REACHED is counted from what
 *  actually went out, never from inbox rows: `pushed` = responders whose push
 *  the provider accepted, `oncallTexted` = on-call texts the provider
 *  accepted, `reached` = both. `inboxed` (rows written) is a record, not a
 *  person told. A page that reached nobody — no push and no text accepted — is
 *  due for escalation at once too: the next sweep re-pushes, texts on-call
 *  again and pages the platform, until a human acknowledges it. */
export async function openOpsAlert(
  prisma: PrismaClient,
  notifications: NotificationService,
  input: { kind: OpsAlertKind; tenantId: string | null; sosAlertId?: string | null; title: string; body: string; data: Record<string, unknown>; now?: Date; recipientIds?: string[]; sms?: OpsSms | null; oncallPhones?: string[] },
): Promise<OpsAlertOpened> {
  // The alert's tenant is the one named here (null = platform), never the
  // tenant of whatever request happens to open it [M009]: written unscoped.
  return runWithoutTenant(() => openOpsAlertUnscoped(prisma, notifications, input), 'ops-alert-open');
}

/** [AUD-L8b-008] What an opened page did: `recipients` = responders it was
 *  addressed to; `inboxed` = inbox rows written; `pushed` = responders whose
 *  push the provider accepted; `oncallTexted` = on-call texts the provider
 *  accepted; `reached` = pushed + oncallTexted, the only count that says a
 *  person was told. */
export interface OpsAlertOpened { opsAlertId: string; recipients: number; inboxed: number; pushed: number; oncallTexted: number; reached: number }

async function openOpsAlertUnscoped(
  prisma: PrismaClient,
  notifications: NotificationService,
  input: Parameters<typeof openOpsAlert>[2],
): Promise<OpsAlertOpened> {
  const now = input.now ?? new Date();
  // [REVIEW-PARTNER] The store-review fiction pages no real operator: no obligation, no recipients.
  if (input.tenantId && await isReviewTenantId(prisma, input.tenantId)) {
    log().info({ kind: input.kind }, 'review-tenant send suppressed: ops alert');
    return { opsAlertId: '', recipients: 0, inboxed: 0, pushed: 0, oncallTexted: 0, reached: 0 };
  }
  // [R048-006] the recipient set is resolvable by the caller (a test seam; production uses the admin resolver)
  const userIds = input.recipientIds ?? (await adminRecipientIds(prisma, input.tenantId));
  const ackDeadlineAt = userIds.length === 0 ? now : new Date(now.getTime() + ackDeadlineSeconds() * 1000);
  const alert = await prisma.opsAlert.create({
    data: {
      tenantId: input.tenantId, kind: input.kind, sosAlertId: input.sosAlertId ?? null, title: input.title, body: input.body,
      // [DRILL-STORM] Opened at `now`, the clock its deadline (and a drill's window) is measured on.
      createdAt: now, ackDeadlineAt,
      recipients: { create: userIds.map((userId) => ({ tenantId: input.tenantId, userId })) },
    },
    include: { recipients: true },
  });
  let inboxed = 0; let pushed = 0;
  for (const r of alert.recipients) {
    try {
      // [DRILL-STORM · REVIEW-F S4] the first page names where it is acknowledged, like every re-page
      const sent = await notifications.sendReach({ userId: r.userId, type: 'SYSTEM_ANNOUNCEMENT', title: input.title, body: `${input.body} Acknowledge it in ${ACK_WHERE}.`, data: { ...input.data, opsAlertId: alert.id } });
      if (sent.pushed) pushed += 1;
      if (sent.id) { inboxed += 1; await prisma.opsAlertRecipient.update({ where: { id: r.id }, data: { notificationId: sent.id, deliveredAt: now } }); }
    } catch (err) {
      log().error({ err, opsAlertId: alert.id, userId: r.userId }, '[S-19] ops alert delivery failed for a recipient — escalation covers it');
    }
  }
  // [144] The on-call list is texted for every page, through the one SMS seam.
  // (The store-review fiction returned above: its pages text nobody.)
  const phones = input.oncallPhones ?? onCallPhones();
  const sms = input.sms !== undefined ? input.sms : phones.length > 0 ? await defaultOpsSms() : null;
  const oncallTexted = await textOnCall(sms, phones, alert.id, `Swift ops: ${input.title}. Acknowledge it in ${ACK_WHERE}. ${input.body}`);
  const reached = pushed + oncallTexted;
  opsAlertCounter.labels('opened').inc();
  if (userIds.length === 0) {
    opsAlertCounter.labels('zero_recipients').inc();
    log().error({ opsAlertId: alert.id, tenantId: input.tenantId, oncallTexted }, '[S-19] ops alert has NO recipients — nobody can acknowledge it; due for escalation now (on-call texted, recipients re-resolved on the next sweep)');
  }
  if (reached === 0) {
    // [AUD-L8b-008] Inbox rows are not people told: nobody was reached, so the
    // page escalates on the very next sweep instead of waiting out a deadline
    // nobody knows about. (A page with no recipients is already due now.)
    if (userIds.length > 0) await prisma.opsAlert.update({ where: { id: alert.id }, data: { ackDeadlineAt: now } });
    opsAlertCounter.labels('unreachable').inc();
    log().error({ opsAlertId: alert.id, tenantId: input.tenantId, recipients: userIds.length, inboxed }, '[S-19] ops alert reached NOBODY: no push and no on-call text was accepted — due for escalation now');
  }
  return { opsAlertId: alert.id, recipients: userIds.length, inboxed, pushed, oncallTexted, reached };
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
  // [DRILL-STORM] A closed alert (a FAILED drill, an emergency that ended) is
  // a record: a late acknowledgement never turns it into an acknowledged one.
  const alerts = await prisma.opsAlert.findMany({ where: { ...(input.opsAlertId ? { id: input.opsAlertId } : {}), ...(input.sosAlertId ? { sosAlertId: input.sosAlertId } : {}), acknowledgedAt: null, closedAt: null }, select: { id: true, tenantId: true, kind: true, sosAlertId: true } });
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
        const res = await tx.opsAlert.updateMany({ where: { id: a.id, acknowledgedAt: null, closedAt: null }, data: { acknowledgedAt: now, acknowledgedBy: input.userId } });
        // Someone else acknowledged first: roll this receipt back with it.
        if (res.count !== 1) throw new AckLost();
        // [DRILL-STORM] Who acknowledged which page, and when, on the append-only audit log too
        // (the console's Audit log), in the same transaction as the receipt.
        await tx.auditLog.create({ data: { userId: input.userId, action: 'OPS_ALERT_ACKNOWLEDGED', entity: 'OpsAlert', entityId: a.id, changes: { kind: a.kind, sosAlertId: a.sosAlertId, tenantId: a.tenantId } } });
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
    // [item 20] A responder's notice, read by the receipt sync: the named capability under the owner wall.
    const n = await ownerWallSystem('ops-alert:read-receipt', () => prisma.notification.findUnique({ where: { id: r.notificationId! }, select: { readAt: true } }));
    if (n?.readAt) { await prisma.opsAlertRecipient.update({ where: { id: r.id }, data: { seenAt: n.readAt } }); seen += 1; }
  }
  return seen;
}

const TERMINAL_SOS = new Set(['RESOLVED', 'CANCELLED']);

type SweptAlert = OpsAlert & { recipients: OpsAlertRecipient[] };
/** An alert still open after this sweep, and whether it is the store-review fiction's. */
type LiveAlert = { alert: SweptAlert; fiction: boolean };

/** The order owed alerts are named in: an SOS first, then the oldest. */
const KIND_RANK: Record<OpsAlertKind, number> = { SOS: 0, PLATFORM: 1, DRILL: 2 };
const byUrgency = (a: SweptAlert, b: SweptAlert) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.createdAt.getTime() - b.createdAt.getTime();
const oldestOf = (alerts: SweptAlert[]) => alerts.reduce((o, a) => (a.createdAt < o.createdAt ? a : o), alerts[0]!);

/** The words of ONE re-page (push, inbox notice) or ONE on-call text for every alert owed at once. */
export function repageWords(alerts: SweptAlert[]): { title: string; body: string; text: string } {
  const sorted = [...alerts].sort(byUrgency);
  const first = sorted[0]!;
  if (sorted.length === 1) {
    const title = `UNACKNOWLEDGED (${first.escalationLevel}×): ${first.title}`;
    return { title, body: `Nobody has acknowledged this alert since ${guyanaTime(first.createdAt)}. ${first.body} Acknowledge it now in ${ACK_WHERE}.`, text: `Swift ops: ${title}. Acknowledge it in ${ACK_WHERE}. ${first.body}` };
  }
  const sos = sorted.some((a) => a.kind === 'SOS') ? ', including an SOS' : '';
  const since = guyanaTime(oldestOf(sorted).createdAt);
  return {
    title: `UNACKNOWLEDGED: ${sorted.length} ops alerts${sos}`,
    body: `Nobody has acknowledged ${sorted.length} ops alerts; the oldest has waited since ${since}. First: ${first.title}. Acknowledge them now in ${ACK_WHERE}.`,
    text: `Swift ops: ${sorted.length} ops alerts are UNACKNOWLEDGED${sos}. The oldest has waited since ${since}. First: ${first.title}. Acknowledge them in ${ACK_WHERE}.`,
  };
}

/** The on-call list as a short hash: the spacing is per list, and no number is stored. */
const oncallListKey = (phones: string[]) => createHash('sha256').update([...phones].sort().join(',')).digest('hex').slice(0, 16);

/** Past the deadline with no acknowledgement: escalate, and keep escalating — bounded [DRILL-STORM]. */
export async function escalateOverdueOpsAlerts(
  prisma: PrismaClient,
  notifications: NotificationService,
  sms: OpsSms | null,
  /** `alertIds` is a test seam: sweep only these alerts. */
  options: { now?: Date; limit?: number; alertIds?: string[] } = {},
): Promise<{ escalated: string[]; closed: string[]; platformPage: string[]; drillsFailed: string[] }> {
  const now = options.now ?? new Date();
  const escalated: string[] = []; const closed: string[] = [];
  // Escalations the platform is paged about (queue.ts): never the store-review fiction's.
  const platformPage: string[] = [];
  const drillsFailed: SweptAlert[] = [];
  const live: LiveAlert[] = [];
  const killed = opsAlertEscalationKilled();
  const overdue: SweptAlert[] = await prisma.opsAlert.findMany({
    where: { acknowledgedAt: null, closedAt: null, ackDeadlineAt: { lte: now }, ...(options.alertIds ? { id: { in: options.alertIds } } : {}) },
    include: { recipients: true },
    // [DRILL-STORM] Never escalated first, then the longest since its last escalation: a new
    // page is never starved behind a backlog of old ones (the old order was the deadline, oldest first).
    orderBy: [{ lastEscalatedAt: { sort: 'asc', nulls: 'first' } }, { ackDeadlineAt: 'asc' }],
    take: options.limit ?? 100,
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
    // [DRILL-STORM] A drill nobody acknowledged within its window is the finding: closed as a
    // FAILED drill, kept (the failed-drills list, the gauge), said once below, never paged again.
    if (a.kind === 'DRILL' && now.getTime() >= a.createdAt.getTime() + drillWindowSeconds() * 1000) {
      const res = await prisma.opsAlert.updateMany({ where: { id: a.id, acknowledgedAt: null, closedAt: null }, data: { closedAt: now, closeReason: DRILL_FAILED_REASON } });
      if (res.count === 1) {
        opsAlertCounter.labels('drill_failed').inc();
        log().error({ opsAlertId: a.id, escalationLevel: a.escalationLevel, openedAt: a.createdAt.toISOString() }, '[DRILL-STORM] ops alert drill FAILED: nobody acknowledged it within its window — closed, never paged again');
        closed.push(a.id); drillsFailed.push(a);
      }
      continue;
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
    const fiction = await isFiction(prisma, a.tenantId);
    // [DRILL-STORM] The backoff: the repeat doubles after each escalation, to the kind's ceiling.
    const escalationDue = !(a.lastEscalatedAt && now.getTime() - a.lastEscalatedAt.getTime() < escalationIntervalSeconds(a.kind, a.escalationLevel) * 1000);
    let escalatedNow = false;
    if (escalationDue && !killed) {
      // One sweep escalates an alert once: a concurrent sweep, or an acknowledgement, wins.
      const claim = await prisma.opsAlert.updateMany({ where: { id: a.id, escalationLevel: a.escalationLevel, acknowledgedAt: null, closedAt: null }, data: { escalationLevel: a.escalationLevel + 1, lastEscalatedAt: now } });
      if (claim.count !== 1) continue;
      escalatedNow = true; a.escalationLevel += 1; a.lastEscalatedAt = now;
    } else if (escalationDue) opsAlertCounter.labels('escalation_killed').inc();
    const level = a.escalationLevel;
    // A recipient attached late gets the page itself now, escalating or not (the rollback included):
    // the first time a person hears of an alert is never held back. It counts as their re-page at this level.
    for (const r of a.recipients.filter((x) => attachedLate.includes(x.id))) {
      const id = await notifications.send({ userId: r.userId, type: 'SYSTEM_ANNOUNCEMENT', title: a.title, body: a.body, data: { kind: 'ops_alert_escalated', opsAlertId: a.id, sosAlertId: a.sosAlertId, level } }).catch(() => null);
      if (id) {
        await prisma.opsAlertRecipient.update({ where: { id: r.id }, data: { notificationId: id, deliveredAt: now, pagedLevel: level, lastPagedAt: now } }).catch(() => null);
        r.pagedLevel = level;
      }
    }
    live.push({ alert: a, fiction });
    if (!escalatedNow) continue;
    opsAlertCounter.labels('escalated').inc();
    if (level === 1) opsAlertCounter.labels('zero_ack_by_deadline').inc();
    log().error({ opsAlertId: a.id, sosAlertId: a.sosAlertId, level, recipients: a.recipients.length }, '[S-19] ops alert unacknowledged past its deadline — escalated');
    escalated.push(a.id);
    // [DRILL-STORM] The platform is paged once per alert, at its first escalation; the ladder re-pages after that.
    if (!fiction && level === 1) platformPage.push(a.id);
  }
  // [DRILL-STORM] The re-pages: collapsed per person and per on-call list, spaced, nothing owed dropped.
  // The rollback (OPS_ALERT_ESCALATION_KILL) pauses them with the escalation.
  if (!killed) {
    await repageOwed(prisma, notifications, live.map((l) => l.alert), now);
    await textOnCallOwed(prisma, sms, live.filter((l) => !l.fiction).map((l) => l.alert), now);
  }
  if (drillsFailed.length > 0) await announceFailedDrills(prisma, notifications, drillsFailed);
  return { escalated, closed, platformPage, drillsFailed: drillsFailed.map((d) => d.id) };
}

/**
 * [DRILL-STORM] Re-page every person owed an escalation (an alert they are on
 * reached a level they were not re-paged about): ONE push for all of them,
 * at most one per person per spacing — except the first escalation of an SOS,
 * which never waits. A person held by the spacing keeps what they are owed
 * for their next re-page. The notice is the person's one escalation notice,
 * updated in place (unread again, on top), and its push replaces the last one
 * on the phone (Expo collapseId / Android tag).
 */
async function repageOwed(prisma: PrismaClient, notifications: NotificationService, alerts: SweptAlert[], now: Date): Promise<void> {
  const owed = new Map<string, Array<{ alert: SweptAlert; row: OpsAlertRecipient }>>();
  for (const alert of alerts) {
    for (const row of alert.recipients) {
      if (row.ackedAt || row.pagedLevel >= alert.escalationLevel) continue;
      owed.set(row.userId, [...(owed.get(row.userId) ?? []), { alert, row }]);
    }
  }
  if (owed.size === 0) return;
  const spacingMs = repageSpacingSeconds() * 1000;
  // A re-page in the last spacing (never one dated after `now`: a skewed clock cannot hold a person back).
  const recent = await prisma.opsAlertRecipient.findMany({
    where: { userId: { in: [...owed.keys()] }, lastPagedAt: { gt: new Date(now.getTime() - spacingMs), lte: now } },
    select: { userId: true },
  });
  const cooling = new Set(recent.map((r) => r.userId));
  for (const [userId, items] of owed) {
    const firstSos = items.some((o) => o.alert.kind === 'SOS' && o.row.pagedLevel === 0);
    if (cooling.has(userId) && !firstSos) { opsAlertCounter.labels('repage_spaced').inc(); continue; }
    const claimed: SweptAlert[] = [];
    for (const o of items) {
      const c = await prisma.opsAlertRecipient.updateMany({ where: { id: o.row.id, pagedLevel: o.row.pagedLevel }, data: { pagedLevel: o.alert.escalationLevel, lastPagedAt: now } });
      if (c.count === 1) claimed.push(o.alert);
    }
    if (claimed.length === 0) continue;
    const sorted = [...claimed].sort(byUrgency);
    const first = sorted[0]!;
    const words = repageWords(sorted);
    const data = {
      kind: 'ops_alert_escalated', opsAlertId: first.id, sosAlertId: first.sosAlertId, level: first.escalationLevel,
      opsAlertIds: sorted.map((a) => a.id), count: sorted.length, collapseKey: OPS_UNACKED_KEY,
    };
    try {
      const notice = { title: words.title, body: words.body, data, isRead: false, readAt: null, createdAt: now };
      // [item 20] A responder's escalation notice, rewritten by the ladder: the named capability under the owner wall.
      const existing = await ownerWallSystem('ops-alert:repage-notice', () => prisma.notification.findUnique({ where: { userId_dedupeKey: { userId, dedupeKey: OPS_UNACKED_KEY } }, select: { id: true } }));
      if (existing) {
        await ownerWallSystem('ops-alert:repage-notice', () => prisma.notification.update({ where: { id: existing.id }, data: notice }));
        await notifications.publishPersisted(existing.id, { requirePush: true });
      } else {
        await notifications.send({ userId, type: 'SYSTEM_ANNOUNCEMENT', title: words.title, body: words.body, data, dedupeKey: OPS_UNACKED_KEY });
      }
      opsAlertCounter.labels('repaged').inc();
    } catch (err) {
      log().error({ err, userId, opsAlertIds: data.opsAlertIds }, '[DRILL-STORM] a re-page failed for a person — the next escalation re-pages them');
    }
  }
}

/** [DRILL-STORM] The on-call list, like a person: ONE text for every alert owed, at most one per spacing, the first SOS escalation never held. */
async function textOnCallOwed(prisma: PrismaClient, sms: OpsSms | null, alerts: SweptAlert[], now: Date): Promise<number> {
  const owed = alerts.filter((a) => a.escalationLevel > a.oncallTextedLevel);
  const phones = onCallPhones();
  if (owed.length === 0 || phones.length === 0) return 0;
  const list = oncallListKey(phones);
  const recent = await prisma.opsAlert.findFirst({ where: { oncallTextedList: list, oncallTextedAt: { gt: new Date(now.getTime() - repageSpacingSeconds() * 1000), lte: now } }, select: { id: true } });
  const firstSos = owed.some((a) => a.kind === 'SOS' && a.oncallTextedLevel === 0);
  if (recent && !firstSos) { opsAlertCounter.labels('oncall_text_spaced').inc(); return 0; }
  const claimed: SweptAlert[] = [];
  for (const a of owed) {
    const c = await prisma.opsAlert.updateMany({ where: { id: a.id, oncallTextedLevel: a.oncallTextedLevel }, data: { oncallTextedLevel: a.escalationLevel, oncallTextedAt: now, oncallTextedList: list } });
    if (c.count === 1) claimed.push(a);
  }
  if (claimed.length === 0) return 0;
  const sorted = [...claimed].sort(byUrgency);
  return textOnCall(sms, phones, sorted[0]!.id, repageWords(sorted).text);
}

/** [DRILL-STORM] ONE notice to platform operators for the drills this sweep closed as FAILED. */
async function announceFailedDrills(prisma: PrismaClient, notifications: NotificationService, drills: SweptAlert[]): Promise<void> {
  const oldest = oldestOf(drills);
  const window = durationWords(drillWindowSeconds());
  const advice = `Check that on-call staff get Swift pages, then run a drill from ${ACK_WHERE}.`;
  const body = drills.length === 1
    ? `The ops alert drill opened at ${guyanaTime(oldest.createdAt)} was not acknowledged within ${window}. It is closed as a FAILED drill and will not page again. ${advice}`
    : `${drills.length} ops alert drills were not acknowledged within ${window}; the oldest opened at ${guyanaTime(oldest.createdAt)}. They are closed as FAILED drills and will not page again. ${advice}`;
  await notifyAdmins(prisma, notifications, {
    tenantId: null,
    title: 'Drill FAILED: nobody acknowledged the SOS paging drill',
    body,
    data: { kind: 'ops_alert_drill_failed', opsAlertId: oldest.id, opsAlertIds: drills.map((d) => d.id), count: drills.length },
    dedupeKey: `ops-alert-drill-failed:${oldest.id}`,
  }).catch((err) => log().error({ err, opsAlertIds: drills.map((d) => d.id) }, '[DRILL-STORM] the failed-drill notice could not be sent — the drills stay closed and listed'));
}

export interface OpsAlertScan {
  unacknowledgedOverdue: number;
  oldestOverdueSeconds: number;
  zeroRecipients: number;
  lastDrillAckSeconds: number | null;
  /** [DRILL-STORM] Drills closed FAILED (nobody acknowledged them) in the last 30 days. */
  drillsFailed30d: number;
}

/** [S-19 · operations] What ops should be paged on: zero ACK by deadline, and alerts nobody can acknowledge. */
export async function scanOpsAlerts(prisma: PrismaClient, now = new Date()): Promise<OpsAlertScan> {
  const overdue = await prisma.opsAlert.findMany({ where: { acknowledgedAt: null, closedAt: null, ackDeadlineAt: { lte: now } }, select: { ackDeadlineAt: true }, orderBy: { ackDeadlineAt: 'asc' }, take: 200 });
  const zero = await prisma.opsAlert.count({ where: { acknowledgedAt: null, closedAt: null, recipients: { none: {} } } });
  const drill = await prisma.opsAlert.findFirst({ where: { kind: 'DRILL', acknowledgedAt: { not: null } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, acknowledgedAt: true } });
  const drillsFailed30d = await prisma.opsAlert.count({ where: { kind: 'DRILL', closeReason: DRILL_FAILED_REASON, closedAt: { gte: new Date(now.getTime() - 30 * 86_400_000), lte: now } } });
  const scan: OpsAlertScan = {
    unacknowledgedOverdue: overdue.length,
    oldestOverdueSeconds: overdue[0] ? Math.max(0, Math.round((now.getTime() - overdue[0].ackDeadlineAt.getTime()) / 1000)) : 0,
    zeroRecipients: zero,
    lastDrillAckSeconds: drill?.acknowledgedAt ? Math.round((drill.acknowledgedAt.getTime() - drill.createdAt.getTime()) / 1000) : null,
    drillsFailed30d,
  };
  opsAlertGauge.labels('unacknowledged_overdue').set(scan.unacknowledgedOverdue);
  opsAlertGauge.labels('oldest_overdue_seconds').set(scan.oldestOverdueSeconds);
  opsAlertGauge.labels('zero_recipients').set(scan.zeroRecipients);
  opsAlertGauge.labels('last_drill_ack_seconds').set(scan.lastDrillAckSeconds ?? -1);
  opsAlertGauge.labels('drills_failed_30d').set(scan.drillsFailed30d);
  return scan;
}

/** [S-19 · operations] Periodic drills: the same obligation, the same
 *  deadline, the same escalation — with real people, on a schedule — for
 *  the drill's window; then, unacknowledged, a FAILED drill [DRILL-STORM]. */
export async function runOpsAlertDrillIfDue(prisma: PrismaClient, notifications: NotificationService, now = new Date()): Promise<{ opened: string | null }> {
  const days = drillIntervalDays();
  if (days === 0) return { opened: null };
  const last = await prisma.opsAlert.findFirst({ where: { kind: 'DRILL' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (last && now.getTime() - last.createdAt.getTime() < days * 86_400_000) return { opened: null };
  const res = await openOpsAlert(prisma, notifications, {
    kind: 'DRILL', tenantId: null, title: 'Ops alert drill — acknowledge now',
    body: drillBody(false),
    data: { kind: 'ops_alert_drill' }, now,
  });
  opsAlertCounter.labels('drill').inc();
  return { opened: res.opsAlertId };
}
