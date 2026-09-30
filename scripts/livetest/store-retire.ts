import { FICTIONAL_GY } from './guard.js';

// [DS258, DS265 F1] Which ACTIVE stores the heal sweep may retire. Pure, so the
// rule is tested directly (apps/api/src/__tests__/livetest-store-retire.test.ts).
// [DS258] The stores the journeys mint for themselves are named `TEST-<slot>`
// by freshVendor (journeys/vendor.ts); its call sites use the slots 'vend01'
// (VEND-01) and 'admin01' (ADMIN-01). A journey retires its own store in a
// finally (ADMIN-01's store never reaches ACTIVE, so it needs none), but an
// interrupted run can leave one ACTIVE. Heal retires those leftovers only when
// ALL of these hold [DS265 F1]: the exact journey store name, an owner whose
// phone is a fictional +5920 number (guard.ts FICTIONAL_GY: never a real
// subscriber, so never a real merchant), and the journey owner first name
// "TEST-<slot>". The seeded roster stores are allowlisted besides, so no match
// can ever retire them: they are other journeys' fixtures and the owner's
// manual test targets.
export const FRESH_STORE_NAMES = new Set(['TEST-vend01', 'TEST-admin01']);
export const NEVER_RETIRE_STORE_NAMES = new Set([
  'TEST-Kitchen-One', 'TEST-Kitchen-Two', 'TEST-Kitchen-Three',
  'TEST-Grocery-One', 'TEST-Pharma-One', 'TEST-Sparks',
]);

/** A leftover the journeys minted themselves, and nothing else (all four must hold). */
export function isJourneyMintedStore(row: { name?: string; owner?: { user?: { phone?: string; firstName?: string } } }): boolean {
  const name = row.name ?? '';
  const owner = row.owner?.user;
  return FRESH_STORE_NAMES.has(name)
    && !NEVER_RETIRE_STORE_NAMES.has(name)
    && FICTIONAL_GY.test(owner?.phone ?? '')
    && (owner?.firstName ?? '').startsWith('TEST-');
}
