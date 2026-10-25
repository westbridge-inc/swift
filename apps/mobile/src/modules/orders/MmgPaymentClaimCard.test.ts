/* eslint-disable no-restricted-syntax -- this unit test MOCKS the @swift/ui
   token module itself; the mock's placeholder hex values are the tokens, not
   screen colour usage. */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@swift/ui', () => ({
  color: { surface: { sunken: '#eee' }, soft: { success: '#efe', warning: '#ffe' } },
  radius: { lg: 16 },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
}));
vi.mock('../../kit', () => ({ T: 'T', PillButton: 'PillButton' }));

import { MmgPaymentClaimCard } from './MmgPaymentClaimCard';
import type { MmgClaimView } from './mmgClaim';

type Element = React.ReactElement<Record<string, any>, string | React.JSXElementConstructor<any>>;
const base: MmgClaimView = {
  customerClaim: 'UNRECORDED', customerClaimAt: null, storeClaimed: true, providerCaptured: false,
  disputed: false, disputedAt: null, resolution: null, resolvedAt: null, attemptRejected: false,
  revision: 1, canClaim: true,
};

function flatten(node: React.ReactNode): Element[] {
  if (!React.isValidElement(node)) return [];
  const el = node as Element;
  return [el, ...React.Children.toArray(el.props['children']).flatMap(flatten)];
}
const buttons = (tree: Element) => flatten(tree).filter((e) => e.type === 'PillButton');
const text = (tree: Element) => flatten(tree).filter((e) => e.type === 'T').map((e) => React.Children.toArray(e.props['children']).join(''));

describe('MmgPaymentClaimCard rendering contract', () => {
  it('renders the server state and one reachable control per statement the customer may make', () => {
    const onClaim = vi.fn();
    const tree = MmgPaymentClaimCard({ view: base, pending: false, onClaim }) as Element;
    expect(text(tree)[0]).toMatch(/store reported/i);
    const b = buttons(tree);
    expect(b.map((x) => x.props['label'])).toEqual(['I paid the store', 'I didn’t pay']);
    b[1]!.props['onPress']();
    expect(onClaim).toHaveBeenCalledWith(expect.objectContaining({ paid: false, label: 'I didn’t pay' }));
  });

  it('while a claim is in flight every control is busy and inert', () => {
    const tree = MmgPaymentClaimCard({ view: base, pending: true, onClaim: vi.fn() }) as Element;
    for (const b of buttons(tree)) {
      expect(b.props['loading']).toBe(true);
      expect(b.props['disabled']).toBe(true);
    }
  });

  it('renders no control the server would refuse', () => {
    const tree = MmgPaymentClaimCard({ view: { ...base, canClaim: false }, pending: false, onClaim: vi.fn() }) as Element;
    expect(buttons(tree)).toHaveLength(0);
    expect(text(tree).length).toBeGreaterThan(0);
  });
});
