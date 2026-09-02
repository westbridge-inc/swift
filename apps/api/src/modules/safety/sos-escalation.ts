import type { PrismaClient, SosEscalationChannel } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { NotificationService } from '../notification/notification.service';
import { openOpsAlert } from './ops-alert';
import { warRoomsFor } from './war-room';
import { log } from '../../utils/logger';
import { sosEscalationCounter, sosEscalationGauge } from '../../plugins/observability';

/**
 * [S-01] Every ACTIVE SOS owns a durable, retryable escalation command until
 * the delivery policy is satisfied.
 *
 * Stop-ship register S-01: the alert was committed ACTIVE and THEN an
 * in-process series paged ops, emitted to the war room, texted the contacts
 * and opened the evidence bundle. A process that died after the commit — or
 * mid-series — left an ACTIVE alert that nobody was ever told about, forever.
 *
 * Now the policy is STAGED as rows in the same transaction as the ACTIVE
 * commit: one SosEscalation per required delivery (the ops page, the war-room
 * emit, each verified contact's SMS, the evidence bundle), unique per
 * (alert, channel, target). A leased worker delivers each row exactly once
 * and retries it independently with backoff; exhausted attempts FAIL the row
 * and page the platform. Delivery runs inline right after the commit (the
 * fail-safe path) and the tick drains whatever is left. An ACTIVE alert whose
 * ops page is still undelivered after a minute is the watchdog's page.
 * Acknowledgement and resolution never delete pending evidence work.
 */
export const SOS_ESCALATION_ENFORCED_AT = new Date('2026-09-02T08:00:00.000Z');
export const ACTIVE_WITHOUT_PAGE_SECONDS = 60;

export function sosEscalationWorkerKilled(env: Record<string, string | undefined> = process.env): boolean {
  return env['SOS_ESCALATION_WORKER_KILL'] === '1';
}

/** Test seam: runs inside the worker before a claimed row is delivered. Never set in routes. */
export interface SosEscalationObserver {
  beforeDeliver?: (row: { sosAlertId: string; channel: SosEscalationChannel; targetKey: string; attempts: number }) => Promise<void>;
}

type AlertForPolicy = { id: string; tenantId: string | null; actorUserId: string; triggerSource: string };

/** Stage the delivery policy INSIDE the caller's transaction. Idempotent:
 *  the unique (alert, channel, target) makes a second staging a no-op. A
 *  re-page (a retrigger with a new position) stages new page rows keyed by
 *  the retrigger count; the evidence row is staged once. */
export async function stageEscalations(tx: Prisma.TransactionClient, alert: AlertForPolicy, opts: { repage?: number } = {}): Promise<{ staged: number }> {
  const suffix = opts.repage ? `:repage:${opts.repage}` : '';
  const rows: Array<{ channel: SosEscalationChannel; targetKey: string; status?: 'PENDING' | 'SKIPPED'; receipt?: Prisma.InputJsonValue }> = [
    { channel: 'OPS_PAGE', targetKey: `ops${suffix}` },
    { channel: 'WAR_ROOM', targetKey: `war-room${suffix}` },
  ];
  if (!opts.repage) {
    // Guardian §5.3 L4: an alert born from an UNANSWERED check-in timeout is
    // the server guessing, not a human asking — contacts are not auto-SMSed
    // unless the tenant opted in. The policy records the skip as a row, so
    // "no SMS" is a decision with a receipt, never a silence.
    const skipContactSms = alert.triggerSource === 'CHECKIN_TIMEOUT' && process.env['GUARDIAN_AUTONOTIFY_CONTACTS'] !== '1';
    const contacts = await tx.emergencyContact.findMany({ where: { userId: alert.actorUserId, verifiedAt: { not: null } }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }], take: 10, select: { id: true } });
    for (const c of contacts) rows.push({ channel: 'CONTACT_SMS', targetKey: c.id, ...(skipContactSms ? { status: 'SKIPPED' as const, receipt: { skipped: 'guardian-default' } } : {}) });
    rows.push({ channel: 'EVIDENCE', targetKey: 'evidence' });
  }
  const res = await tx.sosEscalation.createMany({
    data: rows.map((r) => ({ tenantId: alert.tenantId, sosAlertId: alert.id, channel: r.channel, targetKey: r.targetKey, status: r.status ?? 'PENDING', receipt: r.receipt ?? undefined, ...(r.status === 'SKIPPED' ? { deliveredAt: new Date() } : {}) })),
    skipDuplicates: true,
  });
  if (res.count > 0) sosEscalationCounter.labels('staged').inc(res.count);
  return { staged: res.count };
}

type Claimed = { id: string; sosAlertId: string; channel: SosEscalationChannel; targetKey: string; attempts: number; maxAttempts: number };

async function claimNext(prisma: PrismaClient, leaseMs: number, alertIds?: string[]): Promise<Claimed | null> {
  const filter = alertIds?.length ? Prisma.sql`AND "sosAlertId" IN (${Prisma.join(alertIds)})` : Prisma.empty;
  const rows = await prisma.$queryRaw<Claimed[]>(Prisma.sql`
    WITH candidate AS (
      SELECT "id" FROM "sos_escalations"
      WHERE "status" = 'PENDING'
        AND ("attempts" = 0 OR "availableAt" <= CURRENT_TIMESTAMP)
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < CURRENT_TIMESTAMP) ${filter}
      ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE "sos_escalations" AS e
    SET "leaseExpiresAt" = CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond'), "attempts" = e."attempts" + 1, "updatedAt" = CURRENT_TIMESTAMP
    FROM candidate WHERE e."id" = candidate."id"
    RETURNING e."id", e."sosAlertId", e."channel", e."targetKey", e."attempts", e."maxAttempts"`);
  return rows[0] ?? null;
}

const TERMINAL = new Set(['RESOLVED', 'CANCELLED']);

/** Deliver one claimed row. Returns the receipt, or 'skipped' with a reason. */
async function deliver(prisma: PrismaClient, io: Server, notifications: NotificationService, row: Claimed): Promise<{ status: 'SENT' | 'SKIPPED'; receipt: Record<string, unknown> }> {
  const alert = await prisma.sosAlert.findUnique({ where: { id: row.sosAlertId } });
  if (!alert) return { status: 'SKIPPED', receipt: { skipped: 'alert-gone' } };
  switch (row.channel) {
    case 'OPS_PAGE': {
      if (TERMINAL.has(alert.status)) return { status: 'SKIPPED', receipt: { skipped: `alert-${alert.status.toLowerCase()}` } };
      // [F-026-15] The alert's own tenant decides who is paged; NULL = platform
      // operators only. [F-035-07] No coordinates in a push payload.
      // [S-19] The page is an OpsAlert: per-recipient delivery and
      // acknowledgement with a deadline; unacknowledged, it escalates.
      const page = await openOpsAlert(prisma, notifications, {
        kind: 'SOS', tenantId: alert.tenantId, sosAlertId: alert.id,
        title: '🚨 SOS ACTIVE — respond now',
        body: `${alert.actorRole} raised an SOS${alert.orderId ? ` on order ${alert.orderId}` : alert.serviceJobId ? ' on a service job (home visit)' : ''}. Open the war room now.`,
        data: { kind: 'sos_active', sosAlertId: alert.id, orderId: alert.orderId, serviceJobId: alert.serviceJobId },
      });
      return { status: 'SENT', receipt: { opsPaged: page.delivered, opsAlertId: page.opsAlertId, recipients: page.recipients } };
    }
    case 'WAR_ROOM': {
      if (TERMINAL.has(alert.status)) return { status: 'SKIPPED', receipt: { skipped: `alert-${alert.status.toLowerCase()}` } };
      const rooms = warRoomsFor(alert.tenantId);
      io.to(rooms).emit('sos:active', { sosAlertId: alert.id, tenantId: alert.tenantId, actorRole: alert.actorRole, orderId: alert.orderId, serviceJobId: alert.serviceJobId, lat: alert.triggerLat, lng: alert.triggerLng, triggeredAt: alert.triggeredAt });
      // [F-027-16] Count the sockets actually in the room — a silence receipt has to be able to say zero.
      let listeners = 0;
      try { listeners = (await io.in(rooms).fetchSockets()).length; } catch { listeners = 0; }
      if (listeners === 0) {
        sosEscalationCounter.labels('zero_listeners').inc();
        log().error({ sosAlertId: alert.id, tenantId: alert.tenantId, rooms }, 'SOS escalation: war-room emit reached ZERO sockets — nobody is watching the live board');
      }
      return { status: 'SENT', receipt: { socketListeners: listeners } };
    }
    case 'CONTACT_SMS': {
      if (TERMINAL.has(alert.status)) return { status: 'SKIPPED', receipt: { skipped: `alert-${alert.status.toLowerCase()}` } };
      const contact = await prisma.emergencyContact.findUnique({ where: { id: row.targetKey } });
      if (!contact || !contact.verifiedAt) return { status: 'SKIPPED', receipt: { skipped: 'contact-unverified-or-gone' } };
      const { getChannels } = await import('../../providers/notifications/channels');
      const actor = await prisma.user.findUnique({ where: { id: alert.actorUserId }, select: { firstName: true } });
      const who = actor?.firstName?.trim() || 'Someone you know';
      const where = alert.triggerLat != null && alert.triggerLng != null ? ` Last known location: https://maps.google.com/?q=${alert.triggerLat},${alert.triggerLng}.` : '';
      await getChannels().sms.sendSms(contact.phoneE164, `🚨 ${who} triggered an emergency SOS on Swift and may need help.${where} Please check on them and contact local emergency services if you cannot reach them.`);
      return { status: 'SENT', receipt: { id: contact.id, ok: true } };
    }
    case 'EVIDENCE': {
      // §9.1 — runs regardless of ack or resolution: acknowledgement never
      // deletes pending evidence work. openForSos is idempotent.
      const { EvidenceService } = await import('./evidence.service');
      const bundle = await new EvidenceService(prisma, io).openForSos(alert.id);
      return { status: 'SENT', receipt: { bundleId: bundle?.id ?? null } };
    }
  }
}

/** Rebuild the alert's legacy `deliveryReceipts` from its rows, merging over
 *  whatever a later path (the resolve all-clear) has written. */
async function refreshReceipts(prisma: PrismaClient, sosAlertId: string): Promise<void> {
  // Newest first: the summary names the LATEST page; every earlier attempt
  // stays in its own row, so a re-page never destroys the original proof.
  const rows = await prisma.sosEscalation.findMany({ where: { sosAlertId, status: { in: ['SENT', 'SKIPPED'] } }, orderBy: { createdAt: 'desc' } });
  const alert = await prisma.sosAlert.findUnique({ where: { id: sosAlertId }, select: { deliveryReceipts: true } });
  const receipts: Record<string, unknown> = { ...((alert?.deliveryReceipts as Record<string, unknown> | null) ?? {}) };
  const ops = rows.find((r) => r.channel === 'OPS_PAGE' && r.status === 'SENT');
  if (ops) receipts['opsPaged'] = (ops.receipt as Record<string, unknown> | null)?.['opsPaged'] ?? 0;
  const room = rows.find((r) => r.channel === 'WAR_ROOM' && r.status === 'SENT');
  if (room) receipts['socketListeners'] = (room.receipt as Record<string, unknown> | null)?.['socketListeners'] ?? 0;
  const repages = rows.filter((r) => r.channel === 'OPS_PAGE' && r.targetKey.startsWith('ops:repage:')).length;
  if (repages > 0) receipts['repages'] = repages;
  const contacts = rows.filter((r) => r.channel === 'CONTACT_SMS');
  if (contacts.length > 0) {
    receipts['contacts'] = contacts.some((c) => c.status === 'SKIPPED' && (c.receipt as Record<string, unknown> | null)?.['skipped'] === 'guardian-default')
      ? 'skipped:guardian-default'
      : contacts.map((c) => ({ id: c.targetKey, ok: c.status === 'SENT' }));
  }
  await prisma.sosAlert.update({ where: { id: sosAlertId }, data: { deliveryReceipts: receipts as Prisma.InputJsonValue } })
    .catch((err) => log().error({ err, sosAlertId }, '[S-01] could not refresh the alert’s delivery receipts from its rows'));
}

/** Drain due rows with a lease; each delivers once; failures back off and
 *  retry; exhausted attempts FAIL the row and page the platform. */
export async function drainSosEscalations(
  prisma: PrismaClient,
  io: Server,
  options: { limit?: number; leaseMs?: number; alertIds?: string[]; observer?: SosEscalationObserver } = {},
): Promise<{ delivered: number; skipped: number; failed: number; deadLettered: number }> {
  const notifications = new NotificationService(prisma, io);
  const leaseMs = Math.max(1_000, options.leaseMs ?? 30_000);
  const limit = Math.max(1, options.limit ?? 100);
  const touched = new Set<string>();
  let delivered = 0; let skipped = 0; let failed = 0; let deadLettered = 0;
  for (let i = 0; i < limit; i += 1) {
    const row = await claimNext(prisma, leaseMs, options.alertIds);
    if (!row) break;
    touched.add(row.sosAlertId);
    try {
      await options.observer?.beforeDeliver?.(row);
      const result = await deliver(prisma, io, notifications, row);
      await prisma.sosEscalation.update({ where: { id: row.id }, data: { status: result.status, receipt: result.receipt as Prisma.InputJsonValue, deliveredAt: new Date(), leaseExpiresAt: null, lastError: null } });
      if (result.status === 'SENT') { delivered += 1; sosEscalationCounter.labels('sent').inc(); } else { skipped += 1; }
    } catch (err) {
      failed += 1;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 2_000);
      const exhausted = row.attempts >= row.maxAttempts;
      const backoffMs = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(row.attempts, 6));
      // The claim compares availableAt with the database clock, so the backoff
      // is computed on that same clock — never on this process's clock.
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "sos_escalations"
        SET "leaseExpiresAt" = NULL, "lastError" = ${message}, "updatedAt" = CURRENT_TIMESTAMP,
            "availableAt" = CURRENT_TIMESTAMP + (${backoffMs} * INTERVAL '1 millisecond'),
            "status" = ${exhausted ? 'FAILED' : 'PENDING'}::"SosEscalationStatus"
        WHERE "id" = ${row.id}`).catch((e) => log().error({ err: e, id: row.id }, '[S-01] could not record the failed attempt'));
      sosEscalationCounter.labels(exhausted ? 'dead_letter' : 'failed').inc();
      if (exhausted) deadLettered += 1;
      log().error({ err, sosAlertId: row.sosAlertId, channel: row.channel, targetKey: row.targetKey, attempts: row.attempts, exhausted }, '[S-01] SOS escalation delivery failed — will retry');
    }
  }
  for (const id of touched) await refreshReceipts(prisma, id);
  return { delivered, skipped, failed, deadLettered };
}

export interface SosEscalationScan {
  /** ACTIVE / ACKNOWLEDGED alerts whose ops page is still undelivered past the threshold. */
  activeWithoutPage: Array<{ sosAlertId: string; tenantId: string | null; ageSeconds: number }>;
  pending: number;
  failed: number;
  /** Live alerts with no escalation rows at all (pre-outbox, or a bug) — the backfill's population. */
  liveWithoutRows: string[];
}

/** [S-01 · operations] The ACTIVE watchdog and the backfill population. */
export async function scanSosEscalations(prisma: PrismaClient, now = new Date()): Promise<SosEscalationScan> {
  const threshold = new Date(now.getTime() - ACTIVE_WITHOUT_PAGE_SECONDS * 1000);
  const activeWithoutPage = await prisma.$queryRaw<Array<{ sosAlertId: string; tenantId: string | null; ageSeconds: number }>>`
    SELECT a."id" AS "sosAlertId", a."tenantId", extract(epoch FROM (${now} - a."triggeredAt"))::int AS "ageSeconds"
    FROM "SosAlert" a
    WHERE a."status" IN ('ACTIVE', 'ACKNOWLEDGED') AND a."triggeredAt" <= ${threshold}
      AND EXISTS (SELECT 1 FROM "sos_escalations" e WHERE e."sosAlertId" = a."id")
      AND NOT EXISTS (SELECT 1 FROM "sos_escalations" e WHERE e."sosAlertId" = a."id" AND e."channel" = 'OPS_PAGE' AND e."targetKey" = 'ops' AND e."status" IN ('SENT', 'SKIPPED'))
    ORDER BY a."triggeredAt" ASC LIMIT 100`;
  const [counts] = await prisma.$queryRaw<Array<{ pending: bigint; failed: bigint }>>`
    SELECT count(*) FILTER (WHERE "status" = 'PENDING')::bigint AS pending, count(*) FILTER (WHERE "status" = 'FAILED')::bigint AS failed FROM "sos_escalations"`;
  const liveWithoutRows = (await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT a."id" FROM "SosAlert" a WHERE a."status" IN ('ACTIVE', 'ACKNOWLEDGED')
      AND NOT EXISTS (SELECT 1 FROM "sos_escalations" e WHERE e."sosAlertId" = a."id") LIMIT 200`).map((r) => r.id);
  const scan = { activeWithoutPage, pending: Number(counts?.pending ?? 0), failed: Number(counts?.failed ?? 0), liveWithoutRows };
  sosEscalationGauge.labels('active_without_page').set(activeWithoutPage.length);
  sosEscalationGauge.labels('active_without_page_oldest_seconds').set(activeWithoutPage[0]?.ageSeconds ?? 0);
  sosEscalationGauge.labels('pending').set(scan.pending);
  sosEscalationGauge.labels('failed').set(scan.failed);
  sosEscalationGauge.labels('live_without_rows').set(liveWithoutRows.length);
  return scan;
}

/** [S-01 · operations] Backfill every live alert lacking delivery-attempt
 *  proof: stage its policy so the worker delivers it now. */
export async function backfillSosEscalations(prisma: PrismaClient): Promise<{ backfilled: string[] }> {
  const scan = await scanSosEscalations(prisma);
  const backfilled: string[] = [];
  for (const id of scan.liveWithoutRows) {
    const alert = await prisma.sosAlert.findUnique({ where: { id }, select: { id: true, tenantId: true, actorUserId: true, triggerSource: true } });
    if (!alert) continue;
    const res = await prisma.$transaction((tx) => stageEscalations(tx, alert));
    if (res.staged > 0) { backfilled.push(id); sosEscalationCounter.labels('backfilled').inc(); }
  }
  return { backfilled };
}
