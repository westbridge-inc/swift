import { describe, it, expect } from 'vitest';
import { VerificationService } from '../modules/verification/verification.service';

// ---------------------------------------------------------------------------
// [AUD-L8b-001 · INV-15] Document expiry must take an admin-verified mover off
// the road.
//
// getLiveOperationStatus read `let baseOk = opts.legacyVerified ?? false` and
// only evaluated the checklist `if (!baseOk)`. `approvedEvidence(db, userId,
// required, now)` is the ONLY place `now` is consulted, so a true flag made
// expiry unreachable code. admin.routes.ts sets that flag on EVERY successful
// verification, so the "legacy" clause covered every verified mover.
//
// These tests drive the real evaluator through its `db` parameter, so they
// need no database. They fail on the pre-fix implementation.
// ---------------------------------------------------------------------------

const CHECKLIST = ['drivers_licence', 'police_clearance'];

/** A db double. `records` is what approvedEvidenceFor may return (i.e. CURRENT
 *  evidence only); `everHeld` is how many checklist records exist at all. */
function dbDouble(opts: { records?: unknown[]; everHeld: number }) {
  return {
    user: { findUnique: async () => ({ countryCode: 'GY' }) },
    subjectLink: { findMany: async () => [] },
    documentRecord: {
      findMany: async () => opts.records ?? [],
      count: async () => opts.everHeld,
    },
  } as never;
}

function service() {
  const svc = new VerificationService({} as never, {} as never, {} as never);
  (svc as unknown as { countryConfig: unknown }).countryConfig = {
    getMoverChecklist: async () => CHECKLIST,
  };
  return svc;
}

describe('[AUD-L8b-001 / INV-15] an expired document takes a verified mover off the road', () => {
  it('a cargo mover whose checklist has EXPIRED is refused even though documentsVerified is true', async () => {
    const status = await service().getLiveOperationStatus(
      'user-expired',
      { vehicleType: 'BICYCLE' as never, legacyVerified: true },
      dbDouble({ records: [], everHeld: 2 }), // held both docs; neither is current
    );
    expect(status).toEqual({ allowed: false, reason: 'docs' });
  });

  it('the flag still grandfathers an account that has NO checklist evidence at all', async () => {
    // The clause's stated purpose: pre-checklist accounts. Nothing has expired
    // because nothing was ever recorded — behaviour here must not change.
    const status = await service().getLiveOperationStatus(
      'user-legacy',
      { vehicleType: 'BICYCLE' as never, legacyVerified: true },
      dbDouble({ records: [], everHeld: 0 }),
    );
    expect(status).toEqual({ allowed: true, reason: 'ok' });
  });

  it('a mover with every checklist document CURRENT is allowed without the flag', async () => {
    const current = CHECKLIST.map((docType) => ({
      docType, expiresOn: new Date(Date.now() + 86_400_000),
      submission: { retentionExpiresAt: null, reviewedAt: new Date(), userId: 'u', subjectId: null, coverageClass: null, hireClassConfirmed: false, plateCrossChecked: false },
    }));
    const status = await service().getLiveOperationStatus(
      'user-current',
      { vehicleType: 'BICYCLE' as never, legacyVerified: false },
      dbDouble({ records: current, everHeld: 2 }),
    );
    expect(status).toEqual({ allowed: true, reason: 'ok' });
  });
});
