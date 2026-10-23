import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isConfirmedStoreSwitch, shownStoreOpen, withStoreSwitchAnswer } from './storeOpenSwitch';

// ---------------------------------------------------------------------------
// [PERF row 562] The phone's "Store open" switch moves at the tap. Since #1949
// the phone sends the state the store should END in, so the tapped state is
// safe to show early; it stays locked until the server answers and goes back
// (with the server's words) if the server refuses.
// ---------------------------------------------------------------------------

describe('[PERF row 562] what the Store-open switch shows', () => {
  it('while the request is out: the state just tapped, either way', () => {
    expect(shownStoreOpen(false, true, true)).toBe(true);
    expect(shownStoreOpen(true, true, false)).toBe(false);
  });

  it('otherwise (answered, refused, or never tapped): the server\'s state', () => {
    expect(shownStoreOpen(true, false, false)).toBe(true); // refused: back to what the server holds
    expect(shownStoreOpen(false, false, true)).toBe(false);
    expect(shownStoreOpen(false, false, undefined)).toBe(false);
  });

  it('a request with no tapped state (a sample preview\'s no-op) never invents one', () => {
    expect(shownStoreOpen(true, true, undefined)).toBe(true);
    expect(shownStoreOpen(false, true, 'yes')).toBe(false);
  });
});

describe('[PERF row 562] the server\'s answer goes into the store it was for', () => {
  const owner = { myRole: 'OWNER', vendors: [{ id: 'a', name: 'A', isCurrentlyOpen: true, acceptingOrders: false }, { id: 'b', name: 'B', isCurrentlyOpen: false, acceptingOrders: false }] };

  it('only an answer with both flags counts', () => {
    expect(isConfirmedStoreSwitch({ isCurrentlyOpen: true, acceptingOrders: false })).toBe(true);
    expect(isConfirmedStoreSwitch({ isCurrentlyOpen: true })).toBe(false);
    expect(isConfirmedStoreSwitch({ isCurrentlyOpen: 'true', acceptingOrders: true })).toBe(false);
    expect(isConfirmedStoreSwitch(null)).toBe(false);
  });

  it('writes both flags into that store and nothing else', () => {
    expect(withStoreSwitchAnswer(owner, 'b', { isCurrentlyOpen: true, acceptingOrders: true })).toEqual({
      myRole: 'OWNER',
      vendors: [owner.vendors[0], { id: 'b', name: 'B', isCurrentlyOpen: true, acceptingOrders: true }],
    });
    expect(owner.vendors[1]!.isCurrentlyOpen).toBe(false); // the read it came from is not mutated
  });

  it('anything it cannot place comes back as the same object (the caller waits for the re-read)', () => {
    const answer = { isCurrentlyOpen: true, acceptingOrders: true };
    expect(withStoreSwitchAnswer(owner, 'z', answer)).toBe(owner);
    expect(withStoreSwitchAnswer(owner, null, answer)).toBe(owner);
    expect(withStoreSwitchAnswer(owner, 'b', { isCurrentlyOpen: true })).toBe(owner);
    expect(withStoreSwitchAnswer(undefined, 'b', answer)).toBeUndefined();
    expect(withStoreSwitchAnswer({ vendors: 'none' }, 'b', answer)).toEqual({ vendors: 'none' });
  });
});

// The harness has no React Native renderer, so the screen's wiring is pinned
// as a source contract (the shape of reject-reason.test.ts).
describe('[PERF row 562] VendorOps draws the shown state, locked until the answer', () => {
  const screen = readFileSync(join(__dirname, '..', 'modules', 'vendor', 'screens', 'VendorOps.tsx'), 'utf8');

  it('open is the shown state: the tapped one while the request is out', () => {
    expect(screen).toContain('const open = shownStoreOpen(!!store.isCurrentlyOpen, toggleOpen.isPending, toggleOpen.variables);');
    expect(screen).not.toContain('const open = !!store.isCurrentlyOpen;\n  const accepting = !!store.acceptingOrders;\n  const selfDelivery');
  });

  it('the switch, its spoken state, the status words and the header all read it', () => {
    expect(screen).toContain('<AvailabilitySwitch value={!inPreview && open} disabled={inPreview || toggleOpen.isPending}');
    expect(screen).toContain('accessibilityState={{ checked: !inPreview && open, disabled: inPreview || toggleOpen.isPending, busy: toggleOpen.isPending }}');
    expect(screen).toContain("{inPreview ? 'Not open yet' : !open ? 'Store closed' : accepting ? 'Open for orders' : 'Orders paused'}");
    expect(screen).toContain('const status = storeStatusEyebrow({ ...store, isCurrentlyOpen: open }, inPreview);');
  });

  it('a second tap waits for the answer (the switch is locked while the request is out)', () => {
    expect(screen).toContain('disabled={inPreview || toggleOpen.isPending}\n              onPress={() => toggleOpen.mutate(!open)}');
  });

  it('a refusal shows the server\'s own words, else the connection line', () => {
    expect(screen).toContain("{(toggleOpen.error as any)?.response?.data?.error?.message ?? 'Store status didn’t update — check your connection and try again.'}");
  });
});
