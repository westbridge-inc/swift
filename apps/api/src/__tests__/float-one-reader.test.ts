import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { riderFloatForOrder } from '../modules/dispatch/float.service';
import { cashMathForOffer } from '../modules/dispatch/dispatch.service';

// ---------------------------------------------------------------------------
// [G4] The float gate and the offer card read the SAME number.
//
// The gate committed `subtotalBase`; the card told the rider to hand over
// `subtotalCustomer`. Equal only because `chk_orders_zero_markup` forces the
// markup to zero — an invariant held by the production schema, not by any
// test, and a CI database that lacked the constraint until #893 would never
// have noticed them drift. The day markup stops being zero, a rider is told
// to pay one number and gated on another.
//
// The fix is structural, not a comment: ONE function reads the amount a rider
// fronts, and every commit, release and card imports it. This file is the
// census that keeps it one — a site that grows its own `Number(x.subtotalBase)`
// fails here before it ships.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');
const ONE_READER = 'modules/dispatch/float.service.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full);
  }
  return out;
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const files = walk(SRC).map((f) => ({ rel: f.slice(SRC.length + 1), code: strip(readFileSync(f, 'utf8')) }));

describe('one reader of what a rider fronts', () => {
  it('a non-CASH order fronts nothing', () => {
    expect(riderFloatForOrder({ paymentMethod: 'MMG', subtotalBase: 4000 })).toBe(0);
    expect(riderFloatForOrder({ paymentMethod: 'CARD', subtotalBase: new Prisma.Decimal('4000.00') })).toBe(0);
  });

  it('a CASH order fronts the goods at the store price, Decimal or number', () => {
    expect(riderFloatForOrder({ paymentMethod: 'CASH', subtotalBase: new Prisma.Decimal('4250.50') })).toBe(4250.5);
    expect(riderFloatForOrder({ paymentMethod: 'CASH', subtotalBase: 4250.5 })).toBe(4250.5);
    expect(riderFloatForOrder({ paymentMethod: 'CASH', subtotalBase: '4250.50' })).toBe(4250.5);
  });

  it('never returns a number the gate cannot hold — NaN, null and negatives are zero', () => {
    // FloatService.commit/release treat ≤ 0 as "nothing to do". A NaN would
    // pass `amount <= 0` as false and reach SQL as NULL arithmetic.
    expect(riderFloatForOrder({ paymentMethod: 'CASH', subtotalBase: null })).toBe(0);
    expect(riderFloatForOrder({ paymentMethod: 'CASH', subtotalBase: undefined })).toBe(0);
    expect(riderFloatForOrder({ paymentMethod: 'CASH', subtotalBase: 'not money' })).toBe(0);
    expect(riderFloatForOrder({ paymentMethod: 'CASH', subtotalBase: -12 })).toBe(0);
  });
});

describe('the card shows the number the gate holds', () => {
  const order = {
    paymentMethod: 'CASH',
    totalAmount: 900,
    subtotalBase: 400,
    subtotalCustomer: 999, // a decoy: the OLD column. The card must not read it.
    deliveryFee: 500,
    serviceFee: 0,
    taxAmount: 0,
    tipAmount: 0,
    discount: 0,
  };

  it('payToVendor IS riderFloatForOrder(order)', () => {
    const card = cashMathForOffer(order);
    expect(card).not.toBeNull();
    expect(card!.payToVendor).toBe(riderFloatForOrder(order));
    expect(card!.payToVendor).toBe(400);
  });

  it('a non-zero markup makes the card REFUSE rather than name a second number', () => {
    // subtotalBase 380 (what the store gets and the gate commits) vs a total
    // built on subtotalCustomer 400: 380 + 500 ≠ 900. Before G4 the card said
    // "hand over 400" while the gate held 380. Now nothing reconciles, and a
    // card that does not add up is not shown.
    expect(cashMathForOffer({ ...order, subtotalBase: 380 })).toBeNull();
  });
});

describe('census: nothing else turns subtotalBase into a float amount', () => {
  it('the CASH-ternary is gone from every site', () => {
    const offenders = files
      .filter((f) => f.rel !== ONE_READER)
      .filter((f) => /paymentMethod\s*===\s*'CASH'\s*\?\s*Number\(\s*\w+\.subtotalBase\s*\)/.test(f.code))
      .map((f) => f.rel);
    expect(offenders, 'import riderFloatForOrder instead').toEqual([]);
  });

  it('no FloatService commit or release is handed a raw subtotalBase', () => {
    // Reading subtotalBase for other purposes (a receipt, a substitution
    // delta) is fine; turning it into the amount a rider FRONTS is not.
    const offenders = files
      .filter((f) => f.rel !== ONE_READER)
      .filter((f) => /\.(commit|release)\([^)]*\bsubtotalBase\b/.test(f.code))
      .map((f) => f.rel);
    expect(offenders, 'the amount a rider fronts has one reader').toEqual([]);
  });

  it('every file that commits or releases a whole-order float imports the one reader', () => {
    // picking.service adjusts by the DELTA of a substitution (a different
    // quantity, computed from line prices) — it is not a whole-order amount.
    const DELTA_ADJUSTERS = new Set(['modules/order/picking.service.ts']);
    const missing = files
      .filter((f) => f.rel !== ONE_READER && !DELTA_ADJUSTERS.has(f.rel))
      .filter((f) => /new FloatService\([^)]*\)\.(commit|release)\(|floatService\.(commit|release)\(/.test(f.code))
      .filter((f) => !/\briderFloatForOrder\(/.test(f.code))
      .map((f) => f.rel);
    expect(missing).toEqual([]);
    // and the allowlist cannot outlive its reason
    for (const rel of DELTA_ADJUSTERS) {
      const f = files.find((x) => x.rel === rel);
      expect(f, `${rel} no longer exists — drop it from DELTA_ADJUSTERS`).toBeTruthy();
      expect(/\.(commit|release)\(/.test(f!.code), `${rel} no longer touches float — drop it`).toBe(true);
    }
  });

  it('the one reader is imported where the money moves', () => {
    const importers = files.filter((f) => /\briderFloatForOrder\(/.test(f.code)).map((f) => f.rel).sort();
    expect(importers).toEqual([
      'modules/dispatch/delivery-watchdog.ts',
      'modules/dispatch/dispatch.service.ts',
      'modules/dispatch/float.service.ts',
      'modules/mover-authority.ts',
      'modules/order/order.service.ts',
      'modules/rider/rider.routes.ts',
    ]);
  });
});
