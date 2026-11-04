import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [Owner ruling 24 Oct 2026 ~05:55Z — NO CUSTOMER ID GATE] A taxi ride and an order at or above the
// CountryConfig ID-gate threshold no longer need the customer's ID on file (Swift's own 8 Oct choice,
// not a legal duty). Store builds 11/12 and vc7/vc8 open their "Add your ID" door ONLY on the server's
// 403 ID_VERIFICATION_REQUIRED (no client compares a total with the threshold), so the server is the
// whole switch: this census pins where that code may still come from.
//
// [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (b)] Swift keeps no customer ID at all now: the SWIFT-162 promo gate
// is gone too, and STRIKE_RESTRICTED (its own code, at every level) is lifted by time or by a person, never an ID.
// The threshold itself stays configured (it sizes the store's call-to-confirm flag and the rider guarantee cap):
// it is never set to 0, which would mean "always", not "never".
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('the customer ID gate census (owner 24 Oct 2026)', () => {
  // [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (b) — a DELIBERATE change to this pin] The last site (the SWIFT-162
  // high-value promo gate) is gone with the customer ID: nothing answers ID_VERIFICATION_REQUIRED any more, so no
  // shipped app ever opens its "Add your ID" door from the server.
  it('ID_VERIFICATION_REQUIRED is thrown nowhere', () => {
    const sites = sourceFiles(SRC).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      const count = text.split("'ID_VERIFICATION_REQUIRED'").length - 1;
      return count > 0 ? [{ file: relative(SRC, file), count }] : [];
    });
    expect(sites).toEqual([]);
    expect(read('modules/order/order.service.ts')).not.toMatch(/This promo needs your ID on file/);
  });

  it('checkout never refuses an order for its size: no total is compared with the threshold for an L1 account', () => {
    const order = read('modules/order/order.service.ts');
    expect(order).not.toMatch(/trustLevel === 'L1' && grandTotal/);
    expect(order).not.toMatch(/need your ID on file\. Add it once in the app to lift this limit/);
  });

  it('no ride path has an ID gate: the L2 gate is gone from the request core and the queue join', () => {
    const service = read('modules/rides/rides.service.ts');
    const routes = read('modules/rides/rides.routes.ts');
    for (const text of [service, routes]) {
      expect(text).not.toMatch(/assertL2\b/);
      expect(text).not.toMatch(/first_ride_l2/);
      expect(text).not.toMatch(/trustLevel === 'L1'/);
    }
  });

  it('the threshold stays configured (never 0): it still sizes the promo gate, the call-to-confirm flag and the rider guarantee', () => {
    const config = read('modules/ops/platform-config.ts');
    const values = [...config.matchAll(/idGateThresholdUsd: ([\d.]+),/g)].map((m) => Number(m[1]));
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).toBeGreaterThan(0);
    expect(read('modules/order/order.service.ts')).toMatch(/const highValue = grandTotal >= gateLocal \* 0\.5;/);
    expect(read('modules/cash/cash-rules.service.ts')).toMatch(/if \(amount >= gateLocal\) \{/);
  });
});
