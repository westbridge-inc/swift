import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { rateLimitKey } from '../utils/rate-limit-key';

// SWIFT-AUD-D1-01 — the global limiter buckets requests by a VERIFIED principal
// (userId), never by a client-supplied bearer string. A fake token is not a
// bucket; it is an anonymous request and shares the resolved-IP bucket.

let app: FastifyInstance;
let generator: ReturnType<typeof rateLimitKey>;
let keyFor: (authorization: string | undefined, ip: string) => Promise<string>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  // Same pinning the auth plugin applies: HS256 only, short expiry.
  await app.register(jwt, {
    // Test-only keying value, registered on this instance only (same shape as
    // the other in-test webhook secrets); not a production credential.
    secret: 'test-rate-limit-key-jwt-0123456789abcdef',
    sign: { expiresIn: '15m' },
    verify: { algorithms: ['HS256'] },
  });
  await app.ready();
  generator = rateLimitKey((token) => app.jwt.verify(token));
  keyFor = (authorization: string | undefined, ip: string) =>
    generator({ headers: authorization ? { authorization } : {}, ip } as never);
});

afterAll(async () => {
  await app.close();
});

describe('rate-limit key (D1-01)', () => {
  it('buckets a verified user by userId, independent of the source IP', async () => {
    const tokenA = app.jwt.sign({ userId: 'user-aaaaaaaa', role: 'CUSTOMER' });
    const a = await keyFor(`Bearer ${tokenA}`, '10.0.0.1');
    const aOtherIp = await keyFor(`Bearer ${tokenA}`, '10.0.0.2');
    expect(a).toBe(aOtherIp); // same user → same bucket, even from a new IP
    expect(a.startsWith('u:')).toBe(true);
  });

  it('gives two verified users behind one NAT IP separate buckets', async () => {
    const tokenA = app.jwt.sign({ userId: 'user-aaaaaaaa', role: 'CUSTOMER' });
    const tokenB = app.jwt.sign({ userId: 'user-bbbbbbbb', role: 'CUSTOMER' });
    const userA = await keyFor(`Bearer ${tokenA}`, '10.0.0.1');
    const userB = await keyFor(`Bearer ${tokenB}`, '10.0.0.1'); // same IP, different user
    expect(userA).not.toBe(userB);
  });

  it('never places the token or the userId in plaintext in the key', async () => {
    const token = app.jwt.sign({ userId: 'victim-user-id', role: 'CUSTOMER' });
    const k = await keyFor(`Bearer ${token}`, '10.0.0.1');
    expect(k).not.toContain(token);
    expect(k).not.toContain('victim-user-id');
  });

  it('falls back to the resolved IP for anonymous requests', async () => {
    expect(await keyFor(undefined, '9.9.9.9')).toBe('9.9.9.9');
    expect(await keyFor('Bearer x', '9.9.9.9')).toBe('9.9.9.9'); // too short → anonymous
  });

  it('garbage bearer strings share the resolved-IP bucket (never their own)', async () => {
    // The audit's exploit: distinct fake tokens minted fresh buckets on the
    // old code. All must land on the caller's IP bucket now.
    const keys = await Promise.all(
      ['garbage-token-0-aaaa', 'garbage-token-1-bbbb', 'garbage-token-2-cccc'].map((t) =>
        keyFor(`Bearer ${t}`, '8.8.8.8'),
      ),
    );
    expect(keys).toEqual(['8.8.8.8', '8.8.8.8', '8.8.8.8']);
  });

  it('a forged / wrongly-signed token also shares the IP bucket', async () => {
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJmb3JnZXIifQ.bad-signature';
    expect(await keyFor(`Bearer ${forged}`, '8.8.8.8')).toBe('8.8.8.8');
  });

  it('an expired but validly signed token shares the IP bucket', async () => {
    const expired = app.jwt.sign({ userId: 'expired-user', role: 'CUSTOMER' }, { expiresIn: -10 });
    expect(await keyFor(`Bearer ${expired}`, '8.8.8.8')).toBe('8.8.8.8');
  });

  it('the anonymous fallback is the trustProxy-resolved req.ip, never a client-supplied X-Forwarded-For', async () => {
    // TRUST_PROXY decides upstream (in fastify) who may set req.ip; the key
    // generator must not read the header itself, or a forged token plus a
    // forged X-Forwarded-For would mint a fresh bucket per request again.
    const k = await generator({
      headers: { authorization: 'Bearer garbage-token-with-xff', 'x-forwarded-for': '1.2.3.4' },
      ip: '8.8.8.8',
    } as never);
    expect(k).toBe('8.8.8.8');
  });
});
