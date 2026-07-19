import { describe, it, expect } from 'vitest';
import { rateLimitKey } from '../utils/rate-limit-key';

// SWIFT-AUD-D1-01 — the global limiter buckets authenticated callers per session
// token (not per IP), so a shared NAT can't throttle unrelated users and an
// abuser can't multiply their allowance by rotating IPs.

const key = (authorization: string | undefined, ip: string) =>
  rateLimitKey({ headers: authorization ? { authorization } : {}, ip } as never);

describe('rate-limit key (D1-01)', () => {
  it('buckets a session by its token, independent of the source IP', () => {
    const a = key('Bearer token-AAAAAAAAAAAA', '10.0.0.1');
    const aOtherIp = key('Bearer token-AAAAAAAAAAAA', '10.0.0.2');
    expect(a).toBe(aOtherIp); // same session → same bucket, even from a new IP
    expect(a.startsWith('u:')).toBe(true);
  });

  it('gives two users behind one NAT IP separate buckets', () => {
    const userA = key('Bearer token-AAAAAAAAAAAA', '10.0.0.1');
    const userB = key('Bearer token-BBBBBBBBBBBB', '10.0.0.1'); // same IP, different session
    expect(userA).not.toBe(userB);
  });

  it('never places the raw token in the key', () => {
    const k = key('Bearer super-secret-token-value', '10.0.0.1');
    expect(k).not.toContain('super-secret-token-value');
  });

  it('falls back to the resolved IP for anonymous requests', () => {
    expect(key(undefined, '9.9.9.9')).toBe('9.9.9.9');
    expect(key('Bearer x', '9.9.9.9')).toBe('9.9.9.9'); // too-short/garbage → treat as anonymous
  });
});
