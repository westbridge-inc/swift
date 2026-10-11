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

export async function withLiveDocuments<T extends { userId: string; vehicleType: VehicleType; documentsVerified: boolean }>(
  db: Db, rows: T[], kind: 'DRIVER' | 'RIDER',
): Promise<Array<T & { documentsLive: LiveDocuments | null }>> {
  return Promise.all(rows.map(async (row) => {
    const verdict = await evaluateMoverDocuments(db, row.userId, { kind, vehicleType: row.vehicleType, legacyVerified: row.documentsVerified }).catch(() => null);
    return { ...row, documentsLive: verdict ? { allowed: verdict.allowed, reason: verdict.reason, validUntil: verdict.validUntil } : null };
  }));
}
