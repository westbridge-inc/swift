import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTO_APPROVE_EXPIRY_DAYS } from '../modules/verification/doc-registry';
import { HIRE_SPLIT_DOC_TYPES } from '../modules/verification/hire-permit-grace';
import { resolveApprovalExpiry } from '../modules/verification/verification.service';

// ---------------------------------------------------------------------------
// [STAGING-RUN · journeys-on-copy at 100c9213, 26 Oct] The journey roster's provisioner
// (scripts/livetest/provision.ts approveDoc) approves each partner document as the admin and keys an
// expiry for the types it believes expire. Its copy of that list predated the hire licence split
// (VERIFY-DOCS ruling 8), so the API refused both hire licences of every roster taxi driver
// (400 EXPIRY_REQUIRED, correctly), the both-licences go-online rule kept them all offline, and TAXI-02
// failed "two drivers online" on the walled copy. CI never runs the journeys: this keeps every type the
// registry says expires in the harness's copy, and the date it keys accepted for every one of them.
// (The copy may also key a date for a type the registry does not expire, e.g. vehicle_registration since
// TASK-057: the API stores the typed date, nothing is refused, so that direction cannot break a journey.)
// ---------------------------------------------------------------------------

const provision = readFileSync(join(__dirname, '../../../../scripts/livetest/provision.ts'), 'utf8');

/** The doc types provision.ts keys an expiry for (its EXPIRING set), sorted. */
function harnessExpiring(): string[] {
  const m = /const EXPIRING = new Set\(\[([\s\S]*?)\]\);/.exec(provision);
  if (!m) throw new Error('scripts/livetest/provision.ts: the EXPIRING set was not found');
  return [...m[1]!.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]!).sort();
}

/** How many days ahead approveDoc keys the expiry. */
function harnessExpiryDays(): number {
  const m = /if \(EXPIRING\.has\(docType\)\) body\.expiresAt = inDays\((\d+)\);/.exec(provision);
  if (!m) throw new Error('scripts/livetest/provision.ts: the keyed expiry in approveDoc was not found');
  return Number(m[1]);
}

describe('[journeys roster] the provisioner keys an expiry for every document type that expires', () => {
  it('its EXPIRING copy holds every type the registry says expires (AUTO_APPROVE_EXPIRY_DAYS)', () => {
    const copy = new Set(harnessExpiring());
    const missing = Object.keys(AUTO_APPROVE_EXPIRY_DAYS).filter((docType) => !copy.has(docType)).sort();
    expect(missing).toEqual([]);
  });

  it('both hire licences are in it: each is refused without a keyed date', () => {
    expect(HIRE_SPLIT_DOC_TYPES).toEqual(['hire_car_driver_licence', 'hire_car_vehicle_licence']);
    for (const docType of HIRE_SPLIT_DOC_TYPES) {
      expect(() => resolveApprovalExpiry(docType, undefined, null)).toThrow(expect.objectContaining({ code: 'EXPIRY_REQUIRED' }));
      expect(harnessExpiring()).toContain(docType);
    }
  });

  it('the date it keys is accepted for every type in it (in the future, inside each ceiling)', () => {
    const now = new Date();
    const keyed = new Date(now.getTime() + harnessExpiryDays() * 86_400_000);
    const types = harnessExpiring();
    expect(types.length).toBeGreaterThan(0);
    for (const docType of types) {
      expect(() => resolveApprovalExpiry(docType, keyed, null, now), docType).not.toThrow();
    }
  });
});
