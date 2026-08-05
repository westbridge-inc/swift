import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// TOLLGATE LAW M-0 — the money firewall. Swift collects its OWN weekly fee
// and nothing else: customer→vendor order money never flows through any
// account Swift controls. The collection providers (MMG merchant rail, card
// tokenization) therefore may never be imported by the modules that handle
// order money — an import there is the first step of the mistake that turns
// a software vendor into an unlicensed money transmitter.
//
// Source-scan guard in the operate-gate-unification idiom: the law is a test,
// so drift is a CI failure, not a code review hope. Fee-side modules
// (billing, and the role routes that construct BillingService) are the only
// legitimate consumers.
// ---------------------------------------------------------------------------

const MODULES_DIR = join(__dirname, '..', 'modules');

/** The order-money surface: anything that touches what customers pay vendors,
 *  riders and drivers — where the firewall must hold absolutely. */
const ORDER_MONEY_MODULES = [
  'order', 'dispatch', 'cash', 'courier', 'rides', 'fulfillment', 'handover', 'booking', 'cart',
];

const FORBIDDEN_IMPORT = /from\s+['"][^'"]*providers\/(mmg|payment)\//;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // module dir doesn't exist — nothing to scan
  }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('LAW M-0 — the money firewall', () => {
  it('no order-money module imports the fee-collection providers', () => {
    const offenders: string[] = [];
    for (const mod of ORDER_MONEY_MODULES) {
      for (const file of tsFilesUnder(join(MODULES_DIR, mod))) {
        if (FORBIDDEN_IMPORT.test(readFileSync(file, 'utf8'))) offenders.push(file.slice(MODULES_DIR.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
