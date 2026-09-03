import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Freshness } from './live-tracking';
import {
  COARSE_DECIMALS,
  STALE_AFTER_MS,
  VERY_STALE_AFTER_MS,
  coarsen,
  createSequence,
  freshness,
  mapEmbedUrl,
  mapLinkUrl,
  validPoint,
} from './live-tracking';

// ---------------------------------------------------------------------------
// [W-47] The two public tracking pages are links handed to someone outside the
// app: a recipient watching a parcel, and whoever a passenger sent their ride
// to. Both claimed more than they knew.
//
// The age froze (it was derived from a value that only changed on a SUCCESSFUL
// poll, so an outage left "Updated 4s ago" on screen indefinitely); it measured
// the client's fetch rather than the position; responses could arrive out of
// order and move the courier backwards; and the exact coordinates of a live
// person went to a third-party tile server on every map load, with a referer
// naming the token that was watching.
// ---------------------------------------------------------------------------

/**
 * Narrow away `none`. Every case below has a position, so the label and the age
 * are present; `tsc` cannot know that from the union without being told, and it
 * type-checks this file even though vitest does not.
 */
function timed(f: Freshness): Extract<Freshness, { label: string }> {
  if (f.kind === 'none') throw new Error('expected a timed freshness, got none');
  return f;
}

describe('[W-47] a point is validated before it is believed', () => {
  it('accepts a real point', () => {
    expect(validPoint(6.8013, -58.1551)).toEqual({ lat: 6.8013, lng: -58.1551 });
    expect(validPoint(-33.86, 151.2)).toEqual({ lat: -33.86, lng: 151.2 });
  });

  it.each([
    [undefined, undefined],
    [null, null],
    [6.8, null],
    [null, -58.1],
    ['6.8', '-58.1'],
    [NaN, -58.1],
    [6.8, Infinity],
    [91, 0],
    [-91, 0],
    [0, 181],
    [0, -181],
    [0, 0], // a missing fix, not a place
  ])('refuses (%o, %o)', (lat, lng) => {
    expect(validPoint(lat as unknown, lng as unknown)).toBeNull();
  });
});

describe('[W-47] the age is the POSITION’s, and it keeps advancing', () => {
  const at = 1_700_000_000_000;

  it('is fresh, then stale, then lost — driven by the clock, not by a poll', () => {
    expect(freshness(at, at).kind).toBe('fresh');
    expect(timed(freshness(at, at + 2_000)).label).toBe('Updated just now');
    expect(timed(freshness(at, at + 10_000)).label).toBe('Updated 10s ago');
    expect(freshness(at, at + STALE_AFTER_MS).kind).toBe('stale');
    expect(timed(freshness(at, at + STALE_AFTER_MS)).label).toMatch(/Not updating/);
    expect(freshness(at, at + VERY_STALE_AFTER_MS).kind).toBe('lost');
    expect(timed(freshness(at, at + VERY_STALE_AFTER_MS)).label).toMatch(/may not be where they are now/);
  });

  it('the frozen-clock defect: with no poll for two minutes the label must NOT still read fresh', () => {
    // the old page derived the age from a value that only changed on success,
    // so this is exactly the case that kept saying "Updated 4s ago"
    const twoMinutesLater = timed(freshness(at, at + 120_000));
    expect(twoMinutesLater.kind).not.toBe('fresh');
    expect(twoMinutesLater.label).not.toMatch(/just now/);
  });

  it('says nothing at all when there is no position', () => {
    expect(freshness(null, at)).toEqual({ kind: 'none' });
  });

  it('never reports a negative age when a clock disagrees', () => {
    expect(timed(freshness(at, at - 60_000)).ageSeconds).toBe(0);
  });
});

describe('[W-47] an older response can never overwrite a newer one', () => {
  it('applies the newest and refuses a straggler', () => {
    const seq = createSequence();
    const first = seq.next();
    const second = seq.next();
    expect(seq.accept(second)).toBe(true);
    expect(seq.accept(first)).toBe(false); // the slow one lands late and is dropped
  });

  it('refuses a duplicate application of the same response', () => {
    const seq = createSequence();
    const only = seq.next();
    expect(seq.accept(only)).toBe(true);
    expect(seq.accept(only)).toBe(false);
  });
});

describe('[W-47] a third party never receives the precise position', () => {
  const precise = { lat: 6.801347, lng: -58.155198 };

  it('coarsens to about 110 m', () => {
    expect(coarsen(precise)).toEqual({ lat: 6.801, lng: -58.155 });
    expect(COARSE_DECIMALS).toBe(3);
  });

  it('neither map URL carries the precise point', () => {
    for (const url of [mapEmbedUrl(precise), mapLinkUrl(precise)]) {
      expect(url).not.toContain('6.801347');
      expect(url).not.toContain('-58.155198');
      expect(url).toContain('6.801');
    }
  });
});

describe('[W-47] both public pages use it', () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
  const pages = {
    parcel: source('src/app/track/[token]/track-client.tsx'),
    trip: source('src/app/trip/[token]/trip-share-client.tsx'),
  };

  for (const [name, page] of Object.entries(pages)) {
    it(`the ${name} page ages the position on its own clock, not on a successful poll`, () => {
      expect(page).toMatch(/freshness\(positionAt, now\)/);
      expect(page).toMatch(/setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/);
      // the old shape
      expect(page).not.toMatch(/const ageSeconds = fetchedAt/);
    });

    it(`the ${name} page reads the server's own timestamp`, () => {
      expect(page).toMatch(/Date\.parse\(/);
      expect(page).toMatch(/serverTimed/);
    });

    it(`the ${name} page drops an out-of-order response`, () => {
      expect(page).toMatch(/sequence\.current\.next\(\)/);
      expect(page.match(/sequence\.current\.accept\(seq\)/g) ?? []).not.toHaveLength(0);
    });

    it(`the ${name} page sends only a coarsened point, with no referer`, () => {
      expect(page).toMatch(/mapEmbedUrl\(/);
      expect(page).toMatch(/mapLinkUrl\(/);
      expect(page.match(/referrerPolicy="no-referrer"/g) ?? []).toHaveLength(2);
      // no hand-built OpenStreetMap URL carrying raw coordinates
      expect(page).not.toMatch(/openstreetmap\.org\/export\/embed\.html\?bbox=\$\{/);
      expect(page).not.toMatch(/openstreetmap\.org\/\?mlat=\$\{/);
    });

    it(`the ${name} page validates the point and hides the map once the position is lost`, () => {
      expect(page).toMatch(/validPoint\(/);
      expect(page).toMatch(/age\.kind !== 'lost'/);
    });

    it(`the ${name} page announces freshness to a screen reader`, () => {
      expect(page).toMatch(/aria-live="polite"/);
    });
  }
});
