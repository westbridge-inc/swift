import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrderProjection, OrderVerticalFacts } from '@swift/types';
import { orderVertical } from '../../../api/src/modules/order/order-vertical';
import {
  ORDER_VERTICAL_IS_THE_SHARED_CONTRACT,
  isOrderVertical,
  orderRecipientNoun,
  orderStatusLabel,
  presentedVertical,
} from './orderStatus';

// ---------------------------------------------------------------------------
// R2 — THE TWO CLIENT FINDINGS OF THE AUTHOR-SEPARATED REVIEW, RED FIRST.
//
//   F02  The real API discriminator, then the real label authority: a SERVICE
//        business's shampoo sold by delivery or pickup must read like the
//        delivery it is ("Order accepted", "Ready for pickup", "On its way to
//        you"), and only its appointment like a booking. The chain is split
//        exactly at the wire: `orderVertical` is what the customer routes
//        project as `vertical` (pinned server-side by the R2 API suite), and
//        the JSON round-trip here is the serialization the phone receives.
//   F05  `vertical` travels typed. `packages/types` owns one serialized
//        projection with `vertical` and `fulfillment`; the API declares from it
//        and this app's vocabulary is asserted equal to it at compile time. A
//        wire value the app does not know is an explicit UNKNOWN — the honest
//        fallback, never a store's words.
// ---------------------------------------------------------------------------

const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const STAGES = ['ACCEPTED', 'READY_FOR_PICKUP', 'EN_ROUTE_DELIVERY'] as const;

describe('F02 — the real API discriminator → the real label authority', () => {
  const cases: Array<['DELIVERY' | 'PICKUP' | 'APPOINTMENT', string[]]> = [
    ['DELIVERY', ['Order accepted', 'Ready for pickup', 'On its way to you']],
    ['PICKUP', ['Order accepted', 'Ready for pickup', 'On its way to you']],
    ['APPOINTMENT', ['Booking confirmed', 'In progress', 'In progress']],
  ];

  it.each(cases)('a SERVICE business, %s fulfillment', (fulfillment, labels) => {
    const projected = wire({
      orderType: 'FOOD_DELIVERY' as const,
      fulfillment,
      vertical: orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment, vendor: { vendorType: 'SERVICE' } }),
    });
    const vertical = presentedVertical(projected);
    expect(STAGES.map((s) => orderStatusLabel(s, vertical))).toEqual(labels);
    expect(orderRecipientNoun(vertical)).toBe(fulfillment === 'APPOINTMENT' ? 'the provider' : 'the store');
  });

  it('a restaurant delivery is unchanged by the narrowing', () => {
    const vertical = presentedVertical(wire({ orderType: 'FOOD_DELIVERY' as const, vertical: orderVertical({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', vendor: { vendorType: 'RESTAURANT' } }) }));
    expect(vertical).toBe('FOOD_DELIVERY');
    expect(orderStatusLabel('PENDING', vertical)).toBe('Waiting for the store');
  });
});

describe('F05 — the discriminator travels typed, and an unknown value is not a store', () => {
  it('a type-valid projection cannot misspell the vertical', () => {
    // @ts-expect-error — 'SERVCE' is not an OrderVertical: the contract is shared with the API, not a free string
    const misspelt: OrderProjection = { id: 'o-1', orderNumber: 'ORD-1', status: 'PENDING', orderType: 'FOOD_DELIVERY', vertical: 'SERVCE' };
    // the object still exists at runtime; the refusal above is the compile-time contract
    expect(misspelt.vertical).toBe('SERVCE');
  });

  it('a wire value the app does not know is an explicit UNKNOWN with the honest fallback, never store words', () => {
    const unknown = JSON.parse('{"vertical":"SERVCE","orderType":"FOOD_DELIVERY"}') as OrderVerticalFacts;
    expect(presentedVertical(unknown)).toBe('UNKNOWN');
    expect(orderStatusLabel('PENDING', presentedVertical(unknown))).toBe('In progress');
    expect(orderStatusLabel('ACCEPTED', presentedVertical(unknown))).toBe('In progress');
    expect(orderStatusLabel('CANCELLED', presentedVertical(unknown))).toBe('Cancelled');
    expect(orderRecipientNoun(presentedVertical(unknown))).toBe('the recipient');
  });

  it('the guard knows exactly the declared verticals', () => {
    for (const v of ['FOOD_DELIVERY', 'GROCERY_DELIVERY', 'COURIER', 'TAXI', 'SERVICE']) expect(isOrderVertical(v), v).toBe(true);
    for (const v of ['SERVCE', 'RETAIL', '', null, undefined, 3]) expect(isOrderVertical(v), String(v)).toBe(false);
  });

  it('an older API with no declaration still gets its persisted words; a newer one wins over the persisted type', () => {
    expect(presentedVertical({ orderType: 'FOOD_DELIVERY' })).toBe('FOOD_DELIVERY');
    expect(presentedVertical({ orderType: 'TAXI' })).toBe('TAXI');
    expect(presentedVertical({ vertical: 'SERVICE', orderType: 'FOOD_DELIVERY' })).toBe('SERVICE');
    expect(presentedVertical({})).toBeNull();
  });

  it('this app’s vocabulary IS the shared contract', () => {
    expect(ORDER_VERTICAL_IS_THE_SHARED_CONTRACT).toBe(true);
  });

  it('the hooks and the touched screens read the projection through the shared type', () => {
    const hooks = readFileSync(join(process.cwd(), 'src/hooks/customer.ts'), 'utf8');
    expect(hooks).toMatch(/import type \{[^}]*\bOrderProjection\b[^}]*\} from '@swift\/types'/);
    expect(hooks.match(/as OrderProjection\[\]/g) ?? [], 'the live and the history list rows are typed at the hook').toHaveLength(2);
    expect(hooks).toMatch(/export function useOrder<T = OrderProjection>/);
    expect(hooks).toMatch(/export function useHome<T = HomeFeed>/);
    expect(hooks).toMatch(/activeOrder: LiveOrderProjection \| null/);
    const home = readFileSync(join(process.cwd(), 'src/modules/shop/screens/HomeScreen.tsx'), 'utf8');
    expect(home).toMatch(/function LiveOrderCard\(\{ order, navigation \}: \{ order: LiveOrderProjection; navigation: any \}\)/);
    expect(home).toMatch(/useHome<HomeFeed>\(/);
    const history = readFileSync(join(process.cwd(), 'src/modules/orders/screens/OrdersHistoryScreen.tsx'), 'utf8');
    expect(history).toMatch(/function statusPill\(o: OrderVerticalFacts & \{ status: string \}\)/);
  });
});
