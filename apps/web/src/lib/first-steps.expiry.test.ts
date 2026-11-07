import { describe, expect, it } from 'vitest';
import { moverNextStep } from './first-steps';

// [REVIEW-LIGHT2 #2309 G S3] An approved document whose date has passed is out of date the moment it lapses, before the
// daily sweep marks it EXPIRED (or if the sweep holds the row): the mover has it to send again, never "in review".
describe('[#2309] an approved document past its date counts as to send', () => {
  const now = new Date('2026-11-02T12:00:00.000Z');
  const doc = (docType: string, status: string, expiresAt: string | null) => ({ docType, status, expiresAt });
  it('approved, expired yesterday: to send', () => {
    expect(moverNextStep({ checklist: ['drivers_licence'], documents: [doc('drivers_licence', 'APPROVED', '2026-11-01T00:00:00.000Z')], roleVerified: false }, now)).toEqual({ kind: 'send', count: 1 });
  });
  it('approved, still current: not to send', () => {
    expect(moverNextStep({ checklist: ['drivers_licence', 'vehicle_insurance'], documents: [doc('drivers_licence', 'APPROVED', '2027-11-01T00:00:00.000Z'), doc('vehicle_insurance', 'PENDING', null)], roleVerified: false }, now)).toEqual({ kind: 'review' });
  });
  it('approved with no date (a document that does not expire): not to send', () => {
    expect(moverNextStep({ checklist: ['national_id'], documents: [doc('national_id', 'APPROVED', null)], roleVerified: false }, now)?.kind).not.toBe('send');
  });
});
