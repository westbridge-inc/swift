import { describe, it, expect } from 'vitest';
import { destinationForUrl } from './deepLinkParse';

// Edge row 20's law in miniature: any unrecognized path is null — the app
// opens normally, never crashes, never guesses a store.

describe('destinationForUrl', () => {
  it('parses storefront links, carrying a valid ?c= through', () => {
    expect(destinationForUrl('https://swift.gy/store/green-bowl-x7k2m9')).toEqual({
      kind: 'store', slug: 'green-bowl-x7k2m9', code: null,
    });
    expect(destinationForUrl('https://swift.gy/store/green-bowl?src=qr&c=bcdfghjkmn&t=card')).toEqual({
      kind: 'store', slug: 'green-bowl', code: 'BCDFGHJKMN',
    });
    // A malformed c is dropped, the store still opens.
    expect(destinationForUrl('https://swift.gy/store/green-bowl?c=<script>')).toEqual({
      kind: 'store', slug: 'green-bowl', code: null,
    });
  });

  it('parses short links case-insensitively to canonical uppercase', () => {
    expect(destinationForUrl('https://swift.gy/s/bcdfghjkmn')).toEqual({ kind: 'short', code: 'BCDFGHJKMN' });
    expect(destinationForUrl('swift://s/BCDFGHJKMN')).toEqual({ kind: 'short', code: 'BCDFGHJKMN' });
  });

  it('everything else is null — deeper paths, bad slugs, bad codes, junk', () => {
    for (const url of [
      'https://swift.gy/',
      'https://swift.gy/store',
      'https://swift.gy/store/a/b',
      'https://swift.gy/store/UPPER..CASE',
      'https://swift.gy/s/SHORT',
      'https://swift.gy/s/AEIOUAEIOU', // vowels — not our charset
      'https://swift.gy/qr/retired',
      'not a url',
      'file:///etc/passwd',
      'https://swift.gy/store/' + 'a'.repeat(120),
    ]) {
      expect(destinationForUrl(url)).toBeNull();
    }
  });
});
