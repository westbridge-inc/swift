import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * WS-2.1 — THE LAST FOUR PRIMITIVES.
 *
 * Wave 3 rebuilds 50 screens by ASSEMBLING them from the kit rather than
 * inventing them, so a missing primitive is not a gap in a component library —
 * it is a guarantee that 50 screens will each invent the same thing slightly
 * differently. These four were the remainder:
 *
 *   Timeline    vertical order progress — was inline on DeliveryScreen
 *   StatusRail  the SAME component laid across — was a separate inline stepper
 *   Sheet       generalized from RideSheet, which nothing adopted
 *   PhotoDrop   the vendor-side "add a photo" control
 *
 * These assertions are structural rather than rendered: the mobile suite has no
 * renderer, so what is graded is the contract each primitive must keep — the
 * things that would silently rot if only a screenshot watched them.
 */

const KIT = join(process.cwd(), 'src/kit');
const read = (f: string) => readFileSync(join(KIT, f), 'utf8');

/** Comments stripped — they necessarily quote the values under test. */
function code(file: string): string {
  return read(file)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');
}

describe('all four primitives exist and are exported from the kit', () => {
  it('the kit index exports them', () => {
    const index = code('index.ts');
    for (const mod of ['./timeline', './photo-drop', './sheet']) {
      expect(index, `${mod} must be exported — an unexported primitive is invisible to a screen`).toContain(mod);
    }
  });

  it('each names its export', () => {
    expect(code('timeline.tsx')).toMatch(/export function Timeline\(/);
    expect(code('timeline.tsx')).toMatch(/export function StatusRail\(/);
    expect(code('sheet.tsx')).toMatch(/export function Sheet\(/);
    expect(code('photo-drop.tsx')).toMatch(/export function PhotoDrop\(/);
  });
});

describe('Timeline and StatusRail are ONE truth, two orientations', () => {
  it('StatusRail delegates to Timeline rather than redrawing it', () => {
    // The whole point of the pairing. Two implementations of "where is this in
    // its journey" is what WS-2 asked to end — the horizontal one existed as a
    // separate inline stepper on the cockpit.
    const src = code('timeline.tsx');
    expect(src).toMatch(/export function StatusRail[\s\S]{0,220}<Timeline[\s\S]{0,80}orientation="horizontal"/);
  });

  it('both orientations resolve state through the same function', () => {
    // If each branch decided "done" for itself they would disagree the first
    // time the rule got interesting.
    const src = code('timeline.tsx');
    const resolveCalls = src.match(/resolveState\(/g) ?? [];
    expect(resolveCalls.length, 'one resolver, called by both renderers').toBeGreaterThanOrEqual(3);
  });

  it('both orientations produce the same accessible sentence', () => {
    // A screen reader must hear the same thing whichever way the rail is laid.
    const src = code('timeline.tsx');
    const labelCalls = src.match(/stepLabel\(/g) ?? [];
    expect(labelCalls.length, 'one label builder, used by both renderers').toBeGreaterThanOrEqual(3);
  });

  it('the caller owns step state — the primitive never reads a status string', () => {
    // DeliveryScreen's real rule is not ordinal: rider dispatch runs alongside
    // kitchen prep, so a rider status must not tick off "Preparing" unless a
    // server prep fact did. A primitive that inferred state from a status would
    // silently overrule that.
    const src = code('timeline.tsx');
    expect(src, 'no order-status vocabulary belongs in a layout primitive').not.toMatch(
      /READY_FOR_PICKUP|PICKED_UP|EN_ROUTE|DELIVERED|RIDER_/,
    );
    expect(src, 'state comes in, it is not derived').toMatch(/state\?:\s*TimelineStepState/);
  });

  it('an unknown position never renders as a finished journey', () => {
    // `currentIndex == null` means "we do not know". Defaulting that to done
    // would tell someone their order had completed because a fetch failed.
    expect(code('timeline.tsx')).toMatch(/if \(currentIndex == null\) return index === 0 \? 'current' : 'upcoming';/);
  });

  it('a missing timestamp draws no clock', () => {
    expect(code('timeline.tsx')).toMatch(/if \(!value\) return null;/);
  });
});

describe('Sheet is the generalized one, and RideSheet is a tombstone', () => {
  it('uses the sheet radius, not the card radius', () => {
    // 28, not the card's 20 — at card radius a sheet reads as a tall card
    // rather than a surface that came from the bottom edge.
    const src = code('sheet.tsx');
    expect(src).toMatch(/borderTopLeftRadius: radius\.sheet/);
    expect(src).toMatch(/borderTopRightRadius: radius\.sheet/);
  });

  it('the brand header is OPTIONAL and off by default', () => {
    // Maroon at the top of a sheet claims "this is the moment", and most sheets
    // are not. Two maroon elements per screen is the law; a header spends one.
    const src = code('sheet.tsx');
    expect(src).toMatch(/backgroundColor: title \? color\.brand\[500\] : color\.surface\.base/);
    expect(src, 'title has no default — a sheet is plain unless asked').not.toMatch(/title\s*=\s*['"]/);
  });

  it('the grab handle stays visible on either ground', () => {
    expect(code('sheet.tsx')).toMatch(/handleIndicatorStyle=\{\{ backgroundColor: title \?/);
  });

  it('RideSheet is an alias, not a second implementation', () => {
    const src = code('ride-sheet.tsx');
    expect(src).toMatch(/export \{ Sheet as RideSheet/);
    expect(src, 'the old sheet must not still hold its own snap points').not.toMatch(/BottomSheet/);
  });
});

describe('PhotoDrop is a control, not a state', () => {
  it('is pressable and dashed — the invitation, not the absence', () => {
    // Its customer-facing sibling PhotoPlaceholder answers the opposite
    // question ("there is no photo") for someone who cannot fix it, and is
    // deliberately filled and inert.
    const src = code('photo-drop.tsx');
    expect(src).toMatch(/<Pressable/);
    expect(src).toMatch(/borderStyle: 'dashed'/);
  });

  it('never claims an upload it cannot see', () => {
    // `uploading` is the caller's fact. A primitive that flipped to "done" on
    // press would be a fake success on a vendor's own dashboard.
    const src = code('photo-drop.tsx');
    expect(src).toMatch(/uploading\s*=\s*false/);
    expect(src, 'no internal success state').not.toMatch(/useState/);
  });

  it('a failed upload keeps the control, so retry is one tap', () => {
    const src = code('photo-drop.tsx');
    expect(src).toMatch(/Upload failed — tap to retry/);
  });

  it('the hint and the error reach a screen reader', () => {
    expect(code('photo-drop.tsx')).toMatch(/accessibilityLabel=\{\[label, hint, error\]\.filter\(Boolean\)\.join/);
  });

  it('is disabled while uploading, and says so', () => {
    const src = code('photo-drop.tsx');
    expect(src).toMatch(/accessibilityState=\{\{ disabled: blocked, busy: uploading \}\}/);
  });
});

describe('JourneyRail is reconciled, not duplicated', () => {
  it('still exists and still draws an A→B pair', () => {
    // WS-2 said "reconcile or supersede with a tombstone". It is NOT a
    // duplicate: a route has two ends, a timeline has N steps and a position
    // within them. Keeping both is the reconciliation; this pins the boundary
    // so the next person does not merge two different ideas.
    const src = code('journey-rail.tsx');
    expect(src).toMatch(/export function JourneyRail\(/);
    expect(src).toMatch(/start/);
    expect(src).toMatch(/end/);
  });

  it('does not grow a step list', () => {
    // The moment JourneyRail takes an array of steps it has become Timeline.
    expect(code('journey-rail.tsx'), 'a rail with steps is a Timeline — use that').not.toMatch(/steps/);
  });
});
