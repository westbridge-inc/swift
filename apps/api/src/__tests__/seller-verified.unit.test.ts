import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sellerVerifiedNow, type SellerVerifiedFacts } from '../modules/vendor/seller-verified';

// [P35 · board 4b · GUARDRAILS §4/§8 · REVIEW-G S4-1 · REVIEW-F S2-1 on #2112] "Verified seller" = a person approved
// every document of a REAL store and they are current. And the two places fiction comes from carry the markers the
// rule reads: the store-review content pack (Vendor.isSynthetic) and the dev demo seed (its one store owner is
// syntheticRunId 'seed-demo', and every demo store belongs to that owner).

const NOW = new Date('2026-10-25T22:00:00Z');
const real = (over: Partial<SellerVerifiedFacts> = {}): SellerVerifiedFacts => ({
  isVerified: true, activationValidUntil: new Date('2026-11-25T00:00:00Z'), isSynthetic: false,
  owner: { user: { isSynthetic: false, syntheticRunId: null } }, ...over,
});

describe('sellerVerifiedNow', () => {
  it('true only for a verified, current, real store', () => {
    expect(sellerVerifiedNow(real(), NOW)).toBe(true);
    expect(sellerVerifiedNow(real({ activationValidUntil: null }), NOW)).toBe(true);
    expect(sellerVerifiedNow(real({ isVerified: false }), NOW)).toBe(false);
    expect(sellerVerifiedNow(real({ activationValidUntil: new Date(NOW.getTime() - 60_000) }), NOW)).toBe(false);
    expect(sellerVerifiedNow(real({ activationValidUntil: NOW }), NOW)).toBe(false);
  });

  it('never for fiction: a synthetic store, a synthetic owner, or an owner from a synthetic run', () => {
    expect(sellerVerifiedNow(real({ isSynthetic: true }), NOW)).toBe(false);
    expect(sellerVerifiedNow(real({ owner: { user: { isSynthetic: true, syntheticRunId: null } } }), NOW)).toBe(false);
    expect(sellerVerifiedNow(real({ owner: { user: { isSynthetic: false, syntheticRunId: 'seed-demo' } } }), NOW)).toBe(false);
  });
});

describe('the fiction sources carry the markers', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

  it('every store the review content pack creates is isSynthetic', () => {
    const pack = read('src/modules/review/content-pack.ts');
    const creates = pack.match(/vendor\.(?:upsert|create)\([\s\S]*?\}\s*\)/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const call of creates) expect(call).toMatch(/isSynthetic: true/);
  });

  it('every demo-seed store belongs to the one demo owner, and that owner is a seed-demo synthetic run', () => {
    const seed = read('prisma/seed.ts');
    const owners = [...seed.matchAll(/ownerId: ([\w.]+),/g)].map((m) => m[1]);
    expect(owners.length).toBeGreaterThan(0);
    expect(new Set(owners)).toEqual(new Set(['owner.id']));
    expect(seed).toMatch(/const owner = await prisma\.vendorOwner\.findUnique\(\{ where: \{ userId: vendorUser\.id \} \}\)/);
    const vendorUser = seed.slice(seed.indexOf('const vendorUser = await prisma.user.upsert'), seed.indexOf('// Create vendor'));
    expect(vendorUser).toMatch(/syntheticRunId: 'seed-demo'/);
    expect(vendorUser).toMatch(/vendorOwner: \{ create: \{\} \}/);
  });
});
