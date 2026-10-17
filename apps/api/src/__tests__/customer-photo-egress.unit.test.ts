import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [Owner ruling 16 Oct 2026 — CUSTOMERS TAKE NO PHOTOS] A customer is never asked for a photo, and
// a photo an account still holds from before the ruling is never served to a mover or a store:
// the Privacy Policy says a mover or business is never shown a photo of a customer.
// Partner photos (the mover's own, shown to the customer) are unchanged.
//
// The mover- and store-facing reads select the order's customer with an explicit field list. This
// census reads every route module and refuses a customer select that carries `avatar`. (The chat
// egress is graded by behaviour in chat-authority.test.ts.)
// ---------------------------------------------------------------------------

const MODULES = join(__dirname, '..', 'modules');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/** `customer: { select: { … } }` — the order relation a mover or store reads the customer through. */
const CUSTOMER_SELECT = /\bcustomer:\s*\{\s*select:\s*\{([^}]*)\}/g;

describe('[customers take no photos] no mover- or store-facing read selects a customer photo', () => {
  const files = sources(MODULES);

  it('the census sees the reads it guards (driver rides and the store order board)', () => {
    const seen = files.filter((f) => /driver\.routes\.ts$|vendor\.routes\.ts$/.test(f))
      .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(CUSTOMER_SELECT)]);
    expect(seen.length).toBeGreaterThanOrEqual(4);
  });

  it('no customer select anywhere in the route modules carries avatar', () => {
    const offenders = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(CUSTOMER_SELECT)]
      .filter((m) => /\bavatar\b/.test(m[1]!))
      .map((m) => `${f.slice(MODULES.length + 1)}: ${m[0].replace(/\s+/g, ' ').slice(0, 120)}`));
    expect(offenders).toEqual([]);
  });
});
