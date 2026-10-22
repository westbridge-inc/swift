import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { noDriverView } from './taxiNoDriver';

// [TAXI-FLOW 22 Oct 2026] "Finding you a driver" forever is a lie once the
// search has come back empty. The ride screen says so from the SERVER's facts
// (noDriverFound / searchReleaseAt on GET /rides/active), not only from a live
// socket event that a reopened app never saw.

const NOW = Date.parse('2026-10-22T16:20:00Z');
const RELEASE = '2026-10-22T16:42:00.000Z';

describe('noDriverView', () => {
  it('stays quiet while the first search is still running', () => {
    expect(noDriverView({ status: 'PENDING', driver: null, noDriverFound: false, searchReleaseAt: RELEASE }, false, NOW)).toBeNull();
    expect(noDriverView({ status: 'PENDING', driver: null }, false, NOW)).toBeNull();
  });

  it('a reopened app (no socket event) still shows the honest card from the server fact, with the release time', () => {
    const v = noDriverView({ status: 'PENDING', driver: null, noDriverFound: true, searchReleaseAt: RELEASE }, false, NOW);
    expect(v?.title).toBe('No driver has taken your ride yet');
    expect(v?.body).toMatch(/every minute/);
    expect(v?.body).toMatch(/If none takes it by .+, the request ends on its own/);
  });

  it('the live socket event alone still raises it on an older API (no new keys)', () => {
    const v = noDriverView({ status: 'PENDING', driver: null }, true, NOW);
    expect(v?.title).toBe('No driver has taken your ride yet');
    expect(v?.body).not.toMatch(/by /);
  });

  it('never promises a release time that is missing, unparseable or already past', () => {
    for (const searchReleaseAt of [null, 'not-a-date', '2026-10-22T16:00:00.000Z']) {
      const v = noDriverView({ status: 'PENDING', driver: null, noDriverFound: true, searchReleaseAt }, false, NOW);
      expect(v?.body).not.toMatch(/If none takes it by/);
    }
  });

  it('is gone the moment a driver is on it, or the ride is no longer waiting', () => {
    expect(noDriverView({ status: 'PENDING', driver: { id: 'd' }, noDriverFound: true }, true, NOW)).toBeNull();
    expect(noDriverView({ status: 'DRIVER_ASSIGNED', driver: null, noDriverFound: true }, true, NOW)).toBeNull();
    expect(noDriverView(null, true, NOW)).toBeNull();
  });
});

describe('the ride screen renders it', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const TAXI = strip(readFileSync(new URL('../modules/movement/screens/TaxiScreen.tsx', import.meta.url), 'utf8'));

  it('reads the view from the server facts and the socket event together', () => {
    expect(TAXI).toMatch(/import \{[^}]*\bnoDriverView\b[^}]*\} from '\.\.\/\.\.\/\.\.\/lib\/taxiNoDriver'/);
    expect(TAXI).toMatch(/noDriverView\(ride, exhausted, nowTs\)/);
    expect(TAXI).toMatch(/\{noDriver\.title\}/);
    expect(TAXI).toMatch(/\{noDriver\.body\}/);
  });
});
