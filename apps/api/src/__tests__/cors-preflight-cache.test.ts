import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as corsPolicy from '../utils/cors-origin';

// PERF #1 (15 Oct): the website paid an extra OPTIONS round trip before nearly
// every repeated API call, because the preflight answer carried no max-age and
// Chrome keeps one for 5 s by default. The API now lets the browser reuse an
// answer for 2 h. These cases pin the cache AND that nothing else about the
// policy moved: same allowlist, same credentials rule, unknown origins still
// get no CORS grant.

const ALLOWED = 'https://swiftgy.com';
const OTHER = 'https://evil.example';

type CorsOptions = { origin: string[] | false; credentials: true; maxAge: number };
const optionsFor = (origin: string[] | false): CorsOptions => {
  const build = (corsPolicy as Record<string, unknown>)['corsPluginOptions'];
  expect(typeof build, 'cors-origin.ts exports corsPluginOptions').toBe('function');
  return (build as (o: string[] | false) => CorsOptions)(origin);
};

async function appWith(origin: string[] | false): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, optionsFor(origin));
  app.get('/api/v1/customer/home', async () => ({ ok: true }));
  await app.ready();
  return app;
}

function preflight(app: FastifyInstance, origin: string) {
  return app.inject({
    method: 'OPTIONS',
    url: '/api/v1/customer/home',
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization,x-swift-client',
    },
  });
}

describe('CORS preflight answers are cacheable (PERF #1)', () => {
  let app: FastifyInstance;
  let closed: FastifyInstance;
  beforeAll(async () => {
    app = await appWith(corsPolicy.resolveCorsOrigins(`${ALLOWED},https://app.swiftgy.com`, 'production') as string[]);
    closed = await appWith(corsPolicy.resolveCorsOrigins(undefined, 'production'));
  });
  afterAll(async () => {
    await app.close();
    await closed.close();
  });

  it('an allowed origin gets a 2-hour preflight cache (Chrome caps at 7200 s)', async () => {
    const res = await preflight(app, ALLOWED);
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-max-age']).toBe('7200');
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('an origin outside the allowlist still gets no CORS grant (posture unchanged)', async () => {
    const res = await preflight(app, OTHER);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const real = await app.inject({ method: 'GET', url: '/api/v1/customer/home', headers: { origin: OTHER } });
    expect(real.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('the real response still carries its own origin check and credentials rule', async () => {
    const real = await app.inject({ method: 'GET', url: '/api/v1/customer/home', headers: { origin: ALLOWED } });
    expect(real.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(real.headers['access-control-allow-credentials']).toBe('true');
    expect(real.headers['vary']).toMatch(/Origin/);
  });

  it('production with no allowlist stays fail-closed', async () => {
    const res = await preflight(closed, ALLOWED);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(optionsFor(false)).toEqual({ origin: false, credentials: true, maxAge: 7200 });
  });

  it('app.ts registers @fastify/cors with exactly these options', () => {
    const src = readFileSync(join(__dirname, '..', 'app.ts'), 'utf8');
    expect(src).toMatch(/await app\.register\(cors, corsPluginOptions\(corsOrigin\)\);/);
    expect(src.match(/app\.register\(cors\b/g)).toHaveLength(1);
  });
});
