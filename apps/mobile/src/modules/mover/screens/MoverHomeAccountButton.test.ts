import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('../../../kit', () => ({ cardShadow: { shadowOpacity: 0.1 } }));
vi.mock('../dark', () => ({
  dk: { card: 'card-token', line: 'line-token', text: 'text-token' },
}));

import { MoverHomeAccountButton } from './MoverHomeAccountButton';

type TestElement = React.ReactElement<Record<string, unknown>, string>;

describe('MoverHomeAccountButton', () => {
  it('exposes the icon-only account action as a labeled button and preserves activation', () => {
    const onPress = vi.fn();
    const button = MoverHomeAccountButton({ onPress }) as TestElement;

    expect(button.type).toBe('Pressable');
    expect(button.props).toMatchObject({
      accessibilityRole: 'button',
      accessibilityLabel: 'Account',
      hitSlop: 8,
      onPress,
    });

    (button.props['onPress'] as () => void)();
    expect(onPress).toHaveBeenCalledOnce();
  });
});
