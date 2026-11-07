import { describe, expect, it } from 'vitest';
import { ownNameSigningFor } from './ownNameCopy';

// [ROLE-DOCS · REVIEW-F #2046 S4-1] The declaration is PER STORE: the card names the store it is signed for, so an
// owner with two stores sees which one they sign for. No name, no line (never a blank "for").
describe('[ROLE-DOCS] the own-name card names the store it signs for', () => {
  it('names the store, trimmed and quoted', () => {
    expect(ownNameSigningFor('  R. Persaud ')).toBe('You sign this for “R. Persaud” only.');
  });
  it('says nothing when there is no name yet', () => {
    for (const blank of [undefined, null, '', '   ']) expect(ownNameSigningFor(blank)).toBeNull();
  });
});
