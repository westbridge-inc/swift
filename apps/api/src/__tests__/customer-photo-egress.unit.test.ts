import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [Owner ruling 16 Oct 2026 — CUSTOMERS TAKE NO PHOTOS] A customer is never asked for a photo, and
// a photo an account still holds from before the ruling is never served to a mover or a store:
// the Privacy Policy says a mover or business is never shown your last name or a photo of you.
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

// ---------------------------------------------------------------------------
// [COORD ruling 17 Oct · data minimisation] A business or mover handling an order sees the customer's
// FIRST name and, where they must call (masked calling is not available yet), the customer's phone —
// never the last name. The Privacy Policy says exactly that. Served reads are the route modules; the
// staff console (admin) and the customer's own routes are out of scope.
// ---------------------------------------------------------------------------
const SERVED = files().filter((f) => f.endsWith('.routes.ts') && !/[\\/]admin[\\/]|[\\/]customer\.routes\.ts$/.test(f));
function files(): string[] { return sources(MODULES); }
const customerSelects = (f: string) => [...readFileSync(f, 'utf8').matchAll(CUSTOMER_SELECT)].map((m) => m[1]!);
const short = (f: string) => f.slice(MODULES.length + 1);

describe('[first name and phone only] no mover- or store-facing read selects a customer last name', () => {
  it('the census sees the served reads (driver, rider and store)', () => {
    const seen = SERVED.filter((f) => /(driver|rider|vendor)\.routes\.ts$/.test(f)).flatMap(customerSelects);
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });

  it('no served customer select carries lastName', () => {
    const offenders = SERVED.flatMap((f) => customerSelects(f).filter((s) => /\blastName\b/.test(s)).map(() => short(f)));
    expect(offenders).toEqual([]);
  });

  it('the customer phone is served only to the three screens that call: the driver ride, the rider job and the store order', () => {
    const withPhone = SERVED.flatMap((f) => customerSelects(f).filter((s) => /\bphone\b/.test(s)).map(() => short(f).replace(/\\/g, '/')));
    expect(withPhone.sort()).toEqual(['driver/driver.routes.ts', 'rider/rider.routes.ts', 'vendor/vendor.routes.ts']);
  });

  it('a store cannot search its orders by a customer last name it is no longer shown', () => {
    const vendor = SERVED.find((f) => /vendor\.routes\.ts$/.test(f))!;
    expect(readFileSync(vendor, 'utf8')).not.toMatch(/customer:\s*\{\s*lastName:/);
  });
});
