import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The tracking screen's last food words on a booking.
//
// DeliveryScreen already tells a booking apart from an order almost
// everywhere — "Booked", "Sent to the provider", "Confirmed", "Cancel
// booking", "This booking goes to …", "the provider" as the MMG payee. Two
// sentences were missed, and both are cancellation copy on the one rail where
// the money may already have moved: the cancelled banner and the cancel sheet
// told a customer who paid a barbershop by MMG that "the store refunds you
// directly" for "this order". Read as source, like the sibling cancel test:
// the screen imports react-native, which Vitest cannot load.
//
//   - the refund party is named from the fulfillment, the same discriminator
//     the rest of this screen keys its booking words on;
//   - the cancelled banner names a booking as a booking;
//   - food, pickup and courier keep the exact words they had.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREEN = strip(readFileSync(new URL('./DeliveryScreen.tsx', import.meta.url), 'utf8'));

describe('the MMG cancellation copy names the provider on a booking', () => {
  it('no sentence on this screen hardcodes the store as the refunding party', () => {
    expect(SCREEN).not.toMatch(/the store refunds you directly/);
  });

  it('the refund party is derived from the fulfillment and used by both the banner and the sheet', () => {
    expect(SCREEN).toMatch(/const refundParty = o\.fulfillment === 'APPOINTMENT' \? 'the provider' : 'the store';/);
    const uses = SCREEN.match(/\$\{refundParty\} refunds you directly\./g) ?? [];
    expect(uses.length, 'the cancelled banner and the cancel sheet must both name the refund party').toBe(2);
  });

  it('the cancelled banner calls a booking a booking', () => {
    expect(SCREEN).toMatch(/const cancelledNoun = o\.fulfillment === 'APPOINTMENT' \? 'booking' : 'order';/);
    const banners = SCREEN.match(/This \$\{cancelledNoun\} was cancelled\./g) ?? [];
    expect(banners.length, 'both branches of the cancelled banner (with and without the MMG sentence)').toBe(2);
    expect(SCREEN).not.toMatch(/'This order was cancelled\./);
  });
});

describe('controls — the words every other vertical already had', () => {
  it('the cancel sheet still says what it said for a courier request', () => {
    expect(SCREEN).toMatch(/This cancels the pickup and puts the assigned rider back in the dispatch pool\. It can’t be undone\./);
    expect(SCREEN).toMatch(/This stops the rider search and cancels the pickup request\. It can’t be undone\./);
  });

  it('the sheet keeps its non-MMG sentence and the server-preview wording', () => {
    expect(SCREEN).toMatch(/Cancelling stops fulfilment\. The server preview is shown below; the final outcome is confirmed when cancellation completes\./);
  });

  it('the booking-aware hold caption and pending summary this screen already had are still there', () => {
    expect(SCREEN).toMatch(/Changed your mind\? Cancel before the provider starts — the app shows any cost before you confirm\./);
    expect(SCREEN).toMatch(/The provider will confirm your booking shortly/);
  });
});
