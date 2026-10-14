import { describe, expect, it } from 'vitest';
import { LIVE_DOCUMENTS_CONCURRENCY, withLiveDocuments } from '../modules/admin/live-documents';

// [Owner report 8 Oct · DS1014 S3] A full list page (50 rows) evaluates the live document verdict per row,
// ~10 queries each. Fired all at once that saturates the database pool for every other request, so rows are
// evaluated a few at a time. Order and the null-on-failure rule are kept.

const rows = Array.from({ length: 23 }, (_, i) => ({ userId: `u${i}`, vehicleType: 'CAR' as const, documentsVerified: false }));

describe('[DS1014] live document verdicts on a list page', () => {
  it('evaluates at most a few rows at a time, keeps row order, and reads a failure as null', async () => {
    let inFlight = 0;
    let peak = 0;
    const evaluate = async (_db: unknown, userId: string) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      if (userId === 'u7') throw new Error('synthetic evaluation failure');
      return { allowed: userId === 'u3', reason: userId === 'u3' ? 'ok' as const : 'docs' as const, validUntil: null };
    };
    const out = await withLiveDocuments({} as never, rows, 'DRIVER', evaluate as never);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(LIVE_DOCUMENTS_CONCURRENCY);
    expect(out.map((r) => r.userId)).toEqual(rows.map((r) => r.userId));
    expect(out[3]!.documentsLive).toEqual({ allowed: true, reason: 'ok', validUntil: null });
    expect(out[7]!.documentsLive).toBeNull();
  });
});
