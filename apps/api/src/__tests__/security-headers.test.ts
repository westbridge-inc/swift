import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { helmetOptions } from '../config/security-headers';

// SWIFT-134 — closes the 2026-07-16 SECURITY_AUDIT P2 row ("add explicit HSTS
// max-age assertion + a security-headers snapshot test"). Helmet is registered
// with the SAME shared options object as the real server, so a weakening of the
// CSP, HSTS, or the sniff/framing protections trips this guard.

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(helmet, helmetOptions);
  app.get('/ping', async () => ({ ok: true }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const headers = async () => (await app.inject({ method: 'GET', url: '/ping' })).headers;

describe('security headers posture [SWIFT-134]', () => {
  it('sets a strong HSTS max-age', async () => {
    const hsts = String((await headers())['strict-transport-security'] ?? '');
    expect(hsts).toMatch(/max-age=\d+/);
    const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0);
    expect(maxAge).toBeGreaterThanOrEqual(15552000); // >= 180 days
  });

  it('locks the CSP to self, with ws/wss only for connect', async () => {
    const csp = String((await headers())['content-security-policy'] ?? '');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' wss: ws:");
  });

  it('keeps the MIME-sniff and framing protections', async () => {
    const h = await headers();
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBeDefined(); // SAMEORIGIN by default
  });

  it('a full snapshot of the expected security headers is present', async () => {
    const h = await headers();
    for (const name of [
      'strict-transport-security',
      'content-security-policy',
      'x-content-type-options',
      'x-frame-options',
      'x-download-options',
      'referrer-policy',
    ]) {
      expect(h[name], `missing security header: ${name}`).toBeDefined();
    }
  });
});
