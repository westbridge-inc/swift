import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [W-26] Both ends of the cash ledger — the store's "Fee handed over" and the
// rider's "Fee received" — were ONE CLICK that closed a real debt. No amount
// restated, no counterparty named, no second step. A mis-tap on the wrong row
// settled money that never changed hands.
//
// The server half is proved in apps/api delivery-cash-settlement.test.ts (the
// attested amount must equal the ledger's own, and who confirmed is recorded).
// This is the client half: the figure must actually be SENT, and the person
// must be shown what they are agreeing to first.
// ---------------------------------------------------------------------------

const strip = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*|\{\/\*)/.test(l)).join('\n');
const read = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf8'));

const vendorApi = read('src/lib/vendor-api.ts');
const moverApi = read('src/lib/mover-api.ts');
const storePage = read('src/app/dashboard/settings/page.tsx');
const riderPage = read('src/app/portal/page.tsx');

describe('[W-26] the confirmation carries its amount', () => {
  it('both clients send an amount, and neither posts an empty body', () => {
    expect(vendorApi).toMatch(/confirmSettlement = \(id: string, amount: string \| number\)/);
    expect(moverApi).toMatch(/confirmRiderSettlement = \(id: string, amount: string \| number\)/);
    for (const [name, src] of [['vendor-api', vendorApi], ['mover-api', moverApi]] as const) {
      const call = src.slice(src.indexOf('cash-settlements/${id}/confirm'));
      expect(call.slice(0, 200), name).toMatch(/JSON\.stringify\(\{ amount \}\)/);
      // the old shape: a body with nothing in it
      expect(call.slice(0, 200), name).not.toMatch(/body: '\{\}'/);
    }
  });
});

describe('[W-26] neither side closes a debt in one click', () => {
  for (const [who, page, other] of [
    ['store', storePage, 'rider'],
    ['rider', riderPage, 'store'],
  ] as const) {
    it(`the ${who} sees what it is agreeing to before it agrees`, () => {
      // a first press ARMS the row; only the second one confirms
      expect(page, who).toMatch(/setPending\(id\)/);
      expect(page, who).toMatch(/pending === id \?/);
      // the confirming press is the only one that mutates
      expect(page, who).toMatch(/confirm\.mutate\(\{ id, amount: String\(r\['amount'\] \?\? ''\) \}\)/);
      // the old shape: the visible button fired the mutation directly
      expect(page, who).not.toMatch(/onClick=\{\(\) => confirm\.mutate\(id\)\}/);
    });

    it(`the ${who}'s confirmation names the amount and the ${other}`, () => {
      const armed = page.slice(page.indexOf('pending === id ?'), page.indexOf('pending === id ?') + 700);
      expect(armed, who).toMatch(/money\(/);          // the figure is restated
      expect(armed, who).toMatch(/\{(rider|vendorName)\}/); // the counterparty is named
    });

    it(`the ${who}'s armed row can be backed out of`, () => {
      expect(page, who).toMatch(/onClick=\{\(\) => setPending\(null\)\}/);
      expect(page, who).toMatch(/Cancel/);
    });
  }
});
