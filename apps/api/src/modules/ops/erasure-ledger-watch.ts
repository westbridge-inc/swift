import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { NotificationService } from '../notification/notification.service';
import { pageOps, resolveOpsPage, type PageOutcome } from './ops-page';

// ---------------------------------------------------------------------------
// [Off-site erasure ledger · COORD ruling 21 Oct] Every erasure writes its ledger entry in its own
// transaction (database triggers, migration 20261021140000); the host unit
// (deploy/erasure-ledger-ship.sh, every minute) ships it, encrypted to the owner's backup key, to the
// off-site backup bucket. An entry still unshipped after 10 minutes means that unit has stopped, and a
// total loss of the live database now would bring the erased person back from the newest backup.
// This reads counts and ages only: never an id, never an entry.
// ---------------------------------------------------------------------------

export const ERASURE_LEDGER_MAX_UNSHIPPED_MINUTES = 10;
export const ERASURE_LEDGER_PAGE_TITLE = 'Erasures are not reaching the off-site ledger';
export const ERASURE_LEDGER_PAGE_KEY = 'ops_page:erasure-ledger';

export interface ErasureLedgerShipping {
  stale: boolean;
  /** Entries older than the window and not shipped. */
  unshipped: number;
  /** Age in minutes of the oldest unshipped entry (any age); null when nothing is waiting. */
  oldestMinutes: number | null;
  /** Safe to put straight into an alert body: counts and ages only. */
  reason: string;
}

export async function checkErasureLedgerShipping(prisma: PrismaClient): Promise<ErasureLedgerShipping> {
  // Ages are measured by the database clock that stamped the entries (createdAt is the session's
  // now()), never this process's clock.
  const [row] = await prisma.$queryRawUnsafe<Array<{ late: bigint; oldest: number | null }>>(
    `SELECT count(*) FILTER (WHERE e."createdAt" < now()::timestamp(3) - make_interval(mins => $1::int)) AS late,
            extract(epoch FROM now()::timestamp(3) - min(e."createdAt")) / 60 AS oldest
       FROM erasure_ledger_entry e
      WHERE NOT EXISTS (SELECT 1 FROM erasure_ledger_shipment s WHERE s."entryId" = e.id)`,
    ERASURE_LEDGER_MAX_UNSHIPPED_MINUTES);
  const unshipped = Number(row?.late ?? 0);
  const oldestMinutes = row?.oldest === null || row?.oldest === undefined ? null : Math.floor(Number(row.oldest));
  if (unshipped === 0) {
    return { stale: false, unshipped: 0, oldestMinutes, reason: 'Every erasure older than the window has reached the off-site ledger.' };
  }
  return {
    stale: true, unshipped, oldestMinutes,
    reason: `${unshipped} erasure ledger entr${unshipped === 1 ? 'y has' : 'ies have'} not reached the off-site ledger for more than ${ERASURE_LEDGER_MAX_UNSHIPPED_MINUTES} minutes `
      + `(oldest ${oldestMinutes ?? '?'} min). The host unit swift-erasure-ledger has stopped: check it (journalctl -u swift-erasure-ledger). `
      + 'Until it ships, losing the live database would bring these erased people back from the newest backup.',
  };
}

/** A platform page through the durable ops path (OpsAlert + on-call texts + escalation), one per window;
 *  a shipped ledger closes it. */
export async function pageErasureLedgerShipping(
  deps: { prisma: PrismaClient; redis: Redis; notifications: NotificationService },
): Promise<{ result: ErasureLedgerShipping; page: PageOutcome | null }> {
  const result = await checkErasureLedgerShipping(deps.prisma);
  if (!result.stale) {
    await resolveOpsPage(deps.prisma, ERASURE_LEDGER_PAGE_TITLE, 'erasure-ledger-shipped');
    return { result, page: null };
  }
  const page = await pageOps(deps, {
    key: ERASURE_LEDGER_PAGE_KEY,
    windowSeconds: 3600,
    title: ERASURE_LEDGER_PAGE_TITLE,
    body: result.reason,
    data: { kind: 'ops_backup_stale', erasureLedger: true, unshipped: result.unshipped, oldestMinutes: result.oldestMinutes },
  });
  return { result, page };
}
