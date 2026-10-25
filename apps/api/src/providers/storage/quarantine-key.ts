/**
 * [Row 312] The malware quarantine's keys. Nothing under `quarantine/` is ever served: both storage
 * adapters call assertServableKey before signing a URL. A leaf module (no imports beyond the error
 * type) so the storage adapters can use it without pulling in the rescan job.
 */
import { AppError } from '../../utils/errors';

/** Is this stored key (an S3 key or a local "/uploads/..." path) in the quarantine? */
export function isQuarantineKey(fileKey: string): boolean {
  const key = fileKey.startsWith('/uploads/') ? fileKey.slice('/uploads/'.length) : fileKey;
  return key === 'quarantine' || key.startsWith('quarantine/');
}

/** Both storage adapters call this before signing a URL: nothing in the quarantine is ever served. */
export function assertServableKey(fileKey: string): void {
  if (isQuarantineKey(fileKey)) throw new AppError(404, 'NOT_FOUND', 'This file is not available.');
}
