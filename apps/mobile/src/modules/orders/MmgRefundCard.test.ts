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

import { MmgRefundCard } from './MmgRefundCard';
import type { MmgRefundView } from './mmgRefund';

type Element = React.ReactElement<Record<string, any>, string | React.JSXElementConstructor<any>>;
const asked: MmgRefundView = { state: 'SENT', amount: '1300.00', line: 'The store says it sent GY$1,300. Did it arrive?', sendId: 's1', canAnswer: true, canMarkSent: false };
function flatten(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!React.isValidElement(node)) return [];
  const el = node as Element;
  return [el, ...React.Children.toArray(el.props['children']).flatMap(flatten)];
}
const buttons = (tree: Element) => flatten(tree).filter((e) => e.type === 'PillButton');

describe('[G08] MmgRefundCard', () => {
  it('shows the server\'s line and sends that send\'s answer', () => {
    const onAnswer = vi.fn();
    const tree = MmgRefundCard({ view: asked, pending: false, error: null, onAnswer }) as Element;
    expect(buttons(tree).map((b) => b.props['label'])).toEqual(['It arrived', 'It did not arrive']);
    buttons(tree)[0]!.props['onPress']();
    expect(onAnswer).toHaveBeenLastCalledWith('s1', true);
    buttons(tree)[1]!.props['onPress']();
    expect(onAnswer).toHaveBeenLastCalledWith('s1', false);
  });
  it('asks nothing when there is nothing to answer', () => {
    const tree = MmgRefundCard({ view: { ...asked, state: 'OWED', sendId: null, canAnswer: false }, pending: false, error: null, onAnswer: vi.fn() }) as Element;
    expect(buttons(tree)).toHaveLength(0);
  });
  it('is inert while an answer is on its way, and shows a refusal', () => {
    const tree = MmgRefundCard({ view: asked, pending: true, error: 'You already answered this.', onAnswer: vi.fn() }) as Element;
    for (const b of buttons(tree)) expect(b.props['disabled']).toBe(true);
    expect(JSON.stringify(flatten(tree).filter((e) => e.type === 'T').map((e) => e.props['children']))).toContain('You already answered this.');
  });
});
