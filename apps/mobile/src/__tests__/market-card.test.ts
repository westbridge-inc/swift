import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * THE MARKET CARD, GRADED AGAINST THE FOUNDER'S OWN SCREENSHOT.
 *
 * `reference/phone/04-customer-market.png` is the binding spec for this tab
 * [WS-3.6]. The first cut of the item-first Market shipped the right DATA and
 * the wrong CARD, in three ways that a passing test suite had no opinion about:
 *
 *  1. IT THREW THE PHOTOGRAPH AWAY. `ItemHit.imageUrl` travelled on the wire
 *     and the card drew `PhotoPlaceholder` unconditionally — so a merchant who
 *     had photographed their stock saw a pictogram of a shop anyway. The
 *     placeholder is for items with NO photo; using it for every item turns an
 *     honest fallback into a lie about the catalogue's completeness.
 *
 *  2. IT RE-DREW THREE PRIMITIVES THE KIT ALREADY OWNED. The category pill was
 *     hand-built at 36pt — under the 44pt touch minimum that the kit's `Chip`
 *     has always met — beside a `SectionHeader` and a `TonePill` that were
 *     simply never imported. Re-expressing a primitive is how a design system
 *     dies one screen at a time, and it is the specific thing WS-3.1 rule 2
 *     forbids: "if the screen needs a shape the kit lacks, add it to the kit
 *     first".
 *
 *  3. IT DROPPED THE SECTION HEADER ENTIRELY, so the grid began with no
 *     statement of what it was.
 *
 * What this file does NOT do is demand the reference be matched blindly. Three
 * things on that screenshot have no honest source in the data model, and their
 * ABSENCE is asserted here as deliberately as their presence would have been:
 * the hero campaign (M-D4), the LIMITED/HANDMADE badges (M-D3), and the heart
 * (M-D7 — `useToggleFavorite` takes a vendorId; there is no item favourite in
 * the schema, so a heart on a product card would silently bookmark the shop).
 */

const SRC = join(process.cwd(), 'src');
const MARKET = join(SRC, 'modules/shop/screens/MarketScreen.tsx');
const raw = readFileSync(MARKET, 'utf8');

/** Comments carry the reasoning, including the names of the things that are
 *  deliberately absent — so every banned-pattern assertion reads code only. */
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the card shows the merchant’s real photograph', () => {
  it('reads `imageUrl` through the shared resolver', () => {
    expect(code, 'itemPhoto() turns a stored path into a URL the app can load').toMatch(
      /itemPhoto\(item\)/,
    );
  });

  it('uses `Photo`, which falls back to the honest placeholder by itself', () => {
    expect(code).toMatch(/<Photo\b/);
    expect(
      code,
      'drawing PhotoPlaceholder directly is what discarded every real photo — Photo picks',
    ).not.toMatch(/<PhotoPlaceholder\b/);
  });

  it('guards the guard — the comment stripper left the JSX intact', () => {
    // Without this, a broken stripper would make every `not.toMatch` above
    // pass against an empty string.
    expect(code).toMatch(/<FlatList\b/);
  });
});

describe('every shape comes from the kit', () => {
  it.each([
    ['Chip', /\bChip,/, /<Chip\b/],
    ['SectionHeader', /\bSectionHeader,/, /<SectionHeader\b/],
    ['TonePill', /\bTonePill,/, /<TonePill\b/],
  ])('%s is imported and used', (_name, imported, used) => {
    expect(raw).toMatch(imported);
    expect(code).toMatch(used);
  });

  it('no hand-built pill survives', () => {
    // A `borderRadius: radius.full` on a `height:` box is the shape of a
    // hand-drawn chip. The circular add button and the two masthead buttons are
    // circles by width/height, not pills, so this stays specific.
    expect(code, 'the kit Chip is the one selectable pill').not.toMatch(
      /height:\s*36,[\s\S]{0,120}borderRadius:\s*radius\.full/,
    );
  });

  it('the masthead buttons meet the touch minimum', () => {
    // Icon-only controls at the top of a tab are exactly where 44pt gets
    // quietly missed; the first cut's chips were 36.
    expect(code).toMatch(/width:\s*44,\s*\n\s*height:\s*44,/);
  });
});

describe('what the reference draws that has no honest source', () => {
  it('no heart — there is no item favourite to wire it to', () => {
    // M-D7. `useToggleFavorite({ vendorId })` bookmarks a STORE. A heart on a
    // product that favourites its shop is the UI lying about what the tap did.
    expect(code).not.toMatch(/HeartBadge|useToggleFavorite|heart/i);
  });

  it('no LIMITED or HANDMADE badge — no field produces them', () => {
    expect(code).not.toMatch(/LIMITED|HANDMADE/);
  });

  it('the one badge that ships is the one that is derived', () => {
    expect(code, 'NEW comes from the server, off createdAt').toMatch(/item\.isNew/);
    expect(code).toMatch(/label="NEW"/);
  });

  it('no hero campaign slot, and no ad standing in for one', () => {
    // M-D4: an ad in an editorial slot is a different product.
    expect(code).not.toMatch(/Made in Guyana|Shop now|campaign|useAds|adSlot/i);
  });

  it('no stars on a product — Item has no rating', () => {
    // M-D2: the VENDOR has stars. Showing them on a product makes a claim
    // about the wrong thing.
    expect(code).not.toMatch(/<Stars\b|displayRating|ratingCount/);
  });
});

describe('the header states something true', () => {
  it('the title tracks what the grid actually is', () => {
    // "New arrivals" over a popularity-ranked grid would be the UI lying about
    // its own ordering; the hook defaults the sort to `new` for this reason,
    // and a filtered shelf is named by its category instead.
    expect(code).toMatch(/activeChip\?\.name \?\? 'New arrivals'/);
  });

  it('`See all` exists only when there is something to go back out to', () => {
    // A See all that reloads the same grid is decoration pretending to be an
    // action. It appears with a category on, and clears it.
    expect(code).toMatch(/category \? \{ onSeeAll:/);
  });

  it('the trust line survives — it is the business model in the customer’s words', () => {
    expect(raw).toMatch(/flat weekly fee and keeps 100% of what it sells/);
  });
});
