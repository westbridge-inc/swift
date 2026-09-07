/**
 * [DOC-1 §7.2 · self-test C · ruling 2026-09-06] A confident, plausible-looking, WRONG expiry.
 *
 * Two paths can carry an expiry: a processor's read (once DocField rows declare `expiry_date`)
 * and a reviewer's keyboard. Both are judged against the same ceiling — the type's longest
 * validity from today (or from the printed issue date), plus a 30-day tolerance. Past is a
 * blocking FAIL / EXPIRY_IN_PAST; beyond the ceiling is a blocking FAIL / IMPLAUSIBLE_EXPIRY,
 * which means a person keys the date — never a rejection, never an auto-commit.
 */
import { describe, it, expect } from 'vitest';
import { VALIDATOR_IMPLEMENTATIONS, NO_CONTEXT, plausibleExpiryCeiling, startOfToday, parseIsoDate, EXPIRY_TOLERANCE_DAYS } from '../modules/verification/validators';
import { resolveApprovalExpiry, AUTO_APPROVE_EXPIRY_DAYS } from '../modules/verification/verification.service';
import { VALIDATOR_CATALOGUE } from '../modules/verification/doc-registry';

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const DECLARED = [{ fieldCode: 'expiry_date', isRequired: false }, { fieldCode: 'issue_date', isRequired: false }] as never;
const run = (impl: string, fields: Record<string, string>, maxValidityDays: number | null, declared: unknown = DECLARED) =>
  VALIDATOR_IMPLEMENTATIONS[impl]!({ declared: declared as never, present: new Map(Object.entries(fields)), collided: false, context: { ...NO_CONTEXT, maxValidityDays } });

describe('the field validators (live the day fields are declared)', () => {
  const today = startOfToday();
  it('V_NOT_EXPIRED: yesterday fails, today and tomorrow pass, an unreadable date is undeterminable', () => {
    expect(run('validators#V_NOT_EXPIRED', { expiry_date: iso(new Date(today.getTime() - DAY)) }, 365)).toMatchObject({ status: 'FAIL' });
    expect(run('validators#V_NOT_EXPIRED', { expiry_date: iso(today) }, 365)).toMatchObject({ status: 'PASS' });
    expect(run('validators#V_NOT_EXPIRED', { expiry_date: iso(new Date(today.getTime() + DAY)) }, 365)).toMatchObject({ status: 'PASS' });
    expect(run('validators#V_NOT_EXPIRED', { expiry_date: 'next year' }, 365)).toMatchObject({ status: 'SKIP', detailCode: 'UNDETERMINABLE' });
    expect(run('validators#V_NOT_EXPIRED', {}, 365)).toMatchObject({ status: 'SKIP', detailCode: 'UNDETERMINABLE' });
    // A type that declares no expiry field is not judged at all — the verdict is dropped by the ledger.
    expect(run('validators#V_NOT_EXPIRED', {}, 365, [])).toMatchObject({ status: 'SKIP', detailCode: 'NOT_APPLICABLE' });
    expect(run('validators#V_EXPIRY_PLAUSIBLE', {}, 365, [])).toMatchObject({ status: 'SKIP', detailCode: 'NOT_APPLICABLE' });
  });
  it('V_EXPIRY_PLAUSIBLE: within the validity passes; beyond it fails; measured from the printed issue date when read; no known validity cannot judge', () => {
    expect(run('validators#V_EXPIRY_PLAUSIBLE', { expiry_date: iso(new Date(today.getTime() + 300 * DAY)) }, 365)).toMatchObject({ status: 'PASS' });
    expect(run('validators#V_EXPIRY_PLAUSIBLE', { expiry_date: iso(new Date(today.getTime() + (365 + EXPIRY_TOLERANCE_DAYS) * DAY)) }, 365)).toMatchObject({ status: 'PASS' }); // the tolerance edge
    expect(run('validators#V_EXPIRY_PLAUSIBLE', { expiry_date: iso(new Date(today.getTime() + (365 + EXPIRY_TOLERANCE_DAYS + 1) * DAY)) }, 365)).toMatchObject({ status: 'FAIL' });
    expect(run('validators#V_EXPIRY_PLAUSIBLE', { expiry_date: iso(new Date(today.getTime() + 10 * 365 * DAY)) }, 3 * 365)).toMatchObject({ status: 'FAIL' }); // 2036 for a 3-year licence
    const issued = new Date(today.getTime() - 400 * DAY);
    expect(run('validators#V_EXPIRY_PLAUSIBLE', { issue_date: iso(issued), expiry_date: iso(new Date(issued.getTime() + 3 * 365 * DAY)) }, 3 * 365)).toMatchObject({ status: 'PASS' });
    expect(run('validators#V_EXPIRY_PLAUSIBLE', { issue_date: iso(issued), expiry_date: iso(new Date(issued.getTime() + 4 * 365 * DAY)) }, 3 * 365)).toMatchObject({ status: 'FAIL' });
    expect(run('validators#V_EXPIRY_PLAUSIBLE', { expiry_date: iso(new Date(today.getTime() + 300 * DAY)) }, null)).toMatchObject({ status: 'SKIP', detailCode: 'UNDETERMINABLE' });
  });
  it('the catalogue makes both BLOCKING and references these implementations — the ruling on plausibility recorded in the row', () => {
    const rows = Object.fromEntries(VALIDATOR_CATALOGUE.map((r) => [r.code, r]));
    expect(rows['V_NOT_EXPIRED']).toMatchObject({ isBlocking: true, implRef: 'validators#V_NOT_EXPIRED' });
    expect(rows['V_EXPIRY_PLAUSIBLE']).toMatchObject({ isBlocking: true, implRef: 'validators#V_EXPIRY_PLAUSIBLE' });
    expect(parseIsoDate('2026-09-06T10:00:00Z')?.toISOString().slice(0, 10)).toBe('2026-09-06');
    expect(parseIsoDate('06/09/2026')).toBeNull();
  });
});

describe('the manual path — resolveApprovalExpiry', () => {
  const now = new Date();
  it('a reviewer cannot key an expiry beyond the longest validity of the type; a plausible one stands; the past is still refused', () => {
    expect(AUTO_APPROVE_EXPIRY_DAYS['drivers_licence']).toBe(3 * 365);
    const typo = new Date(now.getTime() + 10 * 365 * DAY);
    expect(() => resolveApprovalExpiry('drivers_licence', typo, null, now)).toThrow(expect.objectContaining({ code: 'IMPLAUSIBLE_EXPIRY' }));
    const edge = plausibleExpiryCeiling(startOfToday(now), 3 * 365);
    expect(resolveApprovalExpiry('drivers_licence', edge, null, now)).toEqual(edge);
    expect(() => resolveApprovalExpiry('drivers_licence', new Date(edge.getTime() + DAY), null, now)).toThrow(expect.objectContaining({ code: 'IMPLAUSIBLE_EXPIRY' }));
    expect(() => resolveApprovalExpiry('drivers_licence', new Date(now.getTime() - DAY), null, now)).toThrow(expect.objectContaining({ code: 'EXPIRY_IN_PAST' }));
    expect(resolveApprovalExpiry('drivers_licence', new Date(now.getTime() + 400 * DAY), null, now)!.getTime()).toBe(now.getTime() + 400 * DAY);
  });
  it('a type with no known validity is not judged for plausibility', () => {
    const far = new Date(now.getTime() + 20 * 365 * DAY);
    expect(resolveApprovalExpiry('national_id', far, null, now)).toEqual(far);
  });
});
