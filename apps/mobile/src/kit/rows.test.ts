import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));

vi.mock('@swift/ui', () => ({
  color: {
    brand: { 50: '#fff4ed', 600: '#c24f13' },
    error: '#a00',
    soft: { danger: '#fee' },
    text: { muted: '#777' },
  },
  radius: { md: 12 },
  space: { lg: 16, md: 12 },
}));

vi.mock('./button', () => ({ LinkText: 'LinkText' }));
vi.mock('./text', () => ({ T: 'T' }));

import { DecorativeIcon, IconChip } from './rows';

type TestElement = React.ReactElement<Record<string, unknown>, string>;

describe('IconChip', () => {
  it('provides a reusable hidden boundary for decorative dialog artwork', () => {
    const child = React.createElement('Feather', { name: 'check' });
    const icon = DecorativeIcon({ children: child, style: { width: 64 } }) as TestElement;

    expect(icon.type).toBe('View');
    expect(icon.props).toMatchObject({
      accessible: false,
      accessibilityElementsHidden: true,
      focusable: false,
      importantForAccessibility: 'no-hide-descendants',
      style: { width: 64 },
      children: child,
    });
  });

  it('hides its decorative glyph from screen readers and keyboard focus', () => {
    const chip = IconChip({ icon: 'log-out', size: 56 }) as React.ReactElement<
      Record<string, unknown>,
      typeof DecorativeIcon
    >;
    expect(chip.type).toBe(DecorativeIcon);

    const boundary = DecorativeIcon(chip.props) as TestElement;
    expect(boundary.type).toBe('View');
    expect(boundary.props).toMatchObject({
      accessible: false,
      accessibilityElementsHidden: true,
      focusable: false,
      importantForAccessibility: 'no-hide-descendants',
    });

    const glyph = React.Children.only(boundary.props['children']) as TestElement;
    expect(glyph.type).toBe('Feather');
    expect(glyph.props).toMatchObject({
      name: 'log-out',
      size: 25.2,
    });
  });
});
