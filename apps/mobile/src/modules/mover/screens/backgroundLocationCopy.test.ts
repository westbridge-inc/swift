import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BG_DISCLOSURE, BG_DISCLOSURE_TEXT } from './backgroundLocationCopy';

// [R18 · research B1/B5] A mover's yes to background location is recorded in
// the consent ledger, anchored to the words the server keeps for it. Those
// must be the words this disclosure shows: the two copies are held equal here,
// and the disclosure renders only from the shared copy.

const API_CONSENT = readFileSync(join(process.cwd(), '../api/src/modules/partner/location-consent.ts'), 'utf8');
const SCREEN = readFileSync(join(process.cwd(), 'src/modules/mover/screens/BackgroundLocationDisclosure.tsx'), 'utf8');

describe('[R18] the background-location disclosure words', () => {
  it('are exactly the consent document the server records the yes against', () => {
    const literal = /export const LOCATION_BG_CONSENT_V1 = '([^']+)';/.exec(API_CONSENT)?.[1];
    expect(literal, 'LOCATION_BG_CONSENT_V1 single-quoted literal').toBeTruthy();
    expect(literal!.replace(/\\n/g, '\n')).toBe(BG_DISCLOSURE_TEXT);
  });

  it('the disclosure renders every part from the shared copy, and no copy of its own', () => {
    for (const ref of ['{BG_DISCLOSURE.title}', '{BG_DISCLOSURE.body}', 'BG_DISCLOSURE.lines.map', '{BG_DISCLOSURE.caption}', 'label={BG_DISCLOSURE.allow}', 'label={BG_DISCLOSURE.decline}']) {
      expect(SCREEN).toContain(ref);
    }
    for (const words of [BG_DISCLOSURE.title, 'Swift collects your location', ...BG_DISCLOSURE.lines, 'You can go online either way', BG_DISCLOSURE.allow, BG_DISCLOSURE.decline]) {
      expect(SCREEN).not.toContain(words);
    }
  });

  it('still says the two things the Play policy looks for, and that refusing works', () => {
    expect(BG_DISCLOSURE.body).toContain('even when the app is closed or not in use');
    expect(BG_DISCLOSURE.caption).toContain('You can go online either way');
  });
});
