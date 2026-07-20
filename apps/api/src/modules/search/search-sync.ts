import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Debounced on-write search sync [SWIFT-UG-SRCH-01].
//
// Search previously synced only at boot and on the admin's manual reindex —
// a new vendor, an edited menu, or an 86'd item drifted out of truth until a
// restart. Every catalog write path now schedules this; the BullMQ jobId is
// the debounce (while a delayed `search-sync:<vendorId>` job exists, further
// schedules are no-ops), so a 500-row CSV import collapses to ONE sync.
//
// Best-effort by design: search is a discovery surface, not a ledger. A
// missed schedule (queues down, redis blip) self-heals at the next write or
// the boot/admin full sync — so this must never throw into a write path.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 3_000;

export function scheduleVendorSearchSync(
  app: Pick<FastifyInstance, 'queues' | 'log'>,
  vendorId: string,
): void {
  app.queues?.searchQueue
    .add(
      'sync-vendor',
      { vendorId },
      {
        // NB: BullMQ custom job ids must not contain ':' (its key delimiter).
        jobId: `search-sync-${vendorId}`,
        delay: DEBOUNCE_MS,
        removeOnComplete: true,
        removeOnFail: true,
      },
    )
    .catch((err) => {
      app.log?.debug?.({ err, vendorId }, 'search sync schedule skipped');
    });
}
