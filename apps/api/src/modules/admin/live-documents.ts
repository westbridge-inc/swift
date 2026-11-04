/**
 * [Owner report 8 Oct 2026] The admin Drivers and Riders lists showed only the legacy documentsVerified flag, so a
 * driver the live per-document gate lets online read "not verified" (and the reverse). Each row now carries the
 * verdict GO itself uses — evaluateMoverDocuments, with the same legacy grant it honours: complete, documents
 * missing, or hire insurance missing. Additive field; a failed evaluation reads null, never "complete".
 */
import type { VehicleType } from '@prisma/client';
import { evaluateMoverDocuments } from '../verification/mover-document-authority';

type Db = Parameters<typeof evaluateMoverDocuments>[0];
export interface LiveDocuments { allowed: boolean; reason: 'ok' | 'docs' | 'insurance'; validUntil: Date | null }

/** [DS1014] Rows evaluated at once. Each verdict is ~10 queries; a whole page at once would starve the pool. */
export const LIVE_DOCUMENTS_CONCURRENCY = 4;

export async function withLiveDocuments<T extends { userId: string; vehicleType: VehicleType; documentsVerified: boolean }>(
  db: Db, rows: T[], kind: 'DRIVER' | 'RIDER', evaluate: typeof evaluateMoverDocuments = evaluateMoverDocuments,
): Promise<Array<T & { documentsLive: LiveDocuments | null }>> {
  const out: Array<T & { documentsLive: LiveDocuments | null }> = new Array(rows.length);
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const index = next++;
      const row = rows[index]!;
      const verdict = await evaluate(db, row.userId, { kind, vehicleType: row.vehicleType, legacyVerified: row.documentsVerified }).catch(() => null);
      out[index] = { ...row, documentsLive: verdict ? { allowed: verdict.allowed, reason: verdict.reason, validUntil: verdict.validUntil } : null };
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIVE_DOCUMENTS_CONCURRENCY, rows.length) }, worker));
  return out;
}

/** [BUG-HUNT F06] A filter reads every candidate's verdict, so it has a ceiling. Far above any market Swift serves. */
export const LIVE_DOCUMENTS_FILTER_CAP = 2000;

/** [BUG-HUNT F06] The ids of the rows the verdict GO uses calls complete (or not). A failed evaluation is never "complete". */
export async function idsByLiveDocuments<T extends { id: string; userId: string; vehicleType: VehicleType; documentsVerified: boolean }>(
  db: Db, rows: T[], kind: 'DRIVER' | 'RIDER', complete: boolean,
): Promise<string[]> {
  const judged = await withLiveDocuments(db, rows, kind);
  return judged.filter((row) => (row.documentsLive?.allowed === true) === complete).map((row) => row.id);
}
