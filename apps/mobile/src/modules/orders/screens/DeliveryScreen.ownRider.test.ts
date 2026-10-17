import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [R14 · legal research D12] When the store delivers an order with its own
// rider, the customer's tracking screen says so in the server's words:
// "This order is delivered by the store's own rider, not a Swift rider."
// The screen never decides it — it renders `ownRiderNotice` from the order
// read (the server's reading of that order's fulfilment mode), and nothing
// when the server sent none (a Swift rider, a pickup, or an older API).
//
// Read as source, like the sibling DeliveryScreen tests: the screen imports
// react-native, which Vitest cannot load. Ships in build 12.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREEN = strip(readFileSync(new URL('./DeliveryScreen.tsx', import.meta.url), 'utf8'));

describe('the own-rider notice on the tracking screen [R14]', () => {
  it('renders exactly the server’s notice, only when the server sent one', () => {
    expect(SCREEN).toMatch(/\{typeof o\.ownRiderNotice === 'string' && o\.ownRiderNotice \? \(/);
    expect(SCREEN).toMatch(/<T variant="caption" tone="info" style=\{\{ flex: 1 \}\}>\{o\.ownRiderNotice\}<\/T>/);
  });

  it('never decides it on the phone: no fulfilment-mode test and no copy of the sentence here', () => {
    expect(SCREEN).not.toMatch(/fulfillmentMode/);
    expect(SCREEN).not.toMatch(/not a Swift rider/);
  });
});
