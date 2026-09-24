import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// MKT-F057 — the customer's tracking screen shows the delivery door PIN while
// the order is between the store and the door, and never elsewhere.
//
// Read as source, like the sibling DeliveryScreen tests: the screen imports
// react-native, which Vitest cannot load. The PIN is holder-side — the rider
// (the verifier) never receives it, so the value is only ever rendered here
// and in the customer's order-detail payload.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREEN = strip(readFileSync(new URL('./DeliveryScreen.tsx', import.meta.url), 'utf8'));

describe('the delivery door PIN on the tracking screen [MKT-F057]', () => {
  it('renders the PIN only for a DELIVERY order that carries one', () => {
    expect(SCREEN).toMatch(/o\.fulfillment === 'DELIVERY' && o\.ridePin/);
  });

  it('shows it only between pickup and the door', () => {
    expect(SCREEN).toMatch(/\['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'\]\.includes\(o\.status\)/);
  });

  it('says what the code is for and renders the value', () => {
    expect(SCREEN).toMatch(/Show this code to your rider at the door/);
    // The one place the customer's PIN is displayed: inside that block.
    expect(SCREEN).toMatch(/\{o\.ridePin\}/);
  });

  it('a PICKUP order shows only the pickup-code block, never the delivery PIN', () => {
    // Two separate, mutually exclusive gates — a PICKUP customer gets the
    // counter code; the door PIN is DELIVERY-only.
    expect(SCREEN.match(/o\.fulfillment === 'PICKUP' && o\.pickupCode/g)).toHaveLength(1);
    expect(SCREEN.match(/o\.fulfillment === 'DELIVERY' && o\.ridePin/g)).toHaveLength(1);
  });
});
