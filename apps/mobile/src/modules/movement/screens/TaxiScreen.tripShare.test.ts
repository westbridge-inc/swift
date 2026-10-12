import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [MASTER-031] The rider's trip-share links outlive the screen that minted
// them. A link minted, then an app reload, used to leave the rider with no way
// to see or stop it: the only copy of the token lived in component state. The
// controls now read the rider's OWN live links from the server (by ride, never
// a recovered bearer token) and stop every one of them at once. The screen
// imports maps and native modules Vitest cannot load, so this reads it as
// source (the repo's screen-test pattern, see TaxiScreen.signedOut.test.ts).
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SRC = strip(readFileSync(new URL('./TaxiScreen.tsx', import.meta.url), 'utf8'));
const API = strip(readFileSync(new URL('../../../services/api.ts', import.meta.url), 'utf8'));

const activeRide = () => {
  const start = SRC.indexOf('function ActiveRide(');
  expect(start, 'the active-ride screen exists').toBeGreaterThan(-1);
  return SRC.slice(start);
};

describe('[MASTER-031] trip-share owner controls survive a reload', () => {
  it('the API client lists and stops links by ride, never by a stored token', () => {
    expect(API).toMatch(/tripShares: \(orderId: string\) => api\.get\(`\/safety\/trips\/\$\{orderId\}\/shares`\)/);
    expect(API).toMatch(/revokeAllTripShares: \(orderId: string\) => api\.delete\(`\/safety\/trips\/\$\{orderId\}\/shares`\)/);
  });

  it('the screen loads the rider\'s live links from the server, keyed by rider and ride', () => {
    const screen = activeRide();
    expect(screen).toMatch(/queryKey: sharesKey/);
    expect(screen).toMatch(/const sharesKey = \['trip-shares', shareOwner, ride\.id\]/);
    expect(screen).toMatch(/safetyApi\.tripShares\(ride\.id\)/);
  });

  it('"Stop all sharing" stops every link for the ride and refreshes the list', () => {
    const screen = activeRide();
    expect(screen).toMatch(/mutationFn: \(\) => safetyApi\.revokeAllTripShares\(ride\.id\)/);
    const onSuccess = screen.slice(screen.indexOf('safetyApi.revokeAllTripShares(ride.id)'));
    expect(onSuccess.slice(0, 400)).toMatch(/invalidateQueries\(\{ queryKey: sharesKey \}\)/);
    expect(screen).toMatch(/label="Stop all sharing"/);
    expect(screen).toMatch(/onPress=\{\(\) => revokeMutation\.mutate\(\)\}/);
    // the old control could only stop the one token held in memory
    expect(screen).not.toMatch(/revokeTripShare\(/);
  });

  it('after a reload the stop control appears for links the server still holds', () => {
    const screen = activeRide();
    // shown for a link minted in this session OR one the server lists
    expect(screen).toMatch(/\{activeShare \|\| ownedShares\.data\?\.length \? \(/);
  });

  it('minting a link refreshes the server list', () => {
    const screen = activeRide();
    const mint = screen.slice(screen.indexOf('const shareTrip = () =>'));
    expect(mint.slice(0, 500)).toMatch(/invalidateQueries\(\{ queryKey: sharesKey \}\)/);
  });
});
