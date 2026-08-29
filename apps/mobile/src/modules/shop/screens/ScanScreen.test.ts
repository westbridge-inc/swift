import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { destinationForUrl } from '../../../lib/deepLinkParse';

// ---------------------------------------------------------------------------
// The in-app scanner [SCAN-1].
//
// Its whole design claim is that it OWNS NO RULES: a scanned code and a tapped
// link are the same question, so they go through the same parser and the same
// resolver. A second opinion here is how a retired code comes to mean one thing
// when tapped and another when scanned.
//
// The other risk is invisible to a typecheck: onBarcodeScanned fires many times
// a second while a code sits in frame. Without a latch, one scan becomes dozens
// of resolves and dozens of APP_OPEN funnel events — the analytics the vendor
// dashboard shows would be inflated by however long someone held the phone.
// ---------------------------------------------------------------------------

const SRC = readFileSync(new URL('./ScanScreen.tsx', import.meta.url), 'utf8');
const STRIPPED = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the scanner reuses the link machinery rather than forking it', () => {
  it('parses with the SAME pure parser a universal link uses', () => {
    expect(STRIPPED).toContain("from '../../../lib/deepLinkParse'");
    expect(STRIPPED).toContain('destinationForUrl(');
  });

  it('resolves with the SAME resolver, so a retired code means one thing', () => {
    expect(STRIPPED).toContain("from '../../../services/deep-links'");
    expect(STRIPPED).toContain('resolveDestination(');
  });

  it('never calls the QR endpoints directly — that is the resolver’s job', () => {
    // A direct call here would bypass the APP_OPEN report and the verdict
    // mapping, and would be the second opinion this screen exists without.
    expect(STRIPPED).not.toContain('/public/qr/');
    expect(STRIPPED).not.toMatch(/api\.(get|post)\(/);
  });
});

describe('one scan is one resolve', () => {
  it('latches before awaiting, so a held code cannot fire repeatedly', () => {
    // The latch must be set BEFORE the first await. Set after, every frame that
    // arrives during the round-trip starts its own resolve.
    const fn = STRIPPED.slice(STRIPPED.indexOf('const onScanned'), STRIPPED.indexOf('const scanAgain'));
    expect(fn).toContain('if (handling.current) return;');
    const latch = fn.indexOf('handling.current = true');
    const firstAwait = fn.indexOf('await ');
    expect(latch).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(-1);
    expect(latch, 'the latch must be set before the first await').toBeLessThan(firstAwait);
  });

  it('only "Scan again" releases the latch', () => {
    const again = STRIPPED.slice(STRIPPED.indexOf('const scanAgain'), STRIPPED.indexOf('const body'));
    expect(again).toContain('handling.current = false');
  });

  it('does not navigate or set state after the screen is gone', () => {
    // The resolve outlives a back-press; writing state then is a leak warning
    // and navigating is a screen the customer did not ask for.
    expect(STRIPPED).toContain('alive.current');
    expect(STRIPPED).toContain('if (!alive.current) return;');
  });
});

describe('every failure says what happened, and none of them guess', () => {
  it('covers all four outcomes with distinct copy', () => {
    // Every ResolveFailure the resolver can return must have an entry, or the
    // screen renders `undefined` at the exact moment it is explaining a failure.
    for (const k of ["'not-a-swift-code'", 'replaced:', 'unavailable:', 'offline:']) {
      expect(STRIPPED, `${k} must have copy`).toContain(k);
    }
    const titles = [...STRIPPED.matchAll(/title: '([^']+)'/g)].map((m) => m[1]!);
    expect(titles).toHaveLength(4);
    expect(new Set(titles).size, 'each failure needs its own words').toBe(4);
  });

  it('offline is NOT reported as a bad code', () => {
    // The lie this prevents: telling someone holding a perfectly good printed
    // sign that their code is invalid because the network was down.
    expect(STRIPPED).toMatch(/offline: \{[\s\S]*?title: 'No connection'/);
    expect(STRIPPED).toMatch(/offline: \{[\s\S]*?The code may be fine/);
  });

  it('does not repeat the reason the server deliberately withholds', () => {
    // UNAVAILABLE_PAGE collapses "no such entity" and "not publicly live" so the
    // endpoint cannot enumerate stores. Naming either here would undo that.
    const unavailable = STRIPPED.slice(STRIPPED.indexOf('unavailable: {'), STRIPPED.indexOf('offline: {'));
    expect(unavailable).not.toMatch(/deleted|does not exist|no such|not live|hidden/i);
  });
});

describe('the codes it must accept are the codes vendors print', () => {
  it('a printed short link resolves to a short-code destination', () => {
    const d = destinationForUrl('https://swift.gy/s/BCDFGHJKMN');
    expect(d).toEqual({ kind: 'short', code: 'BCDFGHJKMN' });
  });

  it('a storefront link with an attribution code carries the code through', () => {
    const d = destinationForUrl('https://swift.gy/store/georgetown-grill?src=qr&c=BCDFGHJKMN');
    expect(d).toEqual({ kind: 'store', slug: 'georgetown-grill', code: 'BCDFGHJKMN' });
  });

  it('someone else’s QR is not ours, and is not a crash', () => {
    expect(destinationForUrl('https://example.com/promo')).toBeNull();
    expect(destinationForUrl('WIFI:S=cafe;T=WPA;P=hunter2;;')).toBeNull();
    expect(destinationForUrl('')).toBeNull();
  });
});
