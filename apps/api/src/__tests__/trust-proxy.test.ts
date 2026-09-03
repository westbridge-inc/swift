import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asFastifyTrustProxy, parseTrustProxy } from '../config/trust-proxy';

// ---------------------------------------------------------------------------
// [DEP-1] `X-Forwarded-For` is a client-supplied header. Trusting it blindly
// lets a caller claim any source address and walk past every per-IP rate limit
// and block, so TRUST_PROXY decides who may set it and defaults to nothing.
//
// fastify 5.12 narrowed the `trustProxy` OPTION TYPE to
// `boolean | string | string[] | TrustProxyFunction`, dropping `number`, while
// leaving the runtime untouched. That made the API fail to type-check on the
// dependency bump — and the obvious fix (send "1" instead of 1) would have
// changed a hop count into an invalid address literal, silently altering which
// proxies are trusted while the compiler went quiet.
//
// These tests pin the shape so that cannot happen by tidying.
// ---------------------------------------------------------------------------

describe('[DEP-1] TRUST_PROXY is parsed into what fastify actually honours', () => {
  it('defaults to trusting NOTHING', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('"true" trusts everything, explicitly', () => {
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('a hop count stays a NUMBER — this is the whole point', () => {
    // "1" (string) means an address called "1"; 1 (number) means one hop.
    // They are different instructions to fastify, not two spellings of one.
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(typeof parseTrustProxy('1')).toBe('number');
    expect(parseTrustProxy('1')).not.toBe('1');
  });

  it('an address or preset list stays a STRING', () => {
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
    expect(typeof parseTrustProxy('loopback')).toBe('string');
  });

  it('the fastify-typed wrapper does not change the VALUE, only the type', () => {
    for (const v of [undefined, 'false', 'true', '1', '10.0.0.0/8']) {
      expect(asFastifyTrustProxy(v)).toEqual(parseTrustProxy(v));
    }
    expect(asFastifyTrustProxy('1')).toBe(1);
  });
});

describe('[DEP-1] the assumption the cast rests on, checked against fastify itself', () => {
  it('fastify still honours a numeric hop count at RUNTIME', () => {
    // The cast in config/trust-proxy.ts is only safe while this is true. If a
    // future fastify drops the numeric branch, this goes red and the migration
    // becomes a deliberate decision instead of a silent behaviour change.
    // createRequire off the package root — `import.meta` is not available under
    // this project's module setting, and vitest would not have told us.
    const require_ = createRequire(join(process.cwd(), 'package.json'));
    const requestJs = readFileSync(require_.resolve('fastify/lib/request.js'), 'utf8');
    expect(requestJs).toMatch(/typeof tp === 'number'/);
    expect(requestJs).toMatch(/Support trusting hop count/);
    // and that a string is compiled as addresses, which is why "1" is not 1
    expect(requestJs).toMatch(/tp\.split\(','\)/);
  });
});
