import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { computeLegEtas, remainingStops } from '../modules/dispatch/live-eta';

// ---------------------------------------------------------------------------
// [B3] A stacked rider's second customer must be told the truth.
//
// Provider = deterministic haversine (the test default), so minutes are stable
// and monotone in distance. What is graded here is the SHAPE of the answer:
// the first leg is direct; the second is the chain through the first leg's
// remaining stops, labelled so the screen can say "after another delivery";
// and a hop nobody can price makes that leg — and every leg behind it — null
// rather than a confident number [UI never lies].
// ---------------------------------------------------------------------------

const RIDER = { lat: 6.8000, lng: -58.1500 };
const NEAR_PICKUP = { lat: 6.8010, lng: -58.1510 };    // a few blocks
const NEAR_DROP = { lat: 6.8100, lng: -58.1600 };      // across town
const FAR_DROP = { lat: 7.1000, lng: -58.4000 };       // way out

function leg(id: string, status: string, pickup: { lat: number; lng: number } | null, drop: { lat: number; lng: number } | null) {
  return {
    id, status,
    pickupLat: pickup?.lat ?? null, pickupLng: pickup?.lng ?? null,
    deliveryLat: drop?.lat ?? null, deliveryLng: drop?.lng ?? null,
  };
}

describe('what a leg still has ahead of it', () => {
  it('before pickup: the pickup, then the drop', () => {
    expect(remainingStops(leg('a', 'RIDER_EN_ROUTE_PICKUP', NEAR_PICKUP, NEAR_DROP))).toEqual([NEAR_PICKUP, NEAR_DROP]);
  });
  it('after pickup: only the drop', () => {
    expect(remainingStops(leg('a', 'EN_ROUTE_DELIVERY', NEAR_PICKUP, NEAR_DROP))).toEqual([NEAR_DROP]);
  });
  it('a leg with no usable coordinates prices as UNKNOWN, never as zero', () => {
    // Zero would tell the next customer the rider is closer than anyone knows.
    expect(remainingStops(leg('a', 'RIDER_EN_ROUTE_PICKUP', null, NEAR_DROP))).toBeNull();
    expect(remainingStops(leg('a', 'EN_ROUTE_DELIVERY', NEAR_PICKUP, null))).toBeNull();
  });
});

describe('the second customer is told the truth', () => {
  it('one leg: direct, same as the single-leg answer has always been', async () => {
    const [only] = await computeLegEtas([leg('a', 'EN_ROUTE_DELIVERY', NEAR_PICKUP, NEAR_DROP)], RIDER);
    expect(only!.basis).toBe('direct');
    expect(only!.etaMinutes).toBeGreaterThan(0);
  });

  it('two legs: the second is the CHAIN through the first, and says so', async () => {
    // Leg B's drop is right next to the rider. A straight-line answer would say
    // "1 minute". The rider is going to finish leg A first — across town and
    // back — so the honest answer is much larger, and labelled.
    const legA = leg('a', 'RIDER_EN_ROUTE_PICKUP', NEAR_PICKUP, FAR_DROP);
    const legB = leg('b', 'RIDER_EN_ROUTE_PICKUP', NEAR_PICKUP, { lat: 6.8002, lng: -58.1502 });
    const [a, b] = await computeLegEtas([legA, legB], RIDER);
    expect(a!.basis).toBe('direct');
    expect(b!.basis).toBe('after_current');
    expect(b!.etaMinutes!, 'the chain includes all of leg A').toBeGreaterThan(a!.etaMinutes!);
    // And a direct answer for B alone is tiny — the lie this exists to stop.
    const [bAlone] = await computeLegEtas([legB], RIDER);
    expect(bAlone!.etaMinutes!).toBeLessThan(b!.etaMinutes!);
  });

  it('a leg nobody can price is null, and poisons every leg behind it', async () => {
    // If leg A's drop is unknown, nothing after it can be honestly timed: the
    // rider's position after A is unknowable. Null beats a number.
    const legA = leg('a', 'EN_ROUTE_DELIVERY', NEAR_PICKUP, null);
    const legB = leg('b', 'RIDER_EN_ROUTE_PICKUP', NEAR_PICKUP, NEAR_DROP);
    const [a, b] = await computeLegEtas([legA, legB], RIDER);
    expect(a!.etaMinutes).toBeNull();
    expect(b!.etaMinutes).toBeNull();
    expect(b!.basis).toBe('after_current');
  });

  it('order is acceptance order — the caller sorts, the chain trusts it', async () => {
    const legs = [leg('first', 'EN_ROUTE_DELIVERY', NEAR_PICKUP, NEAR_DROP), leg('second', 'EN_ROUTE_DELIVERY', NEAR_PICKUP, FAR_DROP)];
    const etas = await computeLegEtas(legs, RIDER);
    expect(etas.map((e) => e.orderId)).toEqual(['first', 'second']);
  });
});

describe('the publish reaches every live leg', () => {
  const src = readFileSync(path.join(__dirname, '..', 'modules', 'rider', 'rider.routes.ts'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('legs are read by riderId, never by the primary pointer alone', () => {
    // The pointer is only the primary; publishing to its room is the frozen
    // map this fixes.
    expect(stripped).toContain("where: { riderId: rider.id, orderType: { not: 'TAXI' }, status: { notIn: TERMINAL_ORDER_STATUSES } }");
    expect(stripped).not.toContain('io.to(`order:${authorized.currentOrderId}`)');
  });

  it('every leg still live gets the sample, with its own ETA and basis', () => {
    const block = stripped.slice(stripped.indexOf('for (const leg of legEtas)'), stripped.indexOf("return { accepted: true as const };"));
    expect(block).toContain('io.to(`order:${leg.orderId}`)');
    expect(block).toContain('etaMinutes: leg.etaMinutes');
    expect(block).toContain('etaBasis: leg.basis');
    expect(block).toContain('if (!stillLive.has(leg.orderId)) continue;');
  });
});
