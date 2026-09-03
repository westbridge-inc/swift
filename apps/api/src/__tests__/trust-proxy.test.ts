import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TrustProxyConfigError, asFastifyTrustProxy, parseTrustProxy } from '../config/trust-proxy';

// ---------------------------------------------------------------------------
// [DEP-2] `X-Forwarded-For` is a client-supplied header. Trusting it blindly
// lets a caller claim any source address and walk past every per-IP rate limit
// and block, so TRUST_PROXY decides who may set it and defaults to nothing.
//
// fastify 5.12 changed the RUNTIME, not just the type, in response to a
// published advisory: a numeric hop count now FAILS CLOSED, because hop
// counting cannot validate the immediate peer and a direct client can defeat it
// by supplying enough hops.
//
// That makes a hop count silently mean "trust nothing" — every request would be
// attributed to the proxy's own address, so per-IP limiting would keep working
// while counting the whole internet as one client, and nothing would be logged.
// So a hop count is refused AT BOOT instead.
//
// DEP-1 (#1071) kept the number, on the basis that the runtime was unchanged.
// That was measured from `fastify.js`, which only forwards the option; the
// branch that changed is in `lib/request.js`. This suite is what caught it.
// ---------------------------------------------------------------------------

describe('[DEP-2] TRUST_PROXY is parsed into something fastify honours', () => {
  it('defaults to trusting NOTHING', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('"true" trusts everything, explicitly', () => {
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('an address or preset list is the supported form', () => {
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
    expect(parseTrustProxy('  loopback  ')).toBe('loopback');
  });

  it('a bare hop count is REFUSED, loudly', () => {
    for (const hops of ['1', '2', '10', ' 3 ']) {
      expect(() => parseTrustProxy(hops), hops).toThrow(TrustProxyConfigError);
    }
  });

  it('the refusal says what to set instead', () => {
    try {
      parseTrustProxy('1');
      throw new Error('should have refused');
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toMatch(/hop count/i);
      expect(m).toMatch(/CIDR|address/i);
      expect(m).toMatch(/"true"/);
    }
  });

  it('the fastify-typed wrapper does not change the value', () => {
    for (const v of [undefined, 'false', 'true', '10.0.0.0/8']) {
      expect(asFastifyTrustProxy(v)).toEqual(parseTrustProxy(v));
    }
  });
});

describe('[DEP-2] the reason for the refusal, checked against fastify itself', () => {
  const requestJs = readFileSync(
    createRequire(join(process.cwd(), 'package.json')).resolve('fastify/lib/request.js'),
    'utf8',
  );

  it('a string is still compiled as addresses', () => {
    // This is why an address list remains the supported form.
    expect(requestJs).toMatch(/tp\.split\(','\)/);
    expect(requestJs).toMatch(/proxyAddr\.compile/);
  });

  it('the numeric branch is whatever the installed fastify says it is', () => {
    // The pinned fact: fastify still BRANCHES on a number. What that branch
    // does differs by version — ≤5.8 trusted N hops, 5.12 fails closed — and
    // either way we refuse the input before it reaches here, so Swift's
    // behaviour no longer depends on which version is installed.
    expect(requestJs).toMatch(/typeof tp === 'number'/);
  });
});
