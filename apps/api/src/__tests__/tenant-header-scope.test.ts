import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandler } from '../middleware/error-handler';
import { apiFamilyOf, isVendorScopedPath, registerTenantHeaderScope, tenantHeaderMode, VENDOR_STORE_HEADER } from '../plugins/tenant-header-scope';
import { unexpectedTenantHeaderCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [MOB-010] The server's half of the vendor-store header scope.
//
// The vendor endpoint family is the only one that reads x-vendor-id. Outside
// it the header is a client leak: ignored (stripped before any handler sees
// it) by default, rejected on request, and counted per endpoint family either
// way. Driven through a real Fastify app with one echo route per family, so
// what a handler would actually see is what is asserted.
// ---------------------------------------------------------------------------

async function build(mode: 'ignore' | 'reject'): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerTenantHeaderScope(app, mode);
  const echo = async (request: { headers: Record<string, unknown> }) => ({ seen: request.headers[VENDOR_STORE_HEADER] ?? null });
  for (const path of ['/api/v1/vendor', '/api/v1/vendor/orders', '/api/v1/vendor/items/:id', '/api/v1/customer/home', '/api/v1/auth/me', '/api/v1/rider/online', '/api/v1/ads/serve', '/api/v1/safety/sos', '/api/v1/public/storefronts/:slug', '/api/v1/vendors/:id', '/health']) {
    app.get(path, echo);
    app.post(path, echo);
  }
  await app.ready();
  return app;
}

async function count(outcome: 'ignored' | 'rejected', family: string): Promise<number> {
  const metric = await unexpectedTenantHeaderCounter.get();
  return metric.values.find((v) => v.labels['outcome'] === outcome && v.labels['family'] === family)?.value ?? 0;
}

let ignore: FastifyInstance;
let reject: FastifyInstance;
beforeAll(async () => {
  ignore = await build('ignore');
  reject = await build('reject');
});
afterAll(async () => {
  await ignore.close();
  await reject.close();
});

describe('[MOB-010] the path decides the family', () => {
  it('scopes exactly the vendor family', () => {
    for (const p of ['/api/v1/vendor', '/api/v1/vendor/', '/api/v1/vendor/orders?x=1', '/api/v1/vendor/items/abc#f']) expect(isVendorScopedPath(p), p).toBe(true);
    for (const p of ['/api/v1/vendors/abc', '/api/v1/vendorx', '/api/v1/customer/vendor/items', '/api/v1', '/health', '/api/v1/auth/me?vendor=1', '/vendor/items']) expect(isVendorScopedPath(p), p).toBe(false);
    expect(apiFamilyOf('/api/v1/customer/home?x=1')).toBe('customer');
    expect(apiFamilyOf('/health')).toBe('health');
    expect(apiFamilyOf('/')).toBe('root');
    expect(tenantHeaderMode({})).toBe('ignore');
    expect(tenantHeaderMode({ TENANT_HEADER_OUTSIDE_VENDOR: 'reject' })).toBe('reject');
    expect(tenantHeaderMode({ TENANT_HEADER_OUTSIDE_VENDOR: 'anything-else' })).toBe('ignore');
  });
});

describe('[MOB-010] outside the vendor family the header never reaches a handler', () => {
  it('ignore mode: the vendor family sees the header; every other family sees NONE, and each occurrence is counted per family', async () => {
    for (const path of ['/api/v1/vendor', '/api/v1/vendor/orders', '/api/v1/vendor/items/i1']) {
      const res = await ignore.inject({ method: 'GET', url: path, headers: { [VENDOR_STORE_HEADER]: 'store-a' } });
      expect(res.statusCode, path).toBe(200);
      expect(res.json(), path).toEqual({ seen: 'store-a' });
    }
    const before = { customer: await count('ignored', 'customer'), auth: await count('ignored', 'auth'), rider: await count('ignored', 'rider'), ads: await count('ignored', 'ads'), safety: await count('ignored', 'safety'), public: await count('ignored', 'public'), vendors: await count('ignored', 'vendors'), health: await count('ignored', 'health') };
    const leaks: Array<[string, string]> = [['/api/v1/customer/home', 'customer'], ['/api/v1/auth/me', 'auth'], ['/api/v1/rider/online', 'rider'], ['/api/v1/ads/serve', 'ads'], ['/api/v1/safety/sos', 'safety'], ['/api/v1/public/storefronts/s1', 'public'], ['/api/v1/vendors/v1', 'vendors'], ['/health', 'health']];
    for (const [path, family] of leaks) {
      for (const method of ['GET', 'POST'] as const) {
        const res = await ignore.inject({ method, url: path, headers: { [VENDOR_STORE_HEADER]: 'store-a' }, ...(method === 'POST' ? { payload: {} } : {}) });
        expect(res.statusCode, `${method} ${path}`).toBe(200);
        expect(res.json(), `${method} ${path}`).toEqual({ seen: null });
      }
      expect(await count('ignored', family), family).toBe(before[family as keyof typeof before] + 2);
    }
    // a vendor request is never counted as a leak
    expect(await count('ignored', 'vendor')).toBe(0);
    expect(await count('rejected', 'vendor')).toBe(0);
  });

  it('no header, no effect: a plain request is untouched and uncounted', async () => {
    const before = await count('ignored', 'customer');
    const res = await ignore.inject({ method: 'GET', url: '/api/v1/customer/home' });
    expect(res.json()).toEqual({ seen: null });
    expect(await count('ignored', 'customer')).toBe(before);
  });

  it('reject mode: outside the vendor family the request is answered 400 UNEXPECTED_TENANT_HEADER and counted; the vendor family still passes', async () => {
    const before = await count('rejected', 'customer');
    const res = await reject.inject({ method: 'GET', url: '/api/v1/customer/home', headers: { [VENDOR_STORE_HEADER]: 'store-a' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'UNEXPECTED_TENANT_HEADER' } });
    expect(await count('rejected', 'customer')).toBe(before + 1);
    const ok = await reject.inject({ method: 'POST', url: '/api/v1/vendor/orders', headers: { [VENDOR_STORE_HEADER]: 'store-a' }, payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ seen: 'store-a' });
  });
});
