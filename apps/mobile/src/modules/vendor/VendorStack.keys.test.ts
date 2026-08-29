import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Found by running the vendor dashboard on a physical iPhone:
//
//   ERROR  Encountered two children with the same key, `pv-store`.
//
// VendorWentLiveLayer and VendorLiveOrderLayer are SIBLINGS in one fragment and
// both were keyed on the bare `store.id`. That collides on every vendor session,
// not only in preview — the sample data simply gave the id a memorable name.
//
// This is not cosmetic. Both keys are load-bearing by their own comments: the
// keying is what forces a remount on a store switch, so that an ordinary A→B
// switch cannot masquerade as B's approval moment, and so queued alerts are
// cleared during a handoff. React's documented response to duplicate sibling
// keys is that children "may be duplicated and/or omitted" and the behaviour is
// unsupported — which is the remount those comments depend on, left to chance.
// ---------------------------------------------------------------------------

const SRC = readFileSync(new URL('./VendorStack.tsx', import.meta.url), 'utf8');

function keyOf(component: string): string {
  const m = SRC.match(new RegExp(`<${component}\\s+key=\\{([^}]+)\\}`));
  if (!m) throw new Error(`${component} is not rendered with an explicit key`);
  return m[1]!;
}

describe('the two always-mounted store layers are keyed apart', () => {
  it('VendorWentLiveLayer and VendorLiveOrderLayer do not share a key', () => {
    expect(keyOf('VendorWentLiveLayer')).not.toBe(keyOf('VendorLiveOrderLayer'));
  });

  it('each key still varies with the store, so a switch still remounts', () => {
    // Making the keys unique by hardcoding two constants would silence the
    // warning and quietly delete the behaviour the keys exist for.
    for (const c of ['VendorWentLiveLayer', 'VendorLiveOrderLayer']) {
      expect(keyOf(c)).toContain('store.id');
    }
  });
});
