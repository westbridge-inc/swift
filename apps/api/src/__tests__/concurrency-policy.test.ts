import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  capacityPredicateSql,
  capacityWhere,
  currentLegColumn,
  moverCapacity,
} from '../modules/dispatch/concurrency-policy';

// ---------------------------------------------------------------------------
// [B1] The concurrency seam changes NOTHING today. That is the claim under
// test, and it is the only reason it is safe to ship before the behaviour.
//
// The seam exists because "one leg at a time" is currently encoded in several
// places, in two languages, and a future change to that number has to move all
// of them together or it silently does nothing.
//
// SWIFT_BUILD_NOW.md names THREE gates. The tree has FOUR — the fourth is the
// atomic accept CAS, which refuses the second job with a 409 DRIVER_BUSY. A
// capacity raised through the spec's three would have produced a rider who is
// offered a second order and then told "You already have an active ride" when
// they accept it. The census test at the bottom is what keeps a fifth from
// appearing the same way.
// ---------------------------------------------------------------------------

const SERVICE = path.join(__dirname, '..', 'modules', 'dispatch', 'dispatch.service.ts');

/** Comments are prose. A gate that matches its own explanation passes while the
 *  code it grades is gone. */
function stripComments(src: string): string {
  const out = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (out.trim().length === 0) throw new Error('stripComments returned empty — the stripper is broken, not the source');
  return out;
}

describe('the concurrency seam is a no-op at capacity 1 [B1]', () => {
  it('capacity is 1 for both pools — nothing is stacked yet', () => {
    expect(moverCapacity('RIDER')).toBe(1);
    expect(moverCapacity('DRIVER')).toBe(1);
  });

  it('a driver leg is a ride and a rider leg is an order — not interchangeable', () => {
    expect(currentLegColumn('DRIVER')).toBe('currentRideId');
    expect(currentLegColumn('RIDER')).toBe('currentOrderId');
  });

  it('renders the EXACT candidate predicate the queries carried before the seam', () => {
    // Byte-for-byte against the literal that was in dispatch.service.ts. If the
    // rendered text differs, the candidate set can differ, and every dispatch
    // decision replayed through it is no longer guaranteed identical.
    expect(capacityPredicateSql('DRIVER').sql.trim()).toBe('AND d."currentRideId" IS NULL');
    expect(capacityPredicateSql('RIDER').sql.trim()).toBe('AND r."currentOrderId" IS NULL');
  });

  it('carries no bound parameters — the fragment is pure identifier text', () => {
    // A stray placeholder here would shift every LATER parameter's position in
    // the composed query, which is the kind of break that shows up as wrong
    // rows rather than an error.
    expect(capacityPredicateSql('DRIVER').values).toEqual([]);
    expect(capacityPredicateSql('RIDER').values).toEqual([]);
  });

  it('builds no identifier at runtime — sql-safety-surface forbids Prisma.raw with no allowlist', () => {
    // CI rejected the first version of this module for composing the column
    // and alias with `Prisma.raw`. The gate is right: a raw fragment is an
    // injection vector even when today's inputs are a closed set, because
    // "safe because of how it is called" is a property call sites can change.
    // Asserted here too, so the composed form cannot come back as a tidy-up
    // and only be caught seven minutes into CI.
    const source = readFileSync(path.join(__dirname, '..', 'modules', 'dispatch', 'concurrency-policy.ts'), 'utf8');
    expect(stripComments(source)).not.toContain('Prisma.raw');
  });

  it('renders the EXACT offer-gate and accept-CAS where-clause', () => {
    expect(capacityWhere('DRIVER')).toEqual({ currentRideId: null });
    expect(capacityWhere('RIDER')).toEqual({ currentOrderId: null });
  });

  it('refuses to render a capacity it cannot implement, instead of silently meaning 1', () => {
    // The failure this module exists to prevent is a raised number that looks
    // applied and behaves exactly as before. Proven by construction: the guard
    // is the `capacity <= 1` branch, and above it the function throws rather
    // than falling through to the null check.
    const source = readFileSync(path.join(__dirname, '..', 'modules', 'dispatch', 'concurrency-policy.ts'), 'utf8');
    const stripped = stripComments(source);
    expect(stripped).toContain('capacity <= 1');
    expect((stripped.match(/throw new Error\(/g) ?? []).length).toBe(2);
  });
});

describe('every capacity gate goes through the seam — no fifth one appears quietly', () => {
  it('dispatch.service.ts holds no hand-written live-leg gate outside the policy module', () => {
    const src = stripComments(readFileSync(SERVICE, 'utf8'));

    // A gate is a READ that asks "is this mover free". Writes that SET the
    // pointer (`data: { currentRideId: null }`) are how a leg ends and are not
    // capacity questions — they are matched separately and allowed.
    const gateShapes = [
      /currentRideId:\s*null\s*,/g,
      /currentOrderId:\s*null\s*,/g,
      /"currentRideId"\s+IS\s+NULL/g,
      /"currentOrderId"\s+IS\s+NULL/g,
    ];
    const writeShapes = /data:\s*\{[^}]*current(Ride|Order)Id:\s*null/g;
    const writes = (src.match(writeShapes) ?? []).length;

    const found = gateShapes.reduce((n, re) => n + (src.match(re) ?? []).length, 0);

    // Every remaining bare occurrence must be a write. Any surplus is a gate
    // that bypasses moverCapacity() — exactly how the accept CAS came to be a
    // fourth gate the spec never mentioned.
    expect(
      found - writes,
      'a live-leg gate in dispatch.service.ts is not routed through concurrency-policy — '
      + 'raising moverCapacity() would leave it enforcing 1 and the feature would fail on it',
    ).toBe(0);
  });

  it('all four known gates call the seam', () => {
    const src = stripComments(readFileSync(SERVICE, 'utf8'));
    // 2 SQL candidate predicates + 4 where-clause uses (offer gate ×2, accept CAS ×2).
    expect((src.match(/capacityPredicateSql\(/g) ?? []).length).toBe(2);
    expect((src.match(/capacityWhere\(/g) ?? []).length).toBe(4);
  });
});
