import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PARCEL_BANNED_GOODS, PARCEL_DECLARATION, courierWaitingCaption } from './parcelDeclaration';

// ---------------------------------------------------------------------------
// [GUARDRAILS §8 · owner #67] Swift never carries banned goods. The server
// screens a parcel's description against the catalogue's ban list and refuses
// it in plain words (409 PROHIBITED_PARCEL, shown as the screen's error line);
// the sender also ticks "This parcel has no prohibited items" before a parcel
// is sent, and the order records the tick (`declaresNoProhibitedItems`).
// The screen imports maps and native modules Vitest cannot load, so its wiring
// is read as source (the repo's screen-test pattern); the words are unit-tested.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\}/g, '{}').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREEN = strip(readFileSync(new URL('./screens/CourierScreen.tsx', import.meta.url), 'utf8'));
const API_TYPES = readFileSync(new URL('../../services/api.ts', import.meta.url), 'utf8');

describe('[owner #67] the words', () => {
  it('the tick says what the sender declares', () => {
    expect(PARCEL_DECLARATION).toBe('This parcel has no prohibited items');
  });

  it('the list names every banned kind of goods, the server’s classes', () => {
    expect(PARCEL_BANNED_GOODS).toBe(
      'Swift never carries alcohol, tobacco, vapes, medicines, cannabis or other drugs, cooking gas (LPG), fuel, 18+ items, fireworks or explosives, pesticides or toxic chemicals, raw gold, diamonds or precious stones, firearms, ammunition or replicas, protected wildlife, counterfeit goods, or currency and payment cards.',
    );
  });

  it('the button explains what it waits for, the tick last', () => {
    const ready = { estimateFailed: false, hasEstimate: true, recipientReady: true, declared: true };
    expect(courierWaitingCaption(ready)).toBeNull();
    expect(courierWaitingCaption({ ...ready, declared: false })).toBe('Tick “This parcel has no prohibited items” to continue.');
    expect(courierWaitingCaption({ ...ready, recipientReady: false, declared: false })).toBe("Add the recipient's name and phone to continue.");
    expect(courierWaitingCaption({ ...ready, estimateFailed: true, hasEstimate: false, declared: false })).toBe('Waiting on the price — retry the quote above.');
  });
});

describe('[owner #67] the courier screen', () => {
  it('starts unticked, and the tick is the kit checkbox with the declaration as its label', () => {
    expect(SCREEN).toMatch(/const \[declared, setDeclared\] = useState\(false\);/);
    expect(SCREEN).toMatch(/<BrandCheckbox checked=\{declared\} onToggle=\{\(\) => setDeclared\(\(d\) => !d\)\} label=\{PARCEL_DECLARATION\} \/>/);
    expect(SCREEN).toContain('{PARCEL_BANNED_GOODS}');
  });

  it('nothing is sent without the tick', () => {
    expect(SCREEN).toMatch(/const valid =[\s\S]*?&& declared;/);
    expect(SCREEN).toMatch(/if \(!pickupPoint \|\| !dropoffPoint \|\| !dropoff \|\| !pickup \|\| !declared\) return;/);
  });

  it('the order carries the tick', () => {
    const send = SCREEN.slice(SCREEN.indexOf('const onSend = () => {'), SCREEN.indexOf('return (', SCREEN.indexOf('const onSend = () => {')));
    expect(send).toContain('declaresNoProhibitedItems: true,');
    expect(API_TYPES).toMatch(/declaresNoProhibitedItems\?: boolean;/);
  });

  it('the caption under the button says what is missing, including the tick', () => {
    expect(SCREEN).toMatch(/courierWaitingCaption\(\{[^}]*declared[^}]*\}\)/);
  });
});
