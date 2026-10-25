import { describe, expect, it } from 'vitest';
import { ownNameSigningFor } from './own-name-copy';

// [ROLE-DOCS · REVIEW-F #2046 S4-1] The web sign-up step names the store the declaration is signed for (per store).
describe('[ROLE-DOCS] the web own-name step names the store it signs for', () => {
  it('names the store, trimmed and quoted; nothing without a name', () => {
    expect(ownNameSigningFor(' Persaud ')).toBe('You sign this for “Persaud” only.');
    for (const blank of [undefined, null, '', '  ']) expect(ownNameSigningFor(blank)).toBeNull();
  });
});
