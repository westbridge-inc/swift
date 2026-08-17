/* eslint-disable no-restricted-syntax -- this unit test MOCKS the @swift/ui
   token module itself; the mock's placeholder hex values are the tokens, not
   screen colour usage, so the design-100x no-literal-colour screens law does
   not apply here. */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CartPaymentCapabilities } from '@swift/types';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({
  color: {
    brand: { 50: '#fff5f5', 500: '#900', 600: '#700' },
    border: { strong: '#aaa' },
    surface: { base: '#fff' },
    text: { muted: '#777' },
  },
  radius: { md: 12 },
  space: { sm: 8, md: 12, lg: 16 },
}));
vi.mock('../../kit', () => ({ T: 'T' }));

import { CartPaymentOptions } from './CartPaymentOptions';

type Element = React.ReactElement<Record<string, any>, string | React.JSXElementConstructor<any>>;

function caps(mmg: boolean): CartPaymentCapabilities {
  return {
    scope: 'scope-1',
    cash: { available: true, fundsFlow: 'DIRECT_AT_HANDOVER' },
    mmg: {
      available: mmg,
      provider: 'MMG',
      fundsFlow: 'DIRECT_TO_VENDOR',
      unavailableReason: mmg ? null : 'VENDOR_NOT_CONFIGURED',
    },
  };
}

function children(element: Element): Element[] {
  return React.Children.toArray(element.props['children']).filter(React.isValidElement) as Element[];
}

describe('CartPaymentOptions rendering contract', () => {
  it('renders no MMG control when the cart capability is unavailable', () => {
    const view = CartPaymentOptions({
      capabilities: caps(false),
      selection: { method: 'CASH', scope: 'scope-1' },
      appointmentOnly: false,
      pickup: false,
      onSelect: vi.fn(),
    }) as Element;
    const radios = children(view);
    expect(radios).toHaveLength(1);
    expect(radios[0]!.props['accessibilityLabel']).toBe('Cash on delivery');
  });

  it('renders an accessible MMG choice only when offered and delivers the choice', () => {
    const onSelect = vi.fn();
    const view = CartPaymentOptions({
      capabilities: caps(true),
      selection: { method: 'CASH', scope: 'scope-1' },
      appointmentOnly: false,
      pickup: false,
      onSelect,
    }) as Element;
    const radios = children(view);
    expect(radios.map((radio) => radio.props['accessibilityLabel'])).toEqual(['Cash on delivery', 'Pay with MMG']);
    expect(radios[1]!.props['accessibilityState']).toEqual({ checked: false });
    radios[1]!.props['onPress']();
    expect(onSelect).toHaveBeenCalledWith('MMG');
  });
});
