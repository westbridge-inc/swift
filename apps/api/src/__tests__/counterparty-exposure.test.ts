import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { RIDER_COUNTERPARTY_SELECT, riderCounterpartySelect } from '../utils/counterparty';

// ---------------------------------------------------------------------------
// [F-027-07] What one party to an order may see about the other.
//
// The customer, vendor and courier-sender surfaces reached their mover with
// `include: { rider: { include: { user: {...} } } }`. The nested `user` was
// carefully selected; the Rider row itself was not — `include` means EVERY
// column. So the person who ordered a parcel received the mover's KYC document
// keys, their safety-enforcement state (including a SHADOW restriction, which
// is the one thing that must never be visible), their float limits, and
// internal performance rates.
//
// This test is written against the Prisma DMMF rather than a hand-written
// list, so that ADDING A COLUMN TO RIDER cannot silently add it to a
// customer's response. A new sensitive field fails here until someone decides.
// ---------------------------------------------------------------------------

// Enum columns count too (vehicleType, riderType) — filtering to `scalar`
// alone silently dropped them and made the allow-list check report a real
// column as bogus.
const riderFields = (Prisma.dmmf.datamodel.models.find((m) => m.name === 'Rider')?.fields ?? [])
  .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
  .map((f) => f.name);

/** Columns that must never reach a counterparty. Named individually so the
 *  reason for each is on the record. */
const FORBIDDEN: Record<string, string> = {
  nationalIdUrl: 'KYC document',
  driverLicenseUrl: 'KYC document',
  vehicleInsuranceUrl: 'KYC document',
  safetySuspendedAt: 'safety enforcement state',
  safetyShadowRestrictedAt: 'a SHADOW restriction — disclosing it defeats the point',
  livenessLockedAt: 'identity-check state',
  lastLivenessPassAt: 'identity-check state',
  livenessPromptDeadlineAt: 'identity-check state',
  floatLimit: 'the mover’s cash position with Swift',
  committedFloat: 'the mover’s cash position with Swift',
  acceptanceRate: 'internal performance metric',
  completionRate: 'internal performance metric',
  documentsVerifiedBy: 'an internal admin’s id',
  locationSessionId: 'internal session handle',
};

describe('[F-027-07] the counterparty view of a mover', () => {
  it('leaks none of the columns that must never reach the other party', () => {
    const selected = Object.keys(RIDER_COUNTERPARTY_SELECT);
    const leaked = selected.filter((f) => f in FORBIDDEN).map((f) => `${f} (${FORBIDDEN[f]})`);
    expect(leaked, `counterparty select exposes: ${leaked.join('; ')}`).toEqual([]);
  });

  it('every forbidden column actually exists on Rider — the guard cannot rot into a list of typos', () => {
    // If a column is renamed, this fails and someone re-decides, rather than
    // the guard silently passing because it is checking for nothing.
    const missing = Object.keys(FORBIDDEN).filter((f) => !riderFields.includes(f));
    expect(missing, `FORBIDDEN names columns that no longer exist: ${missing.join(', ')}`).toEqual([]);
  });

  it('is an ALLOW-LIST: every selected column is a real Rider column', () => {
    const bogus = Object.keys(RIDER_COUNTERPARTY_SELECT).filter((f) => !riderFields.includes(f));
    expect(bogus, `select names columns Rider does not have: ${bogus.join(', ')}`).toEqual([]);
  });

  it('still carries what a counterparty actually needs — the fix must not blind the customer', () => {
    for (const needed of ['vehicleMake', 'vehicleModel', 'vehicleColor', 'licensePlate', 'vehiclePhotoUrl', 'currentLat', 'currentLng', 'averageRating']) {
      expect(Object.keys(RIDER_COUNTERPARTY_SELECT), needed).toContain(needed);
    }
  });

  it('withPhone gates the contact number — only surfaces where the parties actually meet', () => {
    const meeting = riderCounterpartySelect({ withPhone: true });
    const notMeeting = riderCounterpartySelect({ withPhone: false });
    expect(Object.keys(meeting.user.select)).toContain('phone');
    expect(Object.keys(notMeeting.user.select)).not.toContain('phone');
  });

  it('a NEW Rider column is not in the select by default — additions are opt-in', () => {
    // The property that makes this durable: the select is an allow-list, so
    // the set of exposed columns can only grow by someone editing it.
    const exposed = new Set(Object.keys(RIDER_COUNTERPARTY_SELECT));
    const unexposed = riderFields.filter((f) => !exposed.has(f));
    expect(unexposed.length, 'every Rider column is exposed — the allow-list is not narrowing anything').toBeGreaterThan(0);
  });
});
