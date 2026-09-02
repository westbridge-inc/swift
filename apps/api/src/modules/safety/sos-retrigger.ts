import type { PrismaClient, SosTriggerSource } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { log } from '../../utils/logger';
import { sosRetriggerGauge } from '../../plugins/observability';

/**
 * [S-02] Concurrent SOS retriggers lose facts and the JSON array is unbounded.
 *
 * Stop-ship register S-02: the collapse read the alert's `retriggers` JSON
 * into memory and wrote it back as prior-plus-new. Two people (or one person
 * on two radios) pressing at once both read the same array and the last
 * writer won — a location and its provenance vanished from a life-safety
 * record. And every press grew the hot row without bound.
 *
 * Now every repeat trigger is its OWN immutable row (`sos_retriggers`),
 * numbered under the alert's row lock — `seq` is the alert's retriggerCount
 * after the status-guarded increment, so two concurrent appends serialize on
 * the lock and each lands with its own number. A request key makes a retried
 * request append once. The alert's JSON `retriggers` becomes a BOUNDED
 * summary of the newest rows, rebuilt from the table inside the same
 * transaction — derived, never authoritative.
 */
export const RETRIGGER_SUMMARY_CAP = 20;

export interface RetriggerFact {
  at: Date;
  source: SosTriggerSource;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  addressText: string | null;
  counterpartyUserId: string | null;
  actorRole: string;
  clientCreatedAt: Date | null;
}

type SummaryRow = { seq: number; at: Date; source: string; lat: number | null; lng: number | null; accuracyM: number | null; addressText: string | null; counterpartyUserId: string | null; actorRole: string; clientCreatedAt: Date | null };

function toSummary(r: SummaryRow) {
  return { seq: r.seq, at: r.at.toISOString(), source: r.source, lat: r.lat, lng: r.lng, accuracyM: r.accuracyM, addressText: r.addressText, counterpartyUserId: r.counterpartyUserId, actorRole: r.actorRole, clientCreatedAt: r.clientCreatedAt?.toISOString() ?? null };
}

/** Append one fact INSIDE the caller's transaction, after the caller's
 *  status-guarded increment has taken the alert's row lock. Returns the
 *  sequence number the fact received. */
export async function appendRetrigger(tx: Prisma.TransactionClient, sosAlertId: string, tenantId: string | null, fact: RetriggerFact, requestKey: string | null): Promise<{ seq: number }> {
  // The count we read here is OUR increment: the row lock the increment took
  // holds until this transaction commits, so a concurrent append waits and
  // then reads a strictly greater number.
  const { retriggerCount: seq } = await tx.sosAlert.findUniqueOrThrow({ where: { id: sosAlertId }, select: { retriggerCount: true } });
  await tx.sosRetrigger.create({
    data: { tenantId, sosAlertId, seq, requestKey, at: fact.at, source: fact.source, lat: fact.lat, lng: fact.lng, accuracyM: fact.accuracyM, addressText: fact.addressText, counterpartyUserId: fact.counterpartyUserId, actorRole: fact.actorRole as never, clientCreatedAt: fact.clientCreatedAt },
  });
  await refreshSummary(tx, sosAlertId);
  return { seq };
}

/** The bounded derived summary: the newest RETRIGGER_SUMMARY_CAP rows, oldest first. */
export async function refreshSummary(tx: Prisma.TransactionClient, sosAlertId: string): Promise<void> {
  const latest = await tx.sosRetrigger.findMany({ where: { sosAlertId }, orderBy: { seq: 'desc' }, take: RETRIGGER_SUMMARY_CAP });
  await tx.sosAlert.update({ where: { id: sosAlertId }, data: { retriggers: latest.reverse().map(toSummary) as Prisma.InputJsonValue } });
}

export interface SosRetriggerScan {
  /** Alerts whose rows do not account for their count: a lost sequence, or a fact never appended. */
  gaps: Array<{ sosAlertId: string; retriggerCount: number; rows: number; maxSeq: number }>;
  /** Alerts still carrying a JSON summary above the cap (pre-S-02 rows, not yet imported). */
  oversized: string[];
  /** Alerts with JSON history and no rows: the import's population. */
  legacy: string[];
}

/** [S-02 · operations] Lost-sequence gaps, oversized hot rows, and the legacy population. */
export async function scanSosRetriggers(prisma: PrismaClient): Promise<SosRetriggerScan> {
  const gaps = await prisma.$queryRaw<Array<{ sosAlertId: string; retriggerCount: number; rows: number; maxSeq: number }>>`
    SELECT a."id" AS "sosAlertId", a."retriggerCount", count(r."id")::int AS rows, coalesce(max(r."seq"), 0)::int AS "maxSeq"
    FROM "SosAlert" a JOIN "sos_retriggers" r ON r."sosAlertId" = a."id"
    GROUP BY a."id"
    HAVING count(r."id") <> a."retriggerCount" OR coalesce(max(r."seq"), 0) <> a."retriggerCount"
    ORDER BY a."triggeredAt" DESC LIMIT 100`;
  const oversized = (await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT a."id" FROM "SosAlert" a
    WHERE a."retriggers" IS NOT NULL AND jsonb_typeof(a."retriggers") = 'array' AND jsonb_array_length(a."retriggers") > ${RETRIGGER_SUMMARY_CAP}
    LIMIT 100`).map((r) => r.id);
  const legacy = (await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT a."id" FROM "SosAlert" a
    WHERE a."retriggers" IS NOT NULL AND jsonb_typeof(a."retriggers") = 'array' AND jsonb_array_length(a."retriggers") > 0
      AND NOT EXISTS (SELECT 1 FROM "sos_retriggers" r WHERE r."sosAlertId" = a."id")
    LIMIT 200`).map((r) => r.id);
  sosRetriggerGauge.labels('sequence_gaps').set(gaps.length);
  sosRetriggerGauge.labels('oversized_summary').set(oversized.length);
  sosRetriggerGauge.labels('legacy_pending').set(legacy.length);
  if (gaps.length > 0) log().warn({ gaps: gaps.slice(0, 10) }, '[S-02] SOS alerts whose retrigger rows do not account for their count');
  return { gaps, oversized, legacy };
}

/** [S-02 · operations] The current JSON is imported history: each legacy
 *  entry becomes a row (seq 1..n in array order), idempotent on (alert, seq),
 *  and the summary is rebuilt bounded. */
export async function importLegacyRetriggers(prisma: PrismaClient): Promise<{ imported: string[] }> {
  const { legacy } = await scanSosRetriggers(prisma);
  const imported: string[] = [];
  for (const id of legacy) {
    const alert = await prisma.sosAlert.findUnique({ where: { id }, select: { tenantId: true, retriggers: true, actorRole: true, triggerSource: true, triggeredAt: true } });
    if (!alert || !Array.isArray(alert.retriggers)) continue;
    const entries = alert.retriggers as Array<Record<string, unknown>>;
    await prisma.$transaction(async (tx) => {
      await tx.sosRetrigger.createMany({
        data: entries.map((e, i) => ({
          tenantId: alert.tenantId, sosAlertId: id, seq: i + 1, requestKey: null,
          at: typeof e['at'] === 'string' && !Number.isNaN(Date.parse(e['at'])) ? new Date(e['at']) : alert.triggeredAt,
          source: (typeof e['source'] === 'string' ? e['source'] : alert.triggerSource) as SosTriggerSource,
          lat: typeof e['lat'] === 'number' ? e['lat'] : null, lng: typeof e['lng'] === 'number' ? e['lng'] : null,
          accuracyM: typeof e['accuracyM'] === 'number' ? e['accuracyM'] : null,
          addressText: typeof e['addressText'] === 'string' ? e['addressText'] : null,
          counterpartyUserId: typeof e['counterpartyUserId'] === 'string' ? e['counterpartyUserId'] : null,
          actorRole: (typeof e['actorRole'] === 'string' ? e['actorRole'] : alert.actorRole) as never,
          clientCreatedAt: typeof e['clientCreatedAt'] === 'string' && !Number.isNaN(Date.parse(e['clientCreatedAt'])) ? new Date(e['clientCreatedAt']) : null,
        })),
        skipDuplicates: true,
      });
      await refreshSummary(tx, id);
    });
    imported.push(id);
  }
  if (imported.length > 0) log().warn({ imported }, '[S-02] legacy SOS retrigger history imported as rows');
  return { imported };
}
