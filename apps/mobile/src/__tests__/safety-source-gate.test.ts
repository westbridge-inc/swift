import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [B3] THE SAFETY SOURCE GATE.
//
// The safety engine was shipped complete and sat dark because no surface
// called it — and every surface that later gained a button gained it by
// someone NOTICING. This gate replaces noticing. It fails the build when an
// in-flight surface (a screen where one party is moving toward, or working
// beside, the other) carries no emergency entrance.
//
// Two nets, on purpose:
//  1. A REGISTRY of the known in-flight surfaces — each must still reference
//     its SOS mechanism. Deleting a button turns this red the same day.
//  2. A DISCOVERY sweep — any screen that subscribes to live movement
//     (order room / mover location stream) is an in-flight surface BY
//     CONSTRUCTION and must carry an SOS mechanism or an explicit, reasoned
//     exemption below. A brand-new tracked surface ships covered or not at all.
// ---------------------------------------------------------------------------

const SCREENS_ROOT = join(process.cwd(), 'src', 'modules');

/** The mechanisms that count as "this screen can raise an emergency". */
const SOS_MARKERS = [
  "from '../../../hooks/safety'", // useJobSos / useServiceJobSos
  'useRideSos', // taxi's own /rides/:id/sos path
  // [REPORT-035] The shared LIVE ceremony — raise + confirm + cancel + honest
  // failure states in one component; the canonical entrance going forward.
  'SosCeremony',
] as const;

/** Known in-flight surfaces. Every entry must keep an SOS mechanism. */
const REGISTRY = [
  'orders/screens/DeliveryScreen.tsx',
  'mover/screens/ActiveJobScreen.tsx',
  'movement/screens/TaxiScreen.tsx',
  'services/screens/ServiceJobsScreen.tsx',
] as const;

/** A live-tracking screen that is deliberately allowed to omit SOS. Empty is
 *  the goal state; every entry needs a written reason. */
const EXEMPT: ReadonlyArray<{ path: string; reason: string }> = [];

/** Signals that a screen renders a LIVE in-flight party (not a history list —
 *  status-label constants alone do not qualify). */
const LIVE_SIGNALS = ['subscribeToOrder(', "'driver:location'", "'rider:location'"] as const;

function screenFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return screenFiles(path);
    return path.endsWith('.tsx') && path.includes(`${'screens'}`) ? [path] : [];
  });
}

const hasSos = (source: string) => SOS_MARKERS.some((m) => source.includes(m));

describe('safety source gate [B3]', () => {
  it('every registered in-flight surface still carries its emergency entrance', () => {
    const missing: string[] = [];
    for (const rel of REGISTRY) {
      const source = readFileSync(join(SCREENS_ROOT, rel), 'utf8');
      if (!hasSos(source)) missing.push(rel);
    }
    expect(missing, `These in-flight surfaces lost their SOS mechanism: ${missing.join(', ')}`).toEqual([]);
  });

  it('every screen that tracks a live mover carries an emergency entrance (or a written exemption)', () => {
    const uncovered: string[] = [];
    for (const file of screenFiles(SCREENS_ROOT)) {
      if (!file.includes('/screens/')) continue;
      const source = readFileSync(file, 'utf8');
      const live = LIVE_SIGNALS.some((s) => source.includes(s));
      if (!live) continue;
      const exempt = EXEMPT.some((e) => file.endsWith(e.path));
      if (!exempt && !hasSos(source)) uncovered.push(file.slice(SCREENS_ROOT.length + 1));
    }
    expect(
      uncovered,
      `These screens subscribe to live movement but have no SOS path — wire useJobSos/useServiceJobSos (hooks/safety) or add a REASONED exemption: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it('the exemption list carries a reason for every entry', () => {
    for (const e of EXEMPT) {
      expect(e.reason.trim().length, `Exemption for ${e.path} needs a real reason`).toBeGreaterThan(10);
    }
  });
});
