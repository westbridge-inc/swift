import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Lifecycle/Billing spec §0.5 + §19 (release gate): Swift is cash-only and all
// card capture is HOSTED (PowerTranz SPI / Stripe SetupIntent) — a raw PAN or
// CVV must NEVER be accepted by a Swift route, in any request body, keeping PCI
// scope minimal. The payment providers already refuse server-side tokenization
// (payment-provider.ts) and pino redacts these fields (logger-config.ts); this
// locks the ROUTE layer so a future handler can't reintroduce a card-number or
// security-code field. Allowed tokenized metadata — token, brand, last4,
// expiryMonth/Year — is fine; only PAN / CVV / PIN primary data is forbidden.

// Word-bounded, `field:`-shaped so it matches a schema/body field declaration
// (e.g. `cardNumber: z.string()`), not incidental substrings (plan, expand, …).
const FORBIDDEN = /\b(cardNumber|card_number|cardNo|ccNumber|pan|cvv|cvc|securityCode|cardVerification|pinBlock)\b\s*:/i;

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) routeFiles(p, acc);
    else if (entry.endsWith('.routes.ts')) acc.push(p);
  }
  return acc;
}

describe('no PAN / CVV field is accepted by any route [PCI · cash-only]', () => {
  it('no *.routes.ts declares a card-number, CVV, or PIN request field', () => {
    const files = routeFiles(join(process.cwd(), 'src/modules'));
    expect(files.length).toBeGreaterThan(10); // guard against a broken glob silently passing
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (FORBIDDEN.test(line)) offenders.push(`${f.split('/src/')[1]}:${i + 1}  ${line.trim()}`);
      });
    }
    // A non-empty list is a PCI-scope breach: a route now accepts raw card data.
    expect(offenders).toEqual([]);
  });
});
