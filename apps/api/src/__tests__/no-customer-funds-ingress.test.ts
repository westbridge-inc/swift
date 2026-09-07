/**
 * [CLAUDE.md hard rule 2 · GRD-1 · TEC-INV-10] SWIFT NEVER HOLDS ORDER MONEY.
 *
 * This claim is load-bearing in three specifications, in the privacy notice, and in the
 * business model itself — Swift is a SaaS on a weekly fee, not a money transmitter. The
 * 2026-09-07 re-audit found it **enforced by nothing**: the promised wallet-word lint and
 * `test_no_customer_funds_ingress` did not exist, so the property held only by the good
 * manners of everyone who had touched the code so far.
 *
 * This file is that test. It reads source, not behaviour, because the property is an
 * ABSENCE — there is no runtime path to exercise, and a missing path cannot be proven by
 * calling it. Each assertion names the exact thing a future change would have to do to
 * start taking customer money, and fails when it appears.
 *
 * What is deliberately NOT forbidden, with the reason:
 *  - The PARTNER fee wallet (`TopUpCommand`, `WALLET_LIABILITY`, subledgered by
 *    `subscriptionId`). That is a vendor/mover prepaying their own SUBSCRIPTION, which is
 *    Swift's own revenue. CLAUDE.md calls it the prepaid balance path for cash vendors.
 *  - Payment providers in `modules/billing` and `providers/payment`. Those charge the
 *    weekly fee. The rule is that ORDER money never reaches them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { LEDGER_ACCOUNTS } from '../modules/billing/ledger';

const SRC = path.join(__dirname, '..');

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') tsFiles(p, out);
      continue;
    }
    if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(SRC, p);
const ALL = tsFiles(SRC);

describe('[hard rule 2] test_no_customer_funds_ingress — order money never enters Swift', () => {
  it('checkout accepts CASH and MOBILE_MONEY only — no card, no bank transfer, no wallet', () => {
    const checkout = readFileSync(path.join(SRC, 'modules/user/customer.routes.ts'), 'utf8');
    const m = /const validMethods = \[([^\]]*)\]/.exec(checkout);
    expect(m, 'the checkout payment allowlist moved or was renamed — re-point this test').not.toBeNull();
    const methods = m![1]!.split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean).sort();
    expect(methods).toEqual(['CASH', 'MOBILE_MONEY']);
  });

  it('no payment provider is reachable from the order, cash or checkout modules', () => {
    // MOBILE_MONEY goes to the VENDOR's own pay link. A gateway import in these modules
    // would mean Swift initiating a charge for an order — the exact thing rule 2 forbids.
    const orderSide = ALL.filter((p) => {
      const r = rel(p);
      return r.startsWith('modules/order/') || r.startsWith('modules/cash/') || r === 'modules/user/customer.routes.ts';
    });
    expect(orderSide.length).toBeGreaterThan(5);
    const offenders = orderSide.filter((p) => /from\s+['"][^'"]*providers\/payment/.test(readFileSync(p, 'utf8')));
    expect(offenders.map(rel), 'a payment gateway reached the order path').toEqual([]);
  });

  it('the ledger has no account that could hold order money', () => {
    // Every account is fee/subscription-scoped. WALLET_LIABILITY is the PARTNER fee wallet,
    // subledgered by subscriptionId — it is named here so the exemption is deliberate.
    const names = Object.keys(LEDGER_ACCOUNTS).sort();
    expect(names).toEqual([
      'BANK_LOCAL', 'CHARGEBACK_LOSS', 'CHARGEBACK_RESERVE', 'CLEARING_CARD', 'CLEARING_MMG',
      'DEFERRED_REVENUE', 'FEE_REVENUE', 'FX_VARIANCE', 'OPENING_BALANCES', 'PROMO_EXPENSE',
      'PROVIDER_FEES', 'SUSPENSE_LIABILITY', 'WALLET_LIABILITY',
    ]);
    expect(LEDGER_ACCOUNTS['WALLET_LIABILITY']!.name).toMatch(/subscriptionId/);
  });

  it('User.walletBalance stays dormant — a customer balance Swift owes is custody by another name', () => {
    // The column survives from a removed wallet surface. It must never be read or written:
    // the only permitted mention is the money-unit registry, which must declare every
    // Decimal column whether or not it is used.
    const ALLOWED = new Set(['utils/money-units.ts']);
    const touching = ALL.filter((p) => {
      const r = rel(p);
      if (ALLOWED.has(r)) return false;
      const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      return /\bwalletBalance\b/.test(code);
    }).map(rel);
    // billing/* legitimately reads the PARTNER fee wallet under this name; nothing else may.
    expect(touching.filter((r) => !r.startsWith('modules/billing/'))).toEqual([]);
  });

  it('no customer-facing top-up, escrow or held-funds surface exists', () => {
    const BANNED = /\b(customerWallet|customerBalance|escrowAccount|heldFunds|platformFloat|custodyAccount)\b/;
    const offenders = ALL.filter((p) => {
      const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      return BANNED.test(code);
    }).map(rel);
    expect(offenders).toEqual([]);
  });
});
