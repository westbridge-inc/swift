import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [owner #46/#50/#52, 13–14 Oct] Swift never shows or implies a cancellation
// fee it cannot collect — there is none any more. A cancel is free or refused,
// and the server says which (`canCancel`, `cancellationMessage`,
// `cancelUnavailable`). The phone shows the server's verdict; it never words a
// fee and never re-derives the rule from a status list alone.
// ---------------------------------------------------------------------------

const src = (...p: string[]) => readFileSync(join(process.cwd(), 'src', ...p), 'utf8');
const DELIVERY = src('modules', 'orders', 'screens', 'DeliveryScreen.tsx');
const TAXI = src('modules', 'movement', 'screens', 'TaxiScreen.tsx');
const HOLD = src('kit', 'hold-window.ts');
const FEE_WORDS = /late-cancellation|cancellation fee|possible fee|fee may be recorded|fee was recorded|shows any cost/i;

describe('no cancellation fee is worded anywhere a customer cancels', () => {
  it.each([['DeliveryScreen', DELIVERY], ['TaxiScreen', TAXI], ['hold-window', HOLD]])('%s names no fee', (_name, text) => {
    expect(text).not.toMatch(FEE_WORDS);
  });
});

describe('the server’s verdict, and who to contact', () => {
  it('the order screen shows the refusal in the server’s words with the store’s published number to call', () => {
    expect(DELIVERY).toMatch(/o\.cancelUnavailable\?\.message/);
    expect(DELIVERY).toMatch(/openExternal\(`tel:\$\{o\.cancelUnavailable\.contactPhone\}`\)/);
    expect(DELIVERY).toMatch(/o\.cancellationMessage \?\?/);
  });

  it('the ride screen reads the server’s canCancel and shows its reason', () => {
    expect(TAXI).toMatch(/typeof ride\.canCancel === 'boolean' \? ride\.canCancel : true/);
    expect(TAXI).toMatch(/const canCancelRide = serverAllowsCancel && !pinVerified/);
    expect(TAXI).toMatch(/ride\.cancelUnavailable\?\.message/);
  });
});
