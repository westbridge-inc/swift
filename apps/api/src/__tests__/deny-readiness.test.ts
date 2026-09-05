/**
 * [STA-1 4.1 / DL-7] Deny-readiness — every public GET survives
 * TENANT_UNSCOPED_ACCESS=deny.
 *
 * assertTenantWall requires `deny` in production once a second tenant exists.
 * Under deny, an unauthenticated GET that touches a tenant model without
 * binding a tenant is a 500 (TENANT_CONTEXT_REQUIRED) — measured on /home
 * before the public-browse hook. This suite builds the whole app, calls every
 * GET route anonymously under deny, and RATCHETS the set that fails that way:
 * it must equal the checked-in register, which only shrinks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { buildApp } from '../app';

/** Public GETs known to reach a tenant model unbound under deny. Fix, then remove. */
export const DENY_UNREADY_GETS: readonly string[] = [];

let app: FastifyInstance;
const routes: RouteOptions[] = [];
const priorPolicy = process.env['TENANT_UNSCOPED_ACCESS'];

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  app = await buildApp({ onRoute: (r) => { routes.push(r); } });
  await app.ready();
});

afterAll(async () => {
  if (priorPolicy === undefined) delete process.env['TENANT_UNSCOPED_ACCESS']; else process.env['TENANT_UNSCOPED_ACCESS'] = priorPolicy;
  await app.close();
});

const withDummyParams = (url: string) => url.replace(/:[a-zA-Z_]+\??/g, 'x').replace(/\*/g, 'x');
const isGet = (r: RouteOptions) => (Array.isArray(r.method) ? r.method : [r.method]).includes('GET');

describe('[STA-1 4.1] deny-readiness of every public GET', () => {
  it('the census is not vacuous', () => {
    expect(routes.filter(isGet).length).toBeGreaterThan(50);
  });

  it('every GET answered anonymously under deny without TENANT_CONTEXT_REQUIRED, except the register — which only shrinks', async () => {
    const unready: string[] = [];
    for (const r of routes.filter(isGet)) {
      const res = await app.inject({ method: 'GET', url: withDummyParams(r.url) });
      const body = res.body;
      if (res.statusCode === 500 && /TENANT_CONTEXT_REQUIRED/.test(body)) unready.push(r.url);
    }
    expect(unready.sort()).toEqual([...DENY_UNREADY_GETS].sort());
  }, 120_000);
});
