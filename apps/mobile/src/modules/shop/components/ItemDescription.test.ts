import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ open: false, set: vi.fn() }));
vi.mock('react', async (original) => {
  const actual = await original<Record<string, any>>();
  const useState = () => [state.open, state.set];
  return { ...actual, useState, default: { ...actual['default'], useState } };
});
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@swift/ui', () => ({ space: { xs: 2 } }));
vi.mock('../../../kit', () => ({ T: 'T', LinkText: 'LinkText' }));

import { DESCRIPTION_CLAMP_CHARS, ItemDescription, descriptionNeedsClamp } from './ItemDescription';

// [P35 · board 4b "Read more"] Three lines until asked; a short description is whole, with no link.
function nodes(node: any, out: any[] = []): any[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out; }
  out.push(node);
  nodes(node.props?.children, out);
  return out;
}
const LONG = 'x'.repeat(DESCRIPTION_CLAMP_CHARS + 1);

describe('[P35] ItemDescription', () => {
  it('a long description: three lines and "Read more"; the tap opens it', () => {
    state.open = false;
    const tree = nodes(ItemDescription({ text: LONG }));
    expect(tree.find((n) => n.type === 'T')?.props.numberOfLines).toBe(3);
    const link = tree.find((n) => n.type === 'LinkText');
    expect(link?.props.label).toBe('Read more');
    link.props.onPress();
    expect(state.set).toHaveBeenCalledTimes(1);
  });

  it('opened: the whole text and "Show less"', () => {
    state.open = true;
    const tree = nodes(ItemDescription({ text: LONG }));
    expect(tree.find((n) => n.type === 'T')?.props.numberOfLines).toBeUndefined();
    expect(tree.find((n) => n.type === 'LinkText')?.props.label).toBe('Show less');
  });

  it('a short description: whole, and no link', () => {
    state.open = false;
    const tree = nodes(ItemDescription({ text: 'Hand-woven.' }));
    expect(tree.find((n) => n.type === 'T')?.props.numberOfLines).toBeUndefined();
    expect(tree.find((n) => n.type === 'LinkText')).toBeUndefined();
    expect(descriptionNeedsClamp(`  ${'y'.repeat(DESCRIPTION_CLAMP_CHARS)}  `)).toBe(false);
  });
});
