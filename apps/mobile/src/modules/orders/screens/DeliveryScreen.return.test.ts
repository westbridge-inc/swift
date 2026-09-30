import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [E17 · DS231 F2/F3] The sender's tracking screen on a parcel coming back.
//
// The server made the return leg live-trackable and RETURNED terminal, but
// this screen kept its forward-only lists: the sender was told "Returning to
// you" with no rider on the map (the seeded fix was cleared and socket fixes
// refused), and a returned parcel still showed the live-rider card, the
// tracking link and cancel. Read as source, like the sibling screen tests:
// the screen imports react-native, which Vitest cannot load.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREEN = strip(readFileSync(new URL('./DeliveryScreen.tsx', import.meta.url), 'utf8'));
const block = (start: RegExp, end: RegExp) => {
  const from = SCREEN.search(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const rest = SCREEN.slice(from);
  return rest.slice(0, rest.search(end));
};

describe('the return leg is tracked like the forward leg', () => {
  it('RETURNING is a live-tracking status', () => {
    expect(block(/const LIVE_TRACKING_STATUSES = new Set\(\[/, /\]\);/)).toMatch(/'RETURNING'/);
  });

  it('RETURNING shows the travel step, relabelled for the way back', () => {
    expect(block(/function timelineIndex\(/, /\n}\n/)).toMatch(/courier && status === 'RETURNING'\) return 3;/);
    expect(SCREEN).toMatch(/transitLabel = 'Coming back to you';/);
  });
});

describe('a returned parcel is over', () => {
  it('RETURNED is a terminal snapshot', () => {
    expect(block(/function isTerminalOrderSnapshot\(/, /\n}\n/)).toMatch(/'RETURNED'/);
  });

  it('the screen treats RETURNED as terminal, so no live-rider controls, tracking link or cancel remain', () => {
    expect(SCREEN).toMatch(/const returned = o\.status === 'RETURNED';/);
    expect(SCREEN).toMatch(/const terminal = cancelled \|\| failed \|\| complete \|\| returned;/);
  });

  it('[DS236 F3-R2] no forward countdown or delivery promise on a parcel going back, or back', () => {
    expect(SCREEN).toMatch(/else if \(returned\) etaCopy = 'Returned to you';/);
    expect(SCREEN).toMatch(/else if \(orderStatus === 'RETURNING'\) etaCopy = 'Coming back to you';/);
    // Both return copies come before the stale creation-time estimate can.
    const eta = block(/let etaCopy = pendingSummary;/, /\n\n/);
    expect(eta.indexOf("'Coming back to you'")).toBeLessThan(eta.indexOf('Server estimate'));
    expect(SCREEN).toMatch(/!complete && !returned && orderStatus !== 'RETURNING' \? promiseLine\(/);
  });

  it('RETURNED has no forward-timeline step (the timeline would promise a delivery)', () => {
    expect(block(/function timelineIndex\(/, /\n}\n/)).not.toMatch(/RETURNED/);
  });
});
