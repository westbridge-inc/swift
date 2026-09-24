import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [E09] The pinned "View cart" bar is ONE kit component and every browse
// surface renders it. This file pins the component's own behaviour, rendered
// with react-native stubbed (see card.test.ts): it reads the cart through the
// shared `useCart` hook, shows only while the basket has items, names itself
// to a screen reader, floats above the home indicator, and jumps straight to
// the Cart tab. Screen wiring is pinned by the sibling source test.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  cart: { data: undefined as any },
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));

vi.mock('@swift/ui', () => ({
  color: { brand: { 500: '#brand-500' } },
  elevation: { floating: { boxShadow: '0px 12px 24px rgba(33,26,26,0.22)', elevation: 10 } },
  space: { xs: 4, lg: 16, xl: 20, '2xl': 24 },
}));

vi.mock('../hooks/customer', () => ({
  useCart: () => mocks.cart,
}));

vi.mock('./money', () => ({ Money: 'Money' }));
vi.mock('./text', () => ({ T: 'T' }));

import { CART_BAR_HEIGHT, CartBar, useCartBarClearance } from './cart-bar';

type El = ReactElement<Record<string, any>, string>;

/** Render while items are present — the empty case is asserted separately. */
function bar(vendorId?: string): El {
  const out = CartBar({ vendorId }) as El | null;
  expect(out, 'CartBar must render while the cart has items').not.toBeNull();
  return out!;
}

/** Through the Pressable render-prop into the visible pill. */
function pill(el: El): El {
  expect(el.type).toBe('Pressable');
  const view = el.props['children']({ pressed: false }) as El;
  expect(view.type).toBe('View');
  return view;
}

function flatten(node: any, out: any[] = []): any[] {
  if (node == null || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return out;
  }
  out.push(node);
  flatten(node.props?.children, out);
  return out;
}

function textOf(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

describe('CartBar — the one pinned door to the Cart tab', () => {
  it('navigates straight to the Cart tab', () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 2 }], subtotalCustomer: 1500, vendorId: 'vendor-1' };
    mocks.navigate.mockClear();

    bar().props['onPress']();

    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('Tabs', { screen: 'Cart' });
  });

  it('shows the live count and subtotal from the cart query', () => {
    mocks.cart.data = {
      items: [{ itemId: 'i1', quantity: 2 }, { itemId: 'i2', quantity: 1 }],
      subtotalCustomer: 1500,
      vendorId: 'vendor-1',
    };

    const els = flatten(pill(bar()));
    const texts = els.filter((node) => node.type === 'T').map(textOf);
    const moneyEl = els.find((node) => node.type === 'Money');

    expect(texts).toContain('View cart');
    expect(texts).toContain('3 items ·');
    expect(moneyEl.props.amount).toBe(1500);
  });

  it('is reachable to a screen reader with the count in the label', () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 700, vendorId: 'vendor-1' };

    const el = bar();

    expect(el.props['accessibilityRole']).toBe('button');
    expect(el.props['accessibilityLabel']).toBe('View cart, 1 item');
  });

  it('is hidden while the cart is empty', () => {
    mocks.cart.data = { items: [], subtotalCustomer: 0, vendorId: 'vendor-1' };
    expect(CartBar({})).toBeNull();
  });

  it('is hidden while every line is at zero', () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 0 }], subtotalCustomer: 0, vendorId: 'vendor-1' };
    expect(CartBar({})).toBeNull();
  });

  it("a storefront never shows another store's basket", () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 700, vendorId: 'vendor-1' };

    expect(CartBar({ vendorId: 'vendor-2' })).toBeNull();
    expect(bar('vendor-1').type).toBe('Pressable');
  });

  it("floats above the home indicator instead of covering the screen's bottom content", () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 700, vendorId: 'vendor-1' };

    const view = pill(bar());

    expect(view.props['style']).toMatchObject({
      position: 'absolute',
      left: 24,
      right: 24,
      bottom: 34 + 16,
      height: 52,
    });
  });
});

describe('[E09] a list leaves room for the bar while it floats over it', () => {
  it("the clearance is the bar's whole footprint above the screen edge while it shows", () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 700, vendorId: 'vendor-1' };
    // bottom inset 34 + space.lg 16 + the 52pt pill
    expect(CART_BAR_HEIGHT).toBe(52);
    expect(useCartBarClearance()).toBe(34 + 16 + 52);
  });

  it('is zero while the bar is hidden, so an empty basket changes no layout', () => {
    mocks.cart.data = { items: [], subtotalCustomer: 0, vendorId: 'vendor-1' };
    expect(useCartBarClearance()).toBe(0);
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 0 }], subtotalCustomer: 0, vendorId: 'vendor-1' };
    expect(useCartBarClearance()).toBe(0);
  });

  it("follows the storefront gate: no room reserved for another store's basket", () => {
    mocks.cart.data = { items: [{ itemId: 'i1', quantity: 1 }], subtotalCustomer: 700, vendorId: 'vendor-1' };
    expect(useCartBarClearance({ vendorId: 'vendor-2' })).toBe(0);
    expect(useCartBarClearance({ vendorId: 'vendor-1' })).toBe(34 + 16 + 52);
  });
});

describe('the bar reads the cart through the shared hook', () => {
  it('uses useCart and never issues its own cart request', () => {
    const src = readFileSync(new URL('./cart-bar.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/useCart</);
    expect(src).not.toMatch(/getCart/);
  });
});
