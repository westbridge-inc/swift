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
  space: { lg: 16, md: 12, sm: 8 },
}));

vi.mock('./button', () => ({ LinkText: 'LinkText' }));
vi.mock('./text', () => ({ T: 'T' }));

import { DecorativeIcon, IconChip, SettingsRow } from './rows';

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

// ---------------------------------------------------------------------------
// Row rhythm. A settings list is read by scanning down its left edge, so the
// step between rows has to be constant — and it was not: rows carrying a chip
// stood 68pt tall while the legal rows beside them stood 47pt, in the same
// list, under the same heading. That raggedness is most of what reads as
// "unfinished" on the profile screen.
//
// These two tests are the same assertion from both sides, which is the point:
// whatever the height IS, the chip row and the plain row must agree on it.
// ---------------------------------------------------------------------------

const bodyOf = (row: TestElement) =>
  (row.props['children'] as (s: { pressed: boolean }) => TestElement)({ pressed: false });

describe('SettingsRow rhythm', () => {
  it('a chip row and a plain row stand exactly the same height', () => {
    const chipRow = bodyOf(SettingsRow({ icon: 'bell', label: 'Notifications', onPress() {} }) as TestElement);
    const plainRow = bodyOf(
      SettingsRow({ icon: 'file-text', label: 'Terms of service', plain: true, onPress() {} }) as TestElement,
    );

    const chipHeight = (chipRow.props['style'] as Record<string, unknown>)['minHeight'];
    const plainHeight = (plainRow.props['style'] as Record<string, unknown>)['minHeight'];

    expect(chipHeight).toBe(plainHeight);
    // 56, not 68: a row is a line of text you tap, not a piece of furniture.
    // Comfortably past the 44pt touch minimum, well under the padded look.
    expect(chipHeight).toBe(56);
  });

  it('the chip inside a row is smaller than a standalone chip', () => {
    // The chip identifies the destination; it is not the subject of the row.
    // A standalone chip (dialog artwork) stays large — see IconChip's default.
    const chipRow = bodyOf(SettingsRow({ icon: 'bell', label: 'Notifications', onPress() {} }) as TestElement);
    const children = chipRow.props['children'] as TestElement[];
    const chip = children[0] as React.ReactElement<{ size?: number }>;

    expect(chip.props.size).toBe(36);
    expect(chip.props.size).toBeLessThan(44);
  });
});
