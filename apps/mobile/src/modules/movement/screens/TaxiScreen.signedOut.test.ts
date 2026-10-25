import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [Q4] "Taxi is loading forever": on staging the owner's phone, signed out
// mid-session, polled /rides/active, /supply, /availability, /presence and
// /queue into 401s for a minute. Every ride read needs an account, so the
// exported screen must check the session BEFORE any ride hook mounts. The
// screen imports maps and native modules Vitest cannot load, so this reads it
// as source (the repo's screen-test pattern).
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SRC = strip(readFileSync(new URL('./TaxiScreen.tsx', import.meta.url), 'utf8'));
const RIDE_HOOKS = ['useActiveRide', 'useRideSupply', 'useRideAvailability', 'useRidePresence', 'useQueueStatus', 'useRideEstimate'];
/** A call of the hook, with or without a type argument: useActiveRide(…) or useActiveRide<any>(…). */
const callOf = (hook: string) => new RegExp(`\\b${hook}(<[^>]*>)?\\(`);

const gate = () => {
  const start = SRC.indexOf('export function TaxiScreen(');
  const end = SRC.indexOf('function TaxiBooking(');
  expect(start, 'the exported TaxiScreen exists').toBeGreaterThan(-1);
  expect(end, 'the booking screen sits behind it').toBeGreaterThan(start);
  return SRC.slice(start, end);
};

describe('[Q4] the taxi screen checks the session before any ride read', () => {
  it('a visitor with no session gets the sign-in door', () => {
    // Signing in from the door resumes Taxi (the auth continuation), never a bare
    // promptLogin that would land the rider on Home [DS256 F1].
    expect(gate()).toMatch(/if \(!isAuthenticated\) return <TaxiSignedOut navigation=\{props\.navigation\} onSignIn=\{\(\) => signInForTaxi\(promptLogin\)\} \/>;/);
  });

  it('the door is decided before the booking screen mounts', () => {
    const g = gate();
    expect(g.indexOf('<TaxiSignedOut')).toBeLessThan(g.indexOf('<TaxiBooking'));
  });

  it('no ride hook runs in the gate: a signed-out visitor fires no ride request', () => {
    const g = gate();
    for (const hook of RIDE_HOOKS) expect(g, `${hook} must not run before the session check`).not.toMatch(callOf(hook));
  });

  it('the door itself reads no ride data: no hooks module, no API client, no query [DS256 F3]', () => {
    const door = strip(readFileSync(new URL('../TaxiSignedOut.tsx', import.meta.url), 'utf8'));
    expect(door).not.toMatch(/from '[^']*hooks[^']*'/);
    expect(door).not.toMatch(/from '[^']*services\/api'/);
    expect(door).not.toMatch(/@tanstack\/react-query/);
    for (const hook of RIDE_HOOKS) expect(door).not.toMatch(callOf(hook));
  });

  it('every ride hook still lives in the booking screen, unchanged for a signed-in rider', () => {
    const booking = SRC.slice(SRC.indexOf('function TaxiBooking('));
    for (const hook of RIDE_HOOKS) expect(booking, `${hook} stays in the booking screen`).toMatch(callOf(hook));
  });
});
