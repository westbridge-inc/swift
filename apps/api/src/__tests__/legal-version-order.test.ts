import { describe, it, expect } from 'vitest';
import type { UserRole } from '@prisma/client';
import { LEGAL_VERSION } from '../modules/legal/legal.routes';
import * as reaccept from '../modules/legal/reaccept';

// ---------------------------------------------------------------------------
// [REVIEW-G S4 on #2001] A legal version is 'YYYY-MM-DD', or 'YYYY-MM-DD.N' for
// a later bump the same day. The fresh-tick rule (R26) compared them as plain
// strings, so a tenth same-day bump ('…-25.10') sorted BEFORE the ninth
// ('…-25.9'): a person who accepted '.9' would not be asked to accept a
// material '.10', and a material '.10' would not count as served once '.9'
// was. Now the day compares as a date and the suffix as a number. A stored
// version of any other shape counts as older than every real one (that person
// is asked again: the safe direction). Today's answers are unchanged.
// ---------------------------------------------------------------------------

const { acceptanceStatus, materialVersion, MATERIAL_CHANGES, NON_MATERIAL_CHANGES } = reaccept;
const compare = (reaccept as { compareLegalVersions?: (a: string, b: string) => number }).compareLegalVersions;
const CUSTOMER = ['CUSTOMER'] as UserRole[];
// Same-day bumps past nine: '.9' then a material '.10'.
const LATER = [
  { version: '2026-10-25.9', summary: ['nine'] },
  { version: '2026-10-25.10', summary: ['ten'] },
] as const;

describe('[REVIEW-G S4 on #2001] legal versions are ordered by day, then by the bump number', () => {
  it('the tenth bump of a day comes after the ninth; a plain day comes before its bumps', () => {
    expect(compare).toBeTypeOf('function');
    const ordered = ['2026-08-15', '2026-08-15.2', '2026-10-22', '2026-10-22.1', '2026-10-25.2', '2026-10-25.9', '2026-10-25.10', '2026-10-25.11', '2026-10-26'];
    expect([...ordered].reverse().sort(compare)).toEqual(ordered);
    expect(compare!('2026-10-25.10', '2026-10-25.9')).toBeGreaterThan(0);
    expect(compare!('2026-10-25.10', '2026-10-25.10')).toBe(0);
  });

  it('a material tenth bump is served once it is the current version, and asks someone who accepted the ninth', () => {
    expect(materialVersion('2026-10-25.10', LATER)).toBe('2026-10-25.10');
    expect(materialVersion('2026-10-25.9', LATER)).toBe('2026-10-25.9');
    const asked = acceptanceStatus({ tosVersion: '2026-10-25.9', roles: CUSTOMER }, '2026-10-25.10', LATER);
    expect(asked).toMatchObject({ needsAcceptance: true, summary: ['ten'] });
    expect(acceptanceStatus({ tosVersion: '2026-10-25.10', roles: CUSTOMER }, '2026-10-25.10', LATER)).toMatchObject({ needsAcceptance: false, summary: [] });
    expect(acceptanceStatus({ tosVersion: '2026-10-25.2', roles: CUSTOMER }, '2026-10-25.10', LATER)).toMatchObject({ needsAcceptance: true, summary: ['nine', 'ten'] });
  });

  it('a stored version of another shape is older than every real one: that person is asked again', () => {
    for (const odd of ['1.0', 'v2', '', '2026-10-25.x', '2026-13-01.1.2']) {
      expect(compare!(odd, '2026-07-15'), odd).toBeLessThan(0);
      expect(acceptanceStatus({ tosVersion: odd, roles: CUSTOMER }, LEGAL_VERSION).needsAcceptance, odd).toBe(true);
    }
  });

  it('every served and listed version has the real shape, and the material list runs oldest to newest', () => {
    const shape = /^\d{4}-\d{2}-\d{2}(?:\.[1-9]\d{0,3})?$/;
    for (const v of [LEGAL_VERSION, ...MATERIAL_CHANGES.map((c) => c.version), ...NON_MATERIAL_CHANGES.map((c) => c.version)]) expect(v).toMatch(shape);
    const versions = MATERIAL_CHANGES.map((c) => c.version);
    expect([...versions].sort(compare)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
