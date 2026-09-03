import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  VISIBLE_VENDOR,
  VISIBLE_VENDOR_SELECT,
  isVendorVisible,
} from '../modules/vendor/vendor-visibility';

/**
 * [B2] The sixth copy of the vendor-visibility predicate.
 *
 * #801 collapsed five hand-rolled copies in the search module into one shared
 * predicate, and `vendor-visibility.ts` says plainly: "Import from here or
 * don't touch visibility." The INCREMENTAL sync — `syncVendor` and
 * `syncVendorItems`, the path that runs in normal operation every time a
 * catalogue write lands — kept testing `status === 'ACTIVE'` alone.
 *
 * That mattered because `searchVendors`/`searchItems` filter on SURFACE
 * attributes (type, cuisine, open-now, price) and trust the index for
 * visibility. So a vendor whose papers were never approved, or whose OPERATOR
 * had been switched off, was written into the index by the incremental path and
 * then served. `syncAllVendors` has always used the shared predicate, so a full
 * re-index removed them — and the next incremental sync put them back.
 *
 * These tests guard the predicate's meaning, the two forms agreeing, and the
 * sync doors still using it.
 */

const service = readFileSync(join(process.cwd(), 'src/modules/search/search.service.ts'), 'utf8');

/**
 * The module with its comments stripped.
 *
 * The standing hazard-matching rule: match declarations, not prose. The
 * banned-pattern assertion below looks for `vendor.status === 'ACTIVE'`, and
 * the comments explaining the fix necessarily QUOTE that string — so scanning
 * the raw file fails on its own documentation, which is how the drift09 gate
 * bit itself the first time round. Code lines only.
 */
const serviceCode = service
  .split('\n')
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

const VISIBLE = { status: 'ACTIVE', isVerified: true, tenant: { isActive: true } };

describe('isVendorVisible — what "visible" means, in one place', () => {
  it('admits a store that is active, verified, and whose operator is live', () => {
    expect(isVendorVisible(VISIBLE)).toBe(true);
  });

  it('refuses a store whose papers were never approved', () => {
    expect(isVendorVisible({ ...VISIBLE, isVerified: false })).toBe(false);
  });

  it('refuses a suspended store', () => {
    expect(isVendorVisible({ ...VISIBLE, status: 'SUSPENDED' })).toBe(false);
    expect(isVendorVisible({ ...VISIBLE, status: 'PENDING_APPROVAL' })).toBe(false);
  });

  it('refuses a store whose OPERATOR has been switched off', () => {
    // The clause that is load-bearing for guests: a guest request carries no
    // tenant context, so the Prisma extension leaves it unscoped and this
    // relational check is the only wall.
    expect(isVendorVisible({ ...VISIBLE, tenant: { isActive: false } })).toBe(false);
  });

  it('FAILS CLOSED when the tenant was not selected at all', () => {
    // A caller that forgets the include must get "not visible", never a
    // silently permissive answer — otherwise the missing clause is invisible
    // at the call site, which is exactly how this defect happened.
    expect(isVendorVisible({ ...VISIBLE, tenant: null })).toBe(false);
    expect(isVendorVisible({ status: 'ACTIVE', isVerified: true })).toBe(false);
  });
});

describe('the two forms of the predicate cannot disagree', () => {
  it('the in-memory check reads its values from the DB predicate', () => {
    // Not repeated literals: `isVendorVisible` compares against
    // VISIBLE_VENDOR's own fields, so the two can never disagree about WHAT
    // each clause requires.
    const src = readFileSync(join(process.cwd(), 'src/modules/vendor/vendor-visibility.ts'), 'utf8');
    expect(src).toMatch(/vendor\.status === VISIBLE_VENDOR\.status/);
    expect(src).toMatch(/vendor\.isVerified === VISIBLE_VENDOR\.isVerified/);
    expect(src).toMatch(/vendor\.tenant\?\.isActive === VISIBLE_VENDOR\.tenant\.isActive/);
  });

  it('constrains exactly the same set of fields', () => {
    // The remaining way they could drift is SHAPE: a clause added to the DB
    // predicate and not to the in-memory one. This fails when that happens.
    const dbKeys = Object.keys(VISIBLE_VENDOR).sort();
    const selectKeys = Object.keys(VISIBLE_VENDOR_SELECT).sort();
    expect(selectKeys).toEqual(dbKeys);
  });

  it('the select carries everything the check needs to decide', () => {
    // A caller spreading VISIBLE_VENDOR_SELECT must end up with a row the
    // check can actually evaluate — nested tenant included.
    expect(VISIBLE_VENDOR_SELECT.tenant).toEqual({ select: { isActive: true } });
    expect(VISIBLE_VENDOR_SELECT.status).toBe(true);
    expect(VISIBLE_VENDOR_SELECT.isVerified).toBe(true);
  });
});

describe('the sync doors use the shared predicate', () => {
  it('has no bare status-only liveness test left in the module', () => {
    // The defect in one line. Any return of this shape is the bug coming back.
    expect(serviceCode).not.toMatch(/vendor\.status === 'ACTIVE'/);
    expect(serviceCode).not.toMatch(/i\.vendor\.status === 'ACTIVE'/);
    // And prove the guard is looking at something: the comments DO quote the
    // old form, so a stripper that returned an empty string would pass.
    expect(serviceCode).toContain('async syncVendor(');
    expect(service).toMatch(/vendor\.status === 'ACTIVE'/); // still in the prose
  });

  it('decides the per-vendor sync with isVendorVisible', () => {
    expect(service).toMatch(/if \(isVendorVisible\(vendor\)\)/);
  });

  it('decides the per-item sync with isVendorVisible', () => {
    expect(service).toMatch(/isVendorVisible\(i\.vendor\)/);
  });

  it('selects the tenant on both sync paths, or the check cannot decide', () => {
    // Fail-closed means a forgotten include silently de-indexes everything.
    // These assert the include is actually there, so the failure mode is
    // caught here rather than as an empty search index in production.
    expect(service).toMatch(/tenant: \{ select: \{ isActive: true \} \}/);
    expect(service).toMatch(/VISIBLE_VENDOR_SELECT/);
  });

  it('removes the document for a vendor that no longer exists', () => {
    // The old early return left a deleted vendor's doc in the index until
    // somebody happened to run a full re-index.
    const fn = service.slice(service.indexOf('async syncVendor('), service.indexOf('async syncVendorItems('));
    // [R048-003] the vanished vendor's tenant is unknown by then, so the removal is by ENTITY id (a filter), not a guessed document id
    expect(fn).toMatch(/if \(!vendor\) \{[\s\S]*deleteDocuments\(\{ filter: renderClause\(\{ attribute: 'entityId', op: '=', value: vendorId \}\) \}\)/);
  });

  it('keeps the full re-index on the shared DB predicate too', () => {
    // The one path that was already right stays right.
    expect(service).toMatch(/where: VISIBLE_VENDOR,/);
    expect(service).toMatch(/vendor: VISIBLE_VENDOR_REL/);
  });
});
