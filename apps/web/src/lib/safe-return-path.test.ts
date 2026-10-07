import { describe, expect, it } from 'vitest';
import { storefrontAuthReturn } from './storefront-continuation';

// ---------------------------------------------------------------------------
// [WEB-GUARDS] Sign-in and sign-up return the customer to `?next=` through
// storefrontAuthReturn. A browser removes tab, line-feed and carriage-return
// characters while reading a URL, so "/" + tab + "/elsewhere" is read as the
// protocol-relative address of another site. The return path must be judged
// as the browser will read it, not as it is spelled.
// ---------------------------------------------------------------------------

describe('[WEB-GUARDS] sign-in returns only to a path on this site', () => {
  it.each([
    ['a tab', '/\t/evil.example/'],
    ['a line feed', '/\n/evil.example/'],
    ['a carriage return', '/\r/evil.example/'],
    ['two tabs', '/\t\t/evil.example/?x=1'],
  ])('refuses a return holding %s that a browser reads as another site', (_name, next) => {
    expect(new URL(next, 'https://swift.example').origin).toBe('https://evil.example');
    expect(storefrontAuthReturn(next)).toBe('');
  });

  it.each([
    ['protocol-relative', '//evil.example/'],
    ['absolute', 'https://evil.example/'],
    ['backslash', '/\\evil.example/'],
    ['traversal', '/a/../../evil'],
    ['a NUL byte', '/a\u0000b'],
    ['javascript:', 'javascript:alert(1)'],
  ])('refuses a %s return', (_name, next) => {
    expect(storefrontAuthReturn(next)).toBe('');
  });

  it.each(['/', '/market', '/order/vendor/v1?item=i1', '/cart#top', '/search?q=rice and peas'])(
    'keeps the in-app path %s exactly',
    (next) => {
      expect(storefrontAuthReturn(next)).toBe(next);
    },
  );
});
