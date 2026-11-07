import { errorStatus } from './api';

/**
 * [ADMIN-AUDIT S3-1] A refusal is an answer, not a hiccup. React Query retries a failed read three times by
 * default, so an ADMIN opening a founder page (or a narrowed operator on most pages) watched about 7 s of
 * "Loading…" before "You don't have permission". A 4xx (refused, not found, invalid) is final at once; only a
 * network failure or a 5xx is tried again, up to three times as before.
 */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
  const status = errorStatus(error);
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  return failureCount < 3;
}
