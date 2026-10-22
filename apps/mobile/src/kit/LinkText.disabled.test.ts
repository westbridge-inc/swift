import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// [IMAGES-E2E #1909 · REVIEW-G S4-1] A held inline link looks held and cannot be pressed, the way a
// disabled PillButton does: the press is gone, a screen reader hears "disabled", and it is greyed.
// Without `disabled` the link renders exactly as before.

vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({ color: { brand: {}, text: {}, dark: {}, surface: {}, border: {} }, space: {} }));
vi.mock('./text', () => ({ T: 'T' }));

import { LinkText } from './button';

type El = React.ReactElement<Record<string, any>>;
const opacity = (el: El) => ((el.props['children'] as (s: { pressed: boolean }) => El)({ pressed: false }).props['style'] as { opacity: number }).opacity;

describe('[IMAGES-E2E] LinkText disabled', () => {
  it('disabled: no press, read as disabled, greyed like a disabled PillButton', () => {
    const onPress = vi.fn();
    const el = LinkText({ label: 'Remove', onPress, disabled: true }) as El;
    expect(el.type).toBe('Pressable');
    expect(el.props['disabled']).toBe(true);
    expect(el.props['onPress']).toBeUndefined();
    expect(el.props['accessibilityState']).toEqual({ disabled: true });
    expect(opacity(el)).toBe(0.45);
  });

  it('not disabled: the press, the label and the look are as before', () => {
    const onPress = vi.fn();
    const el = LinkText({ label: 'Change', onPress }) as El;
    expect(el.props['onPress']).toBe(onPress);
    expect(el.props['disabled']).toBeFalsy();
    expect(el.props['accessibilityState']).toBeUndefined();
    expect(el.props['accessibilityLabel']).toBe('Change');
    expect(opacity(el)).toBe(1);
  });
});
