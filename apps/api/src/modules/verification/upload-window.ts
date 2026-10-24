import { AppError } from '../../utils/errors';

/**
 * [Row 249 · COORD 17:09Z option A] How long an upload may stay unclaimed while the account is open.
 * POST /verification/upload stores one encrypted object per file; one that never becomes a document
 * (an onboarding left halfway, the identity check's selfie, which is checked but never linked) is
 * erased by the daily sweep (user/upload-erasure.ts sweepStaleUnclaimedUploads) once it is older.
 */
export const UNCLAIMED_UPLOAD_DAYS = 30;
/** The last age at which an upload can still be claimed: one day inside the sweep's window, so a claim never meets the sweep. */
export const UPLOAD_CLAIM_DAYS = UNCLAIMED_UPLOAD_DAYS - 1;
export const UPLOAD_DAY_MS = 86_400_000;

/** A document or an identity check refuses an upload older than UPLOAD_CLAIM_DAYS: the person sends it again. */
export function assertClaimableUpload(object: { createdAt: Date }, now: Date = new Date()): void {
  if (now.getTime() - object.createdAt.getTime() > UPLOAD_CLAIM_DAYS * UPLOAD_DAY_MS) {
    throw new AppError(409, 'UPLOAD_TOO_OLD', 'This photo was sent too long ago to use. Please take or choose it again.');
  }
}
