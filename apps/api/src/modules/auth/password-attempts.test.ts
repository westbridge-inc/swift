import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { passwordSourceDigest, passwordSourceBucket } from './password-attempts';

// [L04 · MASTER-056 review] The per-source budget keys on a BUCKET of the
// client address, pseudonymised with a keyed HMAC:
//  - IPv6 is bucketed by /64 — one host owns a whole /64, so per-address
//    budgets would hand it 2^64 fresh budgets;
//  - an IPv4-mapped IPv6 address is the IPv4 address;
//  - the digest is keyed, so the Redis keyspace is not a reversible IP log.

describe('[MASTER-056] password source buckets and digests', () => {
  it('IPv6 addresses in one /64 share a bucket; another /64 does not', () => {
    expect(passwordSourceBucket('2001:db8:1:2::1')).toBe(passwordSourceBucket('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(passwordSourceBucket('2001:db8:1:2::1')).not.toBe(passwordSourceBucket('2001:db8:1:3::1'));
  });

  it('an IPv4-mapped IPv6 address is its IPv4 address; distinct IPv4 addresses are distinct', () => {
    expect(passwordSourceBucket('::ffff:203.0.113.7')).toBe(passwordSourceBucket('203.0.113.7'));
    expect(passwordSourceBucket('203.0.113.7')).not.toBe(passwordSourceBucket('203.0.113.8'));
  });

  it('the digest is keyed: a different secret gives a different digest, and it is not a plain hash of the address', () => {
    const a = passwordSourceDigest('203.0.113.7', { OTP_HASH_SECRET: 'secret-one-for-the-test-of-keying' });
    const b = passwordSourceDigest('203.0.113.7', { OTP_HASH_SECRET: 'secret-two-for-the-test-of-keying' });
    expect(a).not.toBe(b);
    const unkeyed = createHash('sha256').update('swift:password-source:v1\0').update('203.0.113.7').digest('hex').slice(0, 32);
    expect([a, b]).not.toContain(unkeyed);
  });
});
