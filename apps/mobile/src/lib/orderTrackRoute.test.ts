import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTaxiOrder, trackRouteFor } from './orderTrackRoute';

// ---------------------------------------------------------------------------
// [TAXI-FLOW 22 Oct 2026] A taxi ride never renders on the store tracking
// screen, from ANY entry point.
//
// Owner, testing on staging: "i asked for taxi why is it like im ordering
// food". Home's live card sent every order — his ride included — to
// `Delivery`, the store order screen. This file pins:
//   1. the pure route: a TAXI order tracks on Taxi, everything else on Delivery;
//   2. Home's Track button routes through it;
//   3. the store screen itself hands a TAXI order to Taxi before drawing any
//      store content (the backstop for notification taps, the in-app inbox,
//      and every caller that only has an orderId);
//   4. a CENSUS of every code path that opens `Delivery`: each is either routed
//      by order type, or listed below with the reason it can never carry a ride.
//      A new door to `Delivery` fails this test until it is classified.
// Read as source where the screen imports react-native (Vitest runs in Node).
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SRC = new URL('..', import.meta.url).pathname;
const read = (rel: string) => strip(readFileSync(join(SRC, rel), 'utf8'));

describe('trackRouteFor — the server’s order type picks the screen', () => {
  it('a TAXI order tracks on the ride screen, with no params (it reads the active ride itself)', () => {
    expect(trackRouteFor({ id: 'synthetic-ride', orderType: 'TAXI' })).toEqual({ screen: 'Taxi', params: undefined });
  });

  it('food, grocery, courier, services and an older feed without a type keep the order screen', () => {
    for (const orderType of ['FOOD', 'GROCERY', 'COURIER', 'MARKET', 'SERVICE', null, undefined]) {
      expect(trackRouteFor({ id: 'o1', orderType })).toEqual({ screen: 'Delivery', params: { orderId: 'o1' } });
    }
  });

  it('isTaxiOrder reads only the persisted type', () => {
    expect(isTaxiOrder({ orderType: 'TAXI' })).toBe(true);
    expect(isTaxiOrder({ orderType: 'taxi' })).toBe(false);
    expect(isTaxiOrder(null)).toBe(false);
    expect(isTaxiOrder(undefined)).toBe(false);
  });
});

describe('Home’s live card: Track follows the order type', () => {
  const HOME = read('modules/shop/screens/HomeScreen.tsx');
  const card = HOME.slice(HOME.indexOf('function LiveOrderCard'), HOME.indexOf('export function HomeScreen'));

  it('routes through trackRouteFor and never hard-codes the store screen', () => {
    expect(card.length).toBeGreaterThan(500);
    expect(HOME).toMatch(/import \{[^}]*\btrackRouteFor\b[^}]*\} from '\.\.\/\.\.\/\.\.\/lib\/orderTrackRoute'/);
    expect(card).toMatch(/trackRouteFor\(order\)/);
    expect(card).not.toMatch(/navigate\('Delivery'/);
  });
});

describe('the store tracking screen hands a ride to the ride screen', () => {
  const DELIVERY = read('modules/orders/screens/DeliveryScreen.tsx');
  const body = DELIVERY.slice(DELIVERY.indexOf('export function DeliveryScreen'));

  it('replaces itself with Taxi when the loaded order is a TAXI', () => {
    expect(DELIVERY).toMatch(/import \{[^}]*\bisTaxiOrder\b[^}]*\} from '\.\.\/\.\.\/\.\.\/lib\/orderTrackRoute'/);
    expect(body).toMatch(/isTaxiOrder\(o\)[\s\S]{0,200}navigation\.replace\('Taxi'\)/);
  });

  it('draws no store content for a ride — the guard returns before the first store word', () => {
    const guard = body.search(/if \(isTaxiOrder\(o\)\) \{\s*return/);
    expect(guard).toBeGreaterThan(-1);
    // The guard sits before the error/content returns that draw the order.
    expect(guard).toBeLessThan(body.indexOf('if (!o) {'));
    expect(guard).toBeLessThan(body.indexOf('const cancelled ='));
  });
});

// Every place that opens `Delivery`, and why it is safe for a ride.
const ROUTED_BY_TYPE = 'routed by order type (trackRouteFor / isRide)';
const DELIVERY_DOORS: Record<string, string> = {
  'lib/orderTrackRoute.ts': 'the type router itself (TAXI → Taxi)',
  'modules/orders/screens/OrdersHistoryScreen.tsx#isRide': ROUTED_BY_TYPE,
  'modules/orders/screens/OrdersHistoryScreen.tsx#Details': 'the Details pill renders only in the non-ride branch (rides get "Book a taxi")',
  'modules/movement/screens/CourierScreen.tsx': 'courier parcels only — the courier form never creates a ride',
  'modules/cart/screens/CartScreen.tsx': 'cart checkout creates store orders only — a ride is never in a cart',
  'services/notification-router.ts': 'only a payload the TAXI branches above did not claim; the store screen guard hands any ride on',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('CENSUS: every door to the store tracking screen is classified', () => {
  const doors: string[] = [];
  for (const file of walk(SRC)) {
    const rel = file.slice(SRC.length).replace(/^\//, '');
    const src = strip(readFileSync(file, 'utf8'));
    const re = /'Delivery'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const before = src.slice(Math.max(0, m.index - 60), m.index);
      // A navigation target: inside a navigate/replace/push call, or a
      // destination object's `screen`. Labels ('Delivery' : 'Pickup') are not.
      if (!/(navigate|replace|push)\??\.?\([^()]*$/.test(before) && !/screen:\s*$/.test(before)) continue;
      if (rel === 'modules/orders/screens/OrdersHistoryScreen.tsx') {
        doors.push(`${rel}#${/isRide \?[^()]*$/.test(before) ? 'isRide' : 'Details'}`);
      } else {
        doors.push(rel);
      }
    }
  }

  it('finds the doors (the scan is alive)', () => {
    expect(doors.length).toBeGreaterThanOrEqual(5);
  });

  it('every door is routed by type or carries a reason it never sees a ride', () => {
    const unclassified = [...new Set(doors)].filter((d) => !(d in DELIVERY_DOORS));
    expect(unclassified).toEqual([]);
  });

  it('Home has no door to Delivery of its own any more', () => {
    expect(doors.some((d) => d.startsWith('modules/shop/screens/HomeScreen'))).toBe(false);
  });
});
