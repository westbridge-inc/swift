import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { storefrontAuthReturn } from '@/lib/storefront-continuation';
import { BYPASS_CORPUS } from './redirect-corpus';

// ---------------------------------------------------------------------------
// [WEB-GUARDS · VERIFY row 331 lane 9] OPEN REDIRECT. Every ?next= validator
// on the website (sign-in and sign-up through storefrontAuthReturn, the
// selfie page through its own copy) let "/", a TAB, "/evil.example" through;
// the browser drops the tab and resolves it to https://evil.example/. The
// classic bypass corpus must all fall back to the caller's default page, and
// there is ONE validator (lib/safe-return-path) used by every consumer.
// ---------------------------------------------------------------------------


beforeEach(() => { sessionStorage.clear(); });

describe('[WEB-GUARDS] sign-in / sign-up return (storefrontAuthReturn)', () => {
  it.each(BYPASS_CORPUS.map((v) => [JSON.stringify(v), v]))('refuses %s', (_label, value) => {
    expect(storefrontAuthReturn(value)).toBe('');
  });

  it.each([['/'], ['/market'], ['/store/garden-kitchen?src=qr'], ['/orders/abc#top'], ['/weekly-fee']])('keeps the in-app path %s', (value) => {
    expect(storefrontAuthReturn(value)).toBe(value);
    expect(new URL(value, 'https://swiftgy.com/login').origin).toBe('https://swiftgy.com');
  });
});

describe('[WEB-GUARDS] one validator for every return path', () => {
  const src = join(process.cwd(), 'src');
  const read = (path: string) => readFileSync(join(src, path), 'utf8');

  it('sign-in, sign-up, the selfie page and the storefront return all use lib/safe-return-path', () => {
    expect(read('lib/storefront-continuation.ts')).toMatch(/from '\.\/safe-return-path'/);
    expect(read('app/selfie/page.tsx')).toMatch(/from '@\/lib\/safe-return-path'/);
    expect(read('app/login/page.tsx')).toMatch(/from '@\/lib\/safe-return-path'/);
    expect(read('app/signup/page.tsx')).toMatch(/storefrontAuthReturn\(new URLSearchParams\(window\.location\.search\)\.get\('next'\)\)/);
  });

  it('no other file hand-rolls a "starts with one slash" return check', () => {
    const files = (function walk(dir: string, out: string[] = []): string[] {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
      }
      return out;
    })(src);
    const handRolled = files.filter((f) => readFileSync(f, 'utf8').includes('/^\\/(?!\\/)/'));
    expect(handRolled.map((f) => relative(src, f))).toEqual([]);
  });
});
