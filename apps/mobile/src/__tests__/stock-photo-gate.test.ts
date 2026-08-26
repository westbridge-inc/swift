import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// [S8] NO STOCK PHOTOGRAPH MAY STAND IN FOR MERCHANDISE.
//
// This is a product law, not a style rule. Swift once advertised "Mauby" — a
// Guyanese drink — on Home with a photograph of a cheeseburger, because
// `fallbackImage()` handed out a random stock photo keyed off the row id. On a
// marketplace the customer chooses FROM the picture, so a picture of something
// they are not buying misrepresents the goods; and once any photo on a screen
// might be invented, the real ones stop being evidence.
//
// F-264 deleted the helpers. The POOLS survived it, unimported, for anyone to
// pick up again. This gate is what stops the third round: the rule is now
// enforced against the source tree, not against reviewers' memory.
//
// The honest answer for "no photo" is `PhotoPlaceholder` — the vertical's
// ground colour, its pictogram, and the item's real name. Never a grey box,
// never someone else's dinner.
// ---------------------------------------------------------------------------

const STOCK_HOSTS = [
  'images.unsplash.com',
  'plus.unsplash.com',
  'images.pexels.com',
  'cdn.pixabay.com',
  'istockphoto.com',
  'shutterstock.com',
];

/**
 * The ONE exemption, and why it is not a loophole.
 *
 * The first-run carousel is Swift talking about ITSELF — three marketing
 * slides, not merchandise. No customer is choosing a product from those
 * images, so the misrepresentation the law exists to prevent cannot happen
 * there. It still should not ship on someone else's photographs: the file's
 * own comment already says the art wants to be "local, unmistakably ours",
 * and that needs brand art nobody has produced yet. It is registered as a
 * founder item rather than silently deleted, because removing the images
 * would leave three blank slides on the very first screen of the app.
 *
 * Anything else added here needs the same two things: a reason the goods
 * cannot be misrepresented, and an owner.
 */
const EXEMPT = new Map<string, string>([
  ['src/modules/onboarding/OnboardingScreen.tsx', 'first-run marketing carousel, not merchandise — awaiting brand art (founder item)'],
]);

const SRC = path.join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('no stock photography stands in for merchandise [S8]', () => {
  it('no source file reaches for a stock-photo host', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(path.join(SRC, '..'), file);
      const body = readFileSync(file, 'utf8');
      const hit = STOCK_HOSTS.find((host) => body.includes(host));
      if (!hit) continue;
      if (EXEMPT.has(rel)) continue;
      offenders.push(`${rel} → ${hit}`);
    }
    expect(
      offenders,
      `A stock-photo URL is back in the app.\n${offenders.join('\n')}\n\n` +
      'Use PhotoPlaceholder (kit/photo-placeholder.tsx) for a thing with no photo — ' +
      "the vertical's ground colour, its pictogram, and the item's real name. " +
      'If the image genuinely is not merchandise, add it to EXEMPT with a reason and an owner.',
    ).toEqual([]);
  });

  it('every exemption still exists and still contains what it was excused for', () => {
    // An exemption that outlives its file is a rule quietly getting weaker.
    for (const [rel, reason] of EXEMPT) {
      const full = path.join(SRC, '..', rel);
      const body = readFileSync(full, 'utf8');
      expect(STOCK_HOSTS.some((h) => body.includes(h)), `${rel} no longer uses a stock host — delete its exemption (${reason})`).toBe(true);
    }
  });

  it('the deleted stock pools have not come back', () => {
    const images = readFileSync(path.join(SRC, 'lib/images.ts'), 'utf8');
    for (const gone of ['FOOD_IMAGES', 'GROCERY_IMAGES', 'NEUTRAL_IMAGES', 'CATEGORY_IMAGES']) {
      expect(images.includes(`export const ${gone}`), `${gone} was re-exported`).toBe(false);
    }
  });
});
