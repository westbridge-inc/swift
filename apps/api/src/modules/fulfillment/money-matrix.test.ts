import { describe, it, expect } from 'vitest';
import { settle, type MatrixInput } from './money-matrix';

// FUL-001: the money matrix (fulfillment prompt Part 6.1). Every row is an
// explicit, named settlement path with its own assertions — no "basically the
// same as row 1" shortcuts. The load-bearing invariant is double-entry: money
// is conserved (Σ net = 0) in every combination.

const FOOD = 8000; // GYD 8,000 goods
const FEE = 1200; // GYD 1,200 delivery

describe('money matrix — the 6 fulfillment × payment rows (FUL-001)', () => {
  it('ROW 1 · platform rider + CASH: rider fronts food, collects food+fee, nets the fee', () => {
    const s = settle({ foodTotal: FOOD, deliveryFee: FEE, mode: 'PLATFORM_RIDER', payment: 'CASH' });
    expect(s.riderFronts).toBe(FOOD);
    expect(s.riderNets).toBe(FEE);
    expect(s.net.VENDOR).toBe(FOOD); // vendor paid in full for the food
    expect(s.net.CUSTOMER).toBe(-(FOOD + FEE)); // customer paid once, food+fee
    expect(s.obligations).toHaveLength(0); // settled at handover, nothing owed
    expect(s.reconciles).toBe(true);
  });

  it('ROW 2 · platform rider + VENDOR_MMG: customer pays vendor food+fee, vendor OWES rider the fee', () => {
    const s = settle({ foodTotal: FOOD, deliveryFee: FEE, mode: 'PLATFORM_RIDER', payment: 'VENDOR_MMG' });
    expect(s.riderFronts).toBe(0); // no cash fronting on the MMG path
    expect(s.obligations).toEqual([{ type: 'VENDOR_OWES_RIDER', from: 'VENDOR', to: 'RIDER', amount: FEE }]);
    // once the obligation is settled, the end positions match row 1
    expect(s.net.RIDER).toBe(FEE);
    expect(s.net.VENDOR).toBe(FOOD);
    expect(s.net.CUSTOMER).toBe(-(FOOD + FEE));
    expect(s.movements.some((m) => m.type === 'VENDOR_SETTLED_RIDER' && m.deferred)).toBe(true);
    expect(s.reconciles).toBe(true);
  });

  it('ROW 3 · vendor self-delivery + CASH: vendor keeps everything, no rider, no debt', () => {
    const s = settle({ foodTotal: FOOD, deliveryFee: FEE, mode: 'VENDOR_DELIVERY', payment: 'CASH' });
    expect(s.net.VENDOR).toBe(FOOD + FEE);
    expect(s.net.RIDER).toBe(0);
    expect(s.riderFronts).toBe(0);
    expect(s.obligations).toHaveLength(0);
    expect(s.reconciles).toBe(true);
  });

  it('ROW 4 · vendor self-delivery + VENDOR_MMG: customer pays vendor, nothing owed', () => {
    const s = settle({ foodTotal: FOOD, deliveryFee: FEE, mode: 'VENDOR_DELIVERY', payment: 'VENDOR_MMG' });
    expect(s.net.VENDOR).toBe(FOOD + FEE);
    expect(s.net.RIDER).toBe(0);
    expect(s.movements[0]!.type).toBe('CUSTOMER_PAID_VENDOR_MMG');
    expect(s.reconciles).toBe(true);
  });

  it('ROW 5 · pickup + CASH: food only, no fee, no rider', () => {
    const s = settle({ foodTotal: FOOD, deliveryFee: 0, mode: 'PICKUP', payment: 'CASH' });
    expect(s.net.VENDOR).toBe(FOOD);
    expect(s.net.CUSTOMER).toBe(-FOOD);
    expect(s.net.RIDER).toBe(0);
    expect(s.reconciles).toBe(true);
  });

  it('ROW 6 · pickup + VENDOR_MMG: food only via MMG, clean', () => {
    const s = settle({ foodTotal: FOOD, deliveryFee: 0, mode: 'PICKUP', payment: 'VENDOR_MMG' });
    expect(s.net.VENDOR).toBe(FOOD);
    expect(s.net.RIDER).toBe(0);
    expect(s.movements[0]!.type).toBe('CUSTOMER_PAID_VENDOR_MMG');
    expect(s.reconciles).toBe(true);
  });

  it('EVERY combination conserves money (double-entry: Σ net = 0)', () => {
    const modes = ['PLATFORM_RIDER', 'VENDOR_DELIVERY', 'PICKUP'] as const;
    const payments = ['CASH', 'VENDOR_MMG'] as const;
    for (const mode of modes) {
      for (const payment of payments) {
        const fee = mode === 'PICKUP' ? 0 : FEE;
        const s = settle({ foodTotal: FOOD, deliveryFee: fee, mode, payment });
        expect(s.net.CUSTOMER + s.net.VENDOR + s.net.RIDER, `${mode}/${payment}`).toBe(0);
        expect(s.reconciles).toBe(true);
      }
    }
  });

  it('enforces integer minor units — a fractional or negative amount is rejected', () => {
    const bad: MatrixInput = { foodTotal: 80.5, deliveryFee: FEE, mode: 'PLATFORM_RIDER', payment: 'CASH' };
    expect(() => settle(bad)).toThrow();
    expect(() => settle({ ...bad, foodTotal: -1 })).toThrow();
  });

  it('rejects a pickup that carries a delivery fee (invariant violation)', () => {
    expect(() => settle({ foodTotal: FOOD, deliveryFee: FEE, mode: 'PICKUP', payment: 'CASH' })).toThrow(/pickup/i);
  });
});
