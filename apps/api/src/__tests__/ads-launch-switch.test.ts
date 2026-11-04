import Fastify, { type FastifyInstance, type HTTPMethods, type InjectOptions } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adsRoutes } from '../modules/ads/ads.routes';
import { publicRoutes } from '../modules/public/public.routes';
import { registerErrorHandler } from '../middleware/error-handler';

let app: FastifyInstance;
let routes: Array<{ method: HTTPMethods; url: string }>;
const authenticate = vi.fn(async () => undefined);
const findMany = vi.fn(async () => []);

beforeEach(async () => {
  routes = [];
  vi.clearAllMocks();
  app = Fastify();
  app.decorate('authenticate', authenticate);
  app.decorate('authenticateOptional', authenticate);
  app.decorate('prisma', { adPlacement: { findMany } } as unknown as FastifyInstance['prisma']);
  // The switch refuses by THROWING (so nothing after its hook can run); the
  // app's error handler writes the refusal, as it does in buildApp.
  registerErrorHandler(app);
  app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/api/v1/ads')) {
      for (const method of [route.method].flat()) {
        routes.push({ method, url: route.url.replace(/:[^/]+/g, 'test-id') });
      }
    }
  });
  await app.register(adsRoutes, { prefix: '/api/v1/ads' });
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  await app.ready();
});
afterEach(async () => { await app.close(); vi.unstubAllEnvs(); });

describe('launch advertising switch', () => {
  it.each([undefined, '', '0', 'false', 'true', 'yes'])('refuses every ads route before auth or effects when ADS_ENABLED=%s', async (flag) => {
    vi.stubEnv('ADS_ENABLED', flag);
    vi.stubEnv('NODE_ENV', 'production');
    expect(routes.length).toBeGreaterThanOrEqual(19);
    for (const route of routes) {
      const response = await app.inject(route as InjectOptions);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      if (route.method !== 'HEAD') expect(response.json()).toMatchObject({
        success: false, error: { code: 'ADS_DISABLED', message: 'Advertising is currently unavailable.' },
      });
    }
    expect(authenticate).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('allows enabled requests through the existing authentication and handler', async () => {
    vi.stubEnv('ADS_ENABLED', '1');
    const response = await app.inject('/api/v1/ads/placements');
    expect(response.statusCode).toBe(200);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledOnce();
    expect(response.json()).toEqual({ success: true, data: [] });
  });

  it('publishes the same uncached capability to guests and follows a runtime shutdown', async () => {
    for (const enabled of [true, false]) {
      vi.stubEnv('ADS_ENABLED', enabled ? '1' : '0');
      const response = await app.inject('/api/v1/public/capabilities');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({ success: true, data: { adsEnabled: enabled } });
      expect((await app.inject('/api/v1/ads/placements')).statusCode).toBe(enabled ? 200 : 403);
    }
  });
});

// [ADS-ON · owner ruling, 3 Nov] Production no longer refuses to boot with ads on. That lifts a refusal; it
// switches nothing on: the setting stays absent from every file a deploy reads, so ads stay off through soft
// launch, until the owner sets ADS_ENABLED=1 by hand, with or after ordering day.
describe('lifting the production lock turns nothing on', () => {
  const repo = resolve(__dirname, '../../../..');
  it.each([
    'deploy/.env.deploy.example',
    'apps/api/.env.example',
    'deploy/docker-compose.yml',
    'deploy/docker-compose.wall.yml',
  ])('%s sets no live ADS_ENABLED', (file) => {
    const live = readFileSync(resolve(repo, file), 'utf8').split('\n').filter((line) => /^\s*(-\s*)?ADS_ENABLED\s*[=:]/.test(line));
    expect(live).toEqual([]);
  });
});
