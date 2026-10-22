import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [UI-SWEEP U72] The phone never shows the server's code. The store home
// printed "· MOBILE_MONEY" on an order card and "PAST DUE" / "ACTIVE" on its
// Billing and QR tiles; the order screen printed "MOBILE_MONEY" as the payment
// line; an order status the store pill had not been taught (Refunded,
// Returning ...) read as the code with spaces, and so did the order history
// ("Rider en route pickup") and the customer's recent parcels.
// Every value of each server enum is read from the API's schema, so a status
// added there without words here fails this file. The store's status words
// are the map the web store console shares (@swift/types order-words), read
// through lib/orderStatus, the phone's one status vocabulary.
// ---------------------------------------------------------------------------

vi.mock('react-native', () => ({ Pressable: () => null, TextInput: () => null, View: () => null }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => {
  const token: any = new Proxy({}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : token) });
  return { color: token, font: token, fontSize: token, radius: token, space: token };
});
vi.mock('../../kit', () => ({
  T: () => null,
  TonePill: (props: unknown) => props,
  PillButton: () => null,
  useLogoutConfirm: () => () => {},
}));
vi.mock('../../components/onboarding/BackToSwiftButton', () => ({ BackToSwiftButton: () => null }));

import { STORE_ORDER_STATUS_WORDS } from '@swift/types';
import { orderPaymentLine, paymentMethodWords, qrStatusWords, subscriptionPillWords } from './storeWords';
import { OrderStatusPill } from './shared';
import { orderStatusLabel, storeStatusLabel, storeTimelineLabel } from '../../lib/orderStatus';

const schema = readFileSync(join(__dirname, '../../../../api/prisma/schema.prisma'), 'utf8');
function enumValues(name: string): string[] {
  const body = schema.match(new RegExp(`\\benum ${name} \\{([\\s\\S]*?)\\}`))?.[1];
  expect(body, `enum ${name} in the API schema`).toBeTruthy();
  return body!.split('\n').map((line) => line.replace(/\/\/.*$/, '').trim()).filter(Boolean);
}
// Words: never the code itself, never an underscore, never shouting capitals
// ("PAST DUE"); "MMG" is a name, not a code.
const words = (out: string, code: string) => {
  expect(out, `${code}`).not.toBe(code);
  expect(out, `${code}`).not.toContain('_');
  if (out !== 'MMG') expect(out, `${code}`).not.toMatch(/^[A-Z][A-Z ]+$/);
  expect(out.trim(), `${code}`).not.toBe('');
};

describe('[UI-SWEEP U72] every order status reads in words on the store side', () => {
  const statuses = enumValues('OrderStatus');

  it('the pill and the history have words for every status the server can send', () => {
    expect(statuses.length).toBeGreaterThan(15);
    for (const s of statuses) {
      words(storeStatusLabel(s), s);
      words(storeTimelineLabel(s), s);
      expect(storeStatusLabel(s), `${s} has its own words`).not.toBe('Status unavailable');
    }
  });

  it('the store side speaks the same words as the web store console', () => {
    for (const s of statuses) expect(storeStatusLabel(s), s).toBe(STORE_ORDER_STATUS_WORDS[s as keyof typeof STORE_ORDER_STATUS_WORDS]);
  });

  it('the statuses the pill used to print as codes now read in words', () => {
    expect(storeStatusLabel('REFUNDED')).toBe('Refunded');
    expect(storeStatusLabel('RETURNING')).toBe('Returning');
    expect(storeStatusLabel('RETURNED')).toBe('Returned');
    expect(storeTimelineLabel('RIDER_EN_ROUTE_PICKUP')).toBe('Rider en route');
    expect(storeTimelineLabel('PENDING')).toBe('Placed');
    expect(storeTimelineLabel('PLACED')).toBe('Placed');
  });

  it('a status the phone has not been taught reads "Status unavailable", never the code', () => {
    expect(storeStatusLabel('SOMETHING_NEW')).toBe('Status unavailable');
    expect(storeTimelineLabel('SOMETHING_NEW')).toBe('Status unavailable');
    expect(storeStatusLabel(undefined)).toBe('Status unavailable');
  });

  it('the store pill itself uses those words for every status', () => {
    for (const s of statuses) {
      const el = OrderStatusPill({ status: s }) as any;
      expect(String(el.props.label), s).toBe(storeStatusLabel(s));
      words(String(el.props.label), s);
    }
    expect((OrderStatusPill({ status: 'RETURNING' }) as any).props.label).toBe('Returning');
    expect((OrderStatusPill({ status: 'SOMETHING_NEW' }) as any).props.label).toBe('Status unavailable');
  });

  it("a parcel's status reads in the parcel's words, never the code", () => {
    for (const s of statuses) words(orderStatusLabel(s, 'COURIER'), s);
    expect(orderStatusLabel('RIDER_EN_ROUTE_PICKUP', 'COURIER')).toBe('Rider on the way to collect');
  });
});

describe('[UI-SWEEP U72] payment method, weekly fee and QR in words', () => {
  it('every payment method the server knows has a name; MMG is "MMG"', () => {
    for (const m of enumValues('PaymentMethod')) {
      words(paymentMethodWords(m)!, m);
      words(orderPaymentLine(m), m);
    }
    expect(paymentMethodWords('MOBILE_MONEY')).toBe('MMG');
    expect(orderPaymentLine('MOBILE_MONEY')).toBe('MMG — the customer pays your store’s MMG account.');
    expect(orderPaymentLine('CASH')).toBe('Cash on handover — you keep 100% of the goods total.');
  });

  it('no payment method names nothing; an unknown one is "Other payment"', () => {
    expect(paymentMethodWords(null)).toBeNull();
    expect(paymentMethodWords('')).toBeNull();
    expect(paymentMethodWords('CRYPTO_THING')).toBe('Other payment');
    expect(orderPaymentLine(null)).toBe('Payment method not shown');
  });

  it('every subscription status has the Billing screen words', () => {
    for (const s of enumValues('SubscriptionStatus')) words(subscriptionPillWords(s), s);
    expect(subscriptionPillWords('PAST_DUE')).toBe('Weekly fee overdue');
    expect(subscriptionPillWords('TRIAL')).toBe('Free trial');
    expect(subscriptionPillWords(undefined)).toBe('Status unavailable');
  });

  it("every QR status has the web store console's words (#1615 orders-home)", () => {
    for (const s of enumValues('QrStatus')) words(qrStatusWords(s), s);
    expect(qrStatusWords('ACTIVE')).toBe('Active');
    expect(qrStatusWords('SUPERSEDED')).toBe('Replaced by a newer QR');
    expect(qrStatusWords('DEACTIVATED')).toBe('Turned off');
    expect(qrStatusWords('SOMETHING_NEW')).toBe('Status unavailable');
  });
});

describe('[UI-SWEEP U72] the screens use the words, not the code', () => {
  const src = (p: string) => readFileSync(join(__dirname, p), 'utf8');

  it('the store home order card names the payment method in words', () => {
    const ops = src('screens/VendorOps.tsx');
    expect(ops).toMatch(/paymentMethodWords\(order\.paymentMethod\)/);
    expect(ops).not.toMatch(/'Cash' : order\.paymentMethod/);
  });

  it('the Billing and QR tiles use the words', () => {
    const ops = src('screens/VendorOps.tsx');
    expect(ops).toMatch(/<TonePill label=\{qrStatusWords\(qrQ\.data\.status\)\}/);
    expect(ops).toMatch(/<TonePill label=\{subscriptionPillWords\(sub\.status\)\}/);
    expect(ops).not.toMatch(/String\((qrQ\.data|sub)\.status[^)]*\)\.replace\(/);
    // The tiles' spoken labels read like the web console's ("QR: Active", "Subscription: Free trial").
    expect(ops).toMatch(/badgeLabel=\{qrQ\.data\?\.status \? `QR: \$\{qrStatusWords\(qrQ\.data\.status\)\}`/);
    expect(ops).toMatch(/`Subscription: \$\{subscriptionPillWords\(sub\.status\)\}`/);
  });

  it('the store order screen uses the payment line and the history words', () => {
    const detail = src('screens/VendorOrderDetailScreen.tsx');
    expect(detail).toMatch(/\{orderPaymentLine\(order\.paymentMethod\)\}/);
    expect(detail).toMatch(/\{storeTimelineLabel\(entry\.status\)\}/);
    expect(detail).not.toMatch(/String\(order\.paymentMethod/);
    // The cancelled card: the shared words, never the raw reason.
    expect(detail).toMatch(/\{cancellationReasonWords\(order\.cancellationReason, 'store'\)\}/);
    expect(detail).not.toMatch(/\{order\.cancellationReason\}/);
  });

  it('no store screen and no parcel list turns a code into text by swapping underscores', () => {
    for (const p of ['screens/VendorOps.tsx', 'screens/VendorOrderDetailScreen.tsx', 'shared.tsx', '../movement/screens/CourierScreen.tsx']) {
      expect(src(p), p).not.toMatch(/\.replace\(\/_\/g, ' '\)/);
    }
    expect(src('../movement/screens/CourierScreen.tsx')).toMatch(/orderStatusLabel\(s, 'COURIER'\)/);
  });
});
