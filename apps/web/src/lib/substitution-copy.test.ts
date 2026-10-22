// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isRemovalQuestion, removalChangeText } from './substitution-copy';

// [O-4 · owner 22 Oct 2026] Nothing to swap, asked before the store accepted: the customer continues
// without the item (the total goes down) or cancels the order. Mirrors the phone's substitutionCopy.

describe('the removal question (O-4)', () => {
  it('is told apart from a swap by the server\'s kind', () => {
    expect(isRemovalQuestion({ kind: 'REMOVAL' })).toBe(true);
    expect(isRemovalQuestion({ kind: 'SWAP' })).toBe(false);
    expect(isRemovalQuestion(undefined)).toBe(false);
  });

  it('says what continuing does to the total, from the server\'s own number, and nothing without one', () => {
    expect(removalChangeText({ kind: 'REMOVAL', priceDelta: -2500 })).toBe('Continuing without it lowers your total by $2,500. You pay only the new total.');
    expect(removalChangeText({ kind: 'REMOVAL', priceDelta: 0 })).toBeNull();
    expect(removalChangeText({ kind: 'REMOVAL', priceDelta: null })).toBeNull();
  });
});
