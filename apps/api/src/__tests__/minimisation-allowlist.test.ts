import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPTURE_ALLOWLISTS } from '../modules/compliance/capture-allowlists';

// [DCR-1 NR5-01] Minimisation at capture. The registry pin makes "add a
// personal field" a REVIEWED act: any change to the allowlists (or to the
// two ingress rulings enforced below) fails this spec until the same commit
// updates it — so the diff always shows the field AND its declaration.
describe('capture allowlists [DCR-1 NR5-01]', () => {
  it('the registry is pinned — changing captured personal fields requires a same-commit edit HERE', () => {
    const canonical = JSON.stringify(
      Object.fromEntries(
        Object.entries(CAPTURE_ALLOWLISTS).map(([k, v]) => [k, [...v].sort()]),
      ),
    );
    const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    // Pinned 2026-08-19 from the nr5-allowlists ingress census. If this fails,
    // you changed what Swift captures: update the registry, THEN this pin,
    // and cite the purpose in the commit message.
    expect(hash).toBe('f244ad6ad4819d5c');
    // Structural minimums that must never silently shrink:
    expect(CAPTURE_ALLOWLISTS.customer.length).toBeGreaterThan(10);
    expect(CAPTURE_ALLOWLISTS.third_party).toContain('courier.recipientPhone');
  });

  it('[census ruling] the purpose-free cart-wide instructions ingress stays REMOVED', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/modules/user/customer.routes.ts'), 'utf8',
    );
    expect(src).not.toMatch(/app\.(put|post)\('\/cart\/instructions'/);
    expect(src).not.toContain('cartInstructionsSchema');
  });

  it('[census ruling] the refresh-token credential is bounded at ingress', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/modules/auth/auth.routes.ts'), 'utf8',
    );
    const m = src.match(/const refreshSchema[\s\S]{0,220}/);
    expect(m?.[0]).toMatch(/refreshToken: z\.string\(\)\.min\(1\)\.max\(512\)/);
  });
});
