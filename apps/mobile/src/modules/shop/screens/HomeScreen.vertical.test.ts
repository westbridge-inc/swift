import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The client half of "a barbershop booking is not a food order".
//
// The server now DECLARES the vertical of every customer order projection
// (`vertical`: SERVICE for a service business's booking, otherwise the
// persisted type). Two screens choose words from it: Home's live-order card
// and the activity list's status pill. Read as source, like the sibling
// cancel test: hooks/customer.ts pulls in react-native, which Vitest cannot
// import; the shape is what these pin.
//
//   - both screens take the vertical from ONE helper (`presentedVertical`),
//     never straight from `order.orderType`, so an old API that sends no
//     `vertical` still gets the persisted words and a new one gets SERVICE;
//   - the held card names the recipient from the vertical: a booking has not
//     been sent to a "store".
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const HOME = strip(readFileSync(new URL('./HomeScreen.tsx', import.meta.url), 'utf8'));
const HISTORY = strip(readFileSync(new URL('../../orders/screens/OrdersHistoryScreen.tsx', import.meta.url), 'utf8'));

describe('Home’s live-order card speaks the declared vertical', () => {
  const card = HOME.slice(HOME.indexOf('function LiveOrderCard'), HOME.indexOf('export function HomeScreen'));

  it('reads the vertical through the shared helper, never the persisted type alone', () => {
    expect(card.length).toBeGreaterThan(500);
    expect(HOME).toMatch(/import \{[^}]*\bpresentedVertical\b[^}]*\} from '\.\.\/\.\.\/\.\.\/lib\/orderStatus'/);
    expect(card).toMatch(/const vertical = presentedVertical\(order\)/);
    expect(card).toMatch(/orderStatusLabel\(order\.status, vertical\)/);
    expect(card).not.toMatch(/orderStatusLabel\(order\.status, order\.orderType\)/);
  });

  it('names the recipient of a held order from the vertical — a booking has not been sent to a store', () => {
    expect(HOME).toMatch(/import \{[^}]*\borderRecipientNoun\b[^}]*\} from '\.\.\/\.\.\/\.\.\/lib\/orderStatus'/);
    expect(card).toMatch(/orderRecipientNoun\(vertical\)/);
    expect(card).not.toMatch(/The store hasn’t been told yet/);
    expect(card).not.toMatch(/'the store'/);
  });
});

describe('the activity list’s status pill speaks the declared vertical', () => {
  it('statusPill reads the vertical through the shared helper', () => {
    const pill = HISTORY.slice(HISTORY.indexOf('function statusPill'), HISTORY.indexOf('}\n}', HISTORY.indexOf('function statusPill')));
    expect(pill.length).toBeGreaterThan(50);
    expect(HISTORY).toMatch(/import \{[^}]*\bpresentedVertical\b[^}]*\} from '\.\.\/\.\.\/\.\.\/lib\/orderStatus'/);
    expect(pill).toMatch(/orderStatusLabel\(o\.status, presentedVertical\(o\)\)/);
    expect(pill).not.toMatch(/orderStatusLabel\(o\.status, o\.orderType\)/);
  });
});
