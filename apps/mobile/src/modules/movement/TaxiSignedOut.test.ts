import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [Q4] The taxi door for a visitor with no session. Rendered with the kit and
// react-native stubbed (see kit/cart-bar.test.ts): it names what taxi needs,
// offers exactly one way in, and a way back.
// ---------------------------------------------------------------------------

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));
vi.mock('@swift/ui', () => ({
  color: { surface: { subtle: '#subtle' } },
  space: { sm: 8, '2xl': 24, '3xl': 32 },
}));
vi.mock('../../kit', () => ({ CircleChip: 'CircleChip', EmptyState: 'EmptyState' }));

import { TaxiSignedOut } from './TaxiSignedOut';

type El = ReactElement<Record<string, any>, string>;

function flatten(node: any, out: El[] = []): El[] {
  if (node == null || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return out;
  }
  out.push(node);
  flatten(node.props?.children, out);
  return out;
}

describe('[Q4] a signed-out visitor meets a sign-in door, not a spinner', () => {
  it('says what taxi needs and its one action is sign in', () => {
    const onSignIn = vi.fn();
    const tree = flatten(TaxiSignedOut({ navigation: { goBack: vi.fn() }, onSignIn }));
    const empty = tree.find((el) => el.type === 'EmptyState');
    expect(empty, 'the door is an EmptyState').toBeTruthy();
    expect(empty!.props['title']).toBe('Sign in to book a ride');
    expect(empty!.props['actionLabel']).toBe('Sign in');
    empty!.props['onAction']();
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('never shows a loading state: nothing in the door waits on a request', () => {
    const tree = flatten(TaxiSignedOut({ onSignIn: vi.fn() }));
    expect(tree.map((el) => el.type)).not.toContain('LoadingBlock');
  });

  it('keeps the way back', () => {
    const goBack = vi.fn();
    const tree = flatten(TaxiSignedOut({ navigation: { goBack }, onSignIn: vi.fn() }));
    const back = tree.find((el) => el.type === 'CircleChip');
    expect(back!.props['label']).toBe('Go back');
    back!.props['onPress']();
    expect(goBack).toHaveBeenCalledTimes(1);
  });
});
