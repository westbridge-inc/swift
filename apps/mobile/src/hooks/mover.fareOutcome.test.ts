import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [M-29] A cash ride completes through its fare outcome — in the app too.
//
// The server refuses the bare completion tap for a cash ride (a fare is
// earned when the money is recorded). These pin the three seams that make
// the app send the outcome instead, and that nothing offers the old tap:
//
//   client: driverApi.handover posts the outcome + GPS; there is no complete()
//   hook:   the driver's 'handover' action sends the CALLER's outcome (never a
//           default) with the evidence fix; the rider's failed outcomes ride
//           the same seam
//   screen: the RIDE_IN_PROGRESS step is 'handover' with outcome 'paid', and
//           the unpaid sheet names 'refused' and 'no_show' explicitly, on
//           both rails
//
// Comments are stripped first so a phrase in a comment can never satisfy an
// assertion about code (the hazard-matching rule).
// ---------------------------------------------------------------------------

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const HOOKS = strip(readFileSync(new URL('./mover.ts', import.meta.url), 'utf8'));
const API = strip(readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8'));
const SCREEN = strip(readFileSync(new URL('../modules/mover/screens/ActiveJobScreen.tsx', import.meta.url), 'utf8'));

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  expect(to, `anchor not found: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('the stripper', () => {
  it('leaves code behind', () => {
    expect(HOOKS.length).toBeGreaterThan(5_000);
    expect(API.length).toBeGreaterThan(5_000);
    expect(SCREEN.length).toBeGreaterThan(5_000);
    expect(HOOKS).toContain('export function useDriverAction');
  });
});

describe('the client', () => {
  const driverApi = body(API, 'export const driverApi', '\n};');
  it('posts the fare outcome with GPS to the ride handover route, and no longer offers the bare completion', () => {
    expect(driverApi).toContain('`/driver/rides/${id}/handover`');
    expect(driverApi).toContain("outcome: 'paid' | 'no_show' | 'refused'");
    expect(driverApi).not.toContain('/complete`');
    expect(API).not.toContain('driverApi.complete');
  });
});

describe('the driver action', () => {
  const hook = body(HOOKS, 'export function useDriverAction', 'export type RiderAction');
  it("sends the caller's outcome — never a default — with the evidence fix, under the auth principal", () => {
    expect(hook).toContain('driverApi.handover(id, { outcome: input.outcome, gps }, current)');
    expect(hook).toContain('evidenceFix(owner)');
    expect(hook).toContain('requireAuthSessionForPrincipal(owner)');
    expect(hook).not.toContain("outcome ?? 'paid'");
    expect(hook).not.toContain('driverApi.complete');
  });
  it('the outcome is a required field of the handover input, not an optional flag', () => {
    expect(HOOKS).toContain("| { id: string; action: 'handover'; outcome: FareOutcome }");
  });
  it('the evidence fix falls back to a fresh position when no last-known fix exists', () => {
    const fix = body(HOOKS, 'async function evidenceFix', 'export function useDriverAction');
    expect(fix).toContain('Location.getLastKnownPositionAsync()');
    expect(fix).toContain('Location.getCurrentPositionAsync(');
  });
});

describe('the rider action', () => {
  const hook = body(HOOKS, 'export function useRiderAction', '\n}\n');
  it('the door handover rides the same seam and accepts the failed outcomes explicitly', () => {
    expect(hook).toContain("riderApi.handover(id, { outcome: outcome ?? 'paid', gps }, current)");
    expect(hook).toContain('evidenceFix(owner)');
  });
});

describe('the screen', () => {
  it('the passenger-aboard step is the fare outcome, never a bare completion', () => {
    const step = body(SCREEN, 'function driverStep', '\n}\n');
    expect(step).toContain("if (s === 'RIDE_IN_PROGRESS') return { label: 'Fare collected — complete trip', action: 'handover' }");
    expect(step).not.toContain("'complete'");
    expect(SCREEN).not.toContain("action: 'complete'");
  });
  it("the step's own outcome is 'paid'; the unpaid sheet names the two failed outcomes on both rails", () => {
    const run = body(SCREEN, 'const runDriverStep', 'const recordUnpaid');
    expect(run).toContain("action: 'handover' as const, outcome: 'paid' as const");
    expect(SCREEN).toContain("recordUnpaid('refused')");
    expect(SCREEN).toContain("recordUnpaid('no_show')");
    const record = body(SCREEN, 'const recordUnpaid', 'const closeRating');
    expect(record).toContain("driverAct.mutate({ id: job.id, action: 'handover', outcome }");
    expect(record).toContain("riderAct.mutate({ id: job.id, action: 'handover', outcome }");
  });
  it('both rails offer the unpaid sheet next to the paid step', () => {
    expect(SCREEN).toContain('label="Passenger didn\'t pay"');
    expect(SCREEN).toContain('label="Customer didn\'t pay"');
  });
});
