import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerReadinessRoute } from '../plugins/readiness';

afterEach(() => vi.unstubAllEnvs());

describe('readiness names a routing outage', () => {
  it.each(['degraded', 'ok'] as const)('routing %s is reported without removing safety endpoints from service', async (status) => {
    const app = Fastify();
    const now = Date.now();
    app.decorate('prisma', { $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = Array.from(parts).join(' ');
      if (sql.includes('information_schema.columns') || sql.includes('FROM "_prisma_migrations"')) return [{ ok: true }];
      return [{ nowMs: BigInt(now) }];
    }) } as never);
    app.decorate('redis', { ping: async () => 'PONG', time: async () => [String(Math.floor(now / 1000)), String(now % 1000 * 1000)] } as never);
    const routing = status === 'ok' ? { status, provider: 'osrm', km: 8.1 } : { status, provider: 'osrm', why: 'Road routing is unavailable.' };
    const checkRouting = vi.fn(async () => routing);
    registerReadinessRoute(app, { checkQueues: () => true, checkRouting } as Parameters<typeof registerReadinessRoute>[1]);
    try {
      const res = await app.inject('/ready');
      expect(checkRouting).toHaveBeenCalledOnce();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ready: true, routing, reasons: [] });
    } finally { await app.close(); }
  });
});

describe('the application exposes routing degradation', () => {
  it('health detail and readiness use the same bounded road probe', async () => {
    vi.stubEnv('MAPS_PROVIDER', 'osrm');
    vi.stubEnv('OSRM_URL', 'http://osrm.test');
    vi.stubEnv('RUN_WORKERS', '0');
    vi.stubEnv('LOG_LEVEL', 'silent');
    vi.stubEnv('HEALTH_DETAIL_TOKEN', 'routing-fixture-detail');
    const fetch = vi.fn(async (_url: unknown) => { throw new Error('unreachable'); });
    vi.stubGlobal('fetch', fetch);
    const { buildApp } = await import('../app');
    const app = await buildApp();
    try {
      await app.ready();
      vi.stubEnv('NODE_ENV', 'production');
      const responses = await Promise.all(['/health', '/ready'].map((url) => app.inject({ url, headers: { 'x-health-detail': 'routing-fixture-detail' } })));
      for (const res of responses) expect(res.json()).toMatchObject({ routing: { status: 'degraded', provider: 'osrm' } });
      // App startup also probes search. Count the routing requests, not those
      // unrelated fetches; both HTTP probes must share exactly one road call.
      expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('http://osrm.test/route/'))).toHaveLength(1);
      const publicHealth = await app.inject('/health');
      expect(publicHealth.json()).not.toHaveProperty('routing');
    } finally {
      await app.close();
      vi.unstubAllGlobals();
    }
  });
});
