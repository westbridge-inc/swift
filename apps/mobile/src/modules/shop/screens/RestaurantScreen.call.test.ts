import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The storefront's "Call the store" row.
//
// Two things about it can break silently, and neither shows up in a typecheck
// because both sides are strings:
//
//   1. Dialling the DISPLAY string. `formatPhoneForDisplay` inserts spaces for
//      a human to read; `tel:+592 225 1234` is not the same URL as
//      `tel:+5922251234` and can fail or dial wrong depending on the handset.
//      The formatted value must never reach Linking.
//
//   2. Re-deciding here whether a number may be shown. The server already
//      withholds it for suspended and unapproved stores, so the client's only
//      correct rule is "render what you were given". A second opinion in the
//      client is how the two drift and a suspended store keeps a call button.
// ---------------------------------------------------------------------------

const SRC = readFileSync(new URL('./RestaurantScreen.tsx', import.meta.url), 'utf8');
const STRIPPED = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Just the call row. `{closed ? (` also appears EARLIER in the file, so the
 *  end of the block has to be found forward from the row, not from the top. */
function callRow(): string {
  const start = STRIPPED.indexOf('{v.publicPhone ? (');
  expect(start, 'the call row must exist').toBeGreaterThan(-1);
  const end = STRIPPED.indexOf('{closed ? (', start);
  expect(end, 'the call row must sit above the closed notice').toBeGreaterThan(start);
  return STRIPPED.slice(start, end);
}

describe('the call row dials the stored number, not the pretty one', () => {
  it('tel: is built from the raw E.164 value', () => {
    const tel = STRIPPED.match(/Linking\.openURL\(`tel:\$\{([^}]+)\}`\)/);
    expect(tel, 'the row must dial through Linking.openURL with a tel: URL').toBeTruthy();
    expect(tel![1]!.trim()).toBe('v.publicPhone');
  });

  it('the formatter is used for DISPLAY only, never inside the tel: URL', () => {
    expect(STRIPPED).toContain('formatPhoneForDisplay(v.publicPhone)');
    expect(STRIPPED).not.toMatch(/tel:\$\{formatPhoneForDisplay/);
  });
});

describe('the client does not re-decide who may be called', () => {
  it('renders on presence alone — no status rule of its own', () => {
    // The server withholds the number for SUSPENDED and PENDING_APPROVAL. If
    // the client grew its own status check the two would drift, and the drift
    // that matters points one way: a store the platform stopped, still callable.
    const row = callRow();
    expect(row.length).toBeGreaterThan(100);
    expect(row).not.toContain('SUSPENDED');
    expect(row).not.toContain('PENDING_APPROVAL');
  });

  it('the row is reachable to a screen reader with the number in the label', () => {
    const row = callRow();
    expect(row).toContain("accessibilityRole=\"button\"");
    expect(row).toMatch(/accessibilityLabel=\{`Call .*formatPhoneForDisplay/);
  });
});
