import { describe, it, expect } from 'vitest';
import { evaluatePureRules, haversineM, DEFAULT_BATCHING_CONFIG, type CandidateOrder, type RunShape } from '../modules/batching/eligibility';

// System 1 Part 2 — the pure gate, table-driven. Every rule row carries its
// measured value vs limit (the founder-explainability contract); one failure
// anywhere = ineligible. Shadow geometry is straight-line BY DESIGN — the
// conservative approximation.

const GT = { lat: 6.8013, lng: -58.1553 }; // Stabroek
const nearGT = { lat: 6.8043, lng: -58.1523 }; // ~500m away
const farSouth = { lat: 6.75, lng: -58.15 }; // ~5.7km

const order = (over: Partial<CandidateOrder> = {}): CandidateOrder => ({
  orderId: `o-${Math.random().toString(36).slice(2, 8)}`,
  vertical: 'FOOD',
  sizeClass: 'S',
  cashToCollect: 2000,
  pickup: { ...GT, vendorId: 'v1' },
  dropoff: nearGT,
  ...over,
});

const run = (orders: CandidateOrder[], over: Partial<RunShape> = {}): RunShape => ({
  orders,
  vehicleType: 'MOTORBIKE',
  riderCashFloatCap: 10_000,
  riderBlocked: false,
  ...over,
});

describe('the pure eligibility gate (R1–R6, R12)', () => {
  it('a clean same-vendor food pair passes every rule with explained rows', () => {
    const a = order();
    const b = order({ dropoff: { lat: nearGT.lat + 0.001, lng: nearGT.lng } });
    const res = evaluatePureRules(b, run([a]));
    expect(res.eligible).toBe(true);
    expect(res.rules.map((r) => r.rule)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R12']);
    for (const r of res.rules) expect(r.pass).toBe(true);
  });

  it('R1: FOOD+COURIER never mixes; FOOD+GROCERY does (config, not code)', () => {
    expect(evaluatePureRules(order({ vertical: 'COURIER' }), run([order()])).rules.find((r) => r.rule === 'R1')!.pass).toBe(false);
    expect(evaluatePureRules(order({ vertical: 'GROCERY' }), run([order()])).rules.find((r) => r.rule === 'R1')!.pass).toBe(true);
  });

  it('R2: the hard ceiling of 3 holds even when config says more', () => {
    const three = [order(), order(), order()];
    const res = evaluatePureRules(order(), run(three), { ...DEFAULT_BATCHING_CONFIG, maxOrdersPerRun: 5 });
    expect(res.rules.find((r) => r.rule === 'R2')!.pass).toBe(false);
    expect(res.rules.find((r) => r.rule === 'R2')!.limit).toBe(3);
  });

  it('R3: XL never batches; size points respect the vehicle', () => {
    expect(evaluatePureRules(order({ sizeClass: 'XL' }), run([order()])).rules.find((r) => r.rule === 'R3')!.pass).toBe(false);
    // Bicycle (3 points): S+L = 1+3 = 4 > 3 → fail; S+M = 3 → pass exactly.
    expect(evaluatePureRules(order({ sizeClass: 'L' }), run([order()], { vehicleType: 'BICYCLE' })).rules.find((r) => r.rule === 'R3')!.pass).toBe(false);
    expect(evaluatePureRules(order({ sizeClass: 'M' }), run([order()], { vehicleType: 'BICYCLE' })).rules.find((r) => r.rule === 'R3')!.pass).toBe(true);
  });

  it('R4: summed cash respects the float cap, change-for amounts included in the sum', () => {
    const res = evaluatePureRules(order({ cashToCollect: 9000 }), run([order({ cashToCollect: 2000 })]));
    const r4 = res.rules.find((r) => r.rule === 'R4')!;
    expect(r4.pass).toBe(false);
    expect(r4.value).toBe(11000);
  });

  it('R5/R6: different vendors far apart fail pickup shape; far dropoffs fail the corridor — both marked conservative', () => {
    const b = order({ pickup: { ...farSouth, vendorId: 'v2' }, dropoff: farSouth });
    const res = evaluatePureRules(b, run([order()]));
    const r5 = res.rules.find((r) => r.rule === 'R5')!;
    const r6 = res.rules.find((r) => r.rule === 'R6')!;
    expect(r5.pass).toBe(false);
    expect(r6.pass).toBe(false);
    expect(String(r5.note)).toContain('conservative');
    expect(Number(r6.value)).toBeGreaterThan(1500);
  });

  it('R12: a blocked rider batches nothing', () => {
    const res = evaluatePureRules(order(), run([order()], { riderBlocked: true }));
    expect(res.eligible).toBe(false);
    expect(res.rules.find((r) => r.rule === 'R12')!.pass).toBe(false);
  });

  it('haversine sanity: Stabroek→500m ≈ 500m, →far south ≈ 5.7km', () => {
    expect(haversineM(GT, nearGT)).toBeGreaterThan(350);
    expect(haversineM(GT, nearGT)).toBeLessThan(650);
    expect(haversineM(GT, farSouth)).toBeGreaterThan(5000);
  });
});
