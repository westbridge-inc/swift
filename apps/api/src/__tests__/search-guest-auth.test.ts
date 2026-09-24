import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBrowserOriginsForTests } from '../modules/auth/browser-session';
import { engine, guestSearchApp } from './helpers/guest-search';

const apps: Awaited<ReturnType<typeof guestSearchApp>>[] = [];
async function setup(max?: number) { const h = await guestSearchApp(max); apps.push(h); return h; }
afterEach(async () => { for (const h of apps.splice(0)) await h.app.close(); vi.unstubAllEnvs(); vi.clearAllMocks(); engine.ready = false; });
const reads = ['/search?q=Pepper', '/search/suggestions?q=Pepper', '/search/trending', '/search/nearby?lat=6.8&lng=-58.15'];

describe('guest catalogue search through real HTTP routes', () => {
  it.each(reads)('%s exposes only the public eligible catalogue', async (url) => {
    const { app } = await setup();
    const response = await app.inject(`/api/v1${url}`);
    expect(response.statusCode).toBe(200);
    const text = response.body;
    expect(text).toContain('Pepper');
    for (const denied of ['other', 'review', 'dead', 'suspended', 'unverified', 'unpublished', 'hidden', 'gated', 'private-', 'tenantId', 'ownerId', 'stockQuantity', 'totalOrdered']) expect(text).not.toContain(denied);
    const data = response.json().data;
    if (url.startsWith('/search?')) {
      expect(data.vendors.map((v: { id: string }) => v.id)).toEqual(['public']);
      expect(data.items.map((v: { id: string }) => v.id)).toEqual(['item-public']);
    } else if (url.includes('suggestions')) {
      expect(data).toEqual([{ text: 'Pepper public', type: 'vendor' }, { text: 'Pepper dish public', type: 'item' }]);
    } else expect(data.map((v: { id: string }) => v.id)).toEqual([url.includes('nearby') ? 'public' : 'item-public']);
  });
  it('does not trust a ready index for guest eligibility or projection', async () => {
    engine.ready = true;
    const { app } = await setup();
    const res = await app.inject('/api/v1/search?q=Pepper');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.items.map((i: { id: string }) => i.id)).toEqual(['item-public']);
    expect(engine.vendors).not.toHaveBeenCalled(); expect(engine.items).not.toHaveBeenCalled();
  });
  it.each(['dead', 'review', 'missing'])('refuses an ineligible public tenant %s', async (tenant) => {
    const { app, db } = await setup(); vi.stubEnv('PUBLIC_TENANT_ID', tenant);
    const res = await app.inject('/api/v1/search?q=Pepper');
    expect(res.statusCode).toBe(503); expect(res.json().error.code).toBe('PUBLIC_TENANT_UNRESOLVED');
    expect(db.item.findMany).not.toHaveBeenCalled();
  });
  it('refuses ambiguous public scope, and ignores a caller-supplied tenant', async () => {
    const { app } = await setup();
    const result = await app.inject('/api/v1/search?q=Pepper&tenantId=other');
    expect(result.statusCode).toBe(200); expect(result.body).not.toContain('Pepper other');
    vi.stubEnv('PUBLIC_TENANT_ID', '');
    expect((await app.inject('/api/v1/search?q=Pepper')).statusCode).toBe(503);
  });
  it('keeps validation, short query handling and exact type filtering', async () => {
    const { app } = await setup();
    expect((await app.inject('/api/v1/search?q=P')).json().data).toEqual({ vendors: [], items: [] });
    for (const query of ['limit=51', 'type=NOT_A_TYPE', 'lat=91']) expect((await app.inject(`/api/v1/search?q=Pepper&${query}`)).statusCode).toBe(400);
    expect((await app.inject('/api/v1/search?q=Pepper&type=SUPERMARKET')).json().data.vendors).toEqual([]);
  });
  it('retains the global anonymous IP rate limit', async () => {
    const { app } = await setup(2);
    expect((await app.inject('/api/v1/search?q=P')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/search?q=P')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/search?q=P')).statusCode).toBe(429);
  });
  it('returns the safe error envelope when catalogue reads fail', async () => {
    const { app, db } = await setup(); db.item.findMany.mockRejectedValueOnce(new Error('private database detail'));
    const res = await app.inject('/api/v1/search?q=Pepper');
    expect(res.statusCode).toBe(500); expect(res.json()).toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  });
  it.each(reads)('keeps authenticated tenant scope on %s', async (url) => {
    const { app, token, db } = await setup();
    const res = await app.inject({ url: `/api/v1${url}`, headers: { authorization: `Bearer ${token()}` } });
    expect(res.statusCode).toBe(200); expect(res.body).toContain('Pepper'); expect(res.body).toContain('other'); expect(res.body).not.toContain('Pepper public');
    expect(db.tenant.findUnique).not.toHaveBeenCalled();
  });
  it('preserves the authenticated engine path and exact filter arguments', async () => {
    engine.ready = true; const { app, token, vendors, items } = await setup();
    // A ranked index hit also needs its live catalogue row.
    vendors.find((v) => v['id'] === 'other')!['id'] = 'indexed-vendor';
    const item = items.find((i) => i['id'] === 'item-other')!;
    item['id'] = 'indexed-item'; item['vendorId'] = 'indexed-vendor';
    const res = await app.inject({ url: '/api/v1/search?q=Pepper&type=RESTAURANT&cuisine=Creole&limit=3', headers: { authorization: `Bearer ${token()}` } });
    expect(res.statusCode).toBe(200); expect(res.json().data.items[0].id).toBe('indexed-item');
    expect(engine.vendors).toHaveBeenCalledWith('other', 'Pepper', { type: 'RESTAURANT', cuisine: 'Creole', openOnly: true, limit: 3 });
  });
  it('preserves cookie-authenticated scope and revoked-session refusals', async () => {
    const { app, token, sessions } = await setup();
    vi.stubEnv('CORS_ORIGIN', 'https://web.test'); resetBrowserOriginsForTests();
    const value = token();
    const headers = { cookie: `swift_at=${value}`, origin: 'https://web.test', 'x-swift-client': 'web' };
    const res = await app.inject({ url: '/api/v1/search?q=Pepper', headers });
    expect(res.statusCode).toBe(200); expect(res.body).toContain('Pepper other'); expect(res.body).not.toContain('Pepper public');
    sessions.clear();
    expect((await app.inject({ url: '/api/v1/search?q=Pepper', headers })).statusCode).toBe(401);
    resetBrowserOriginsForTests();
  });
  it('uses the live document gate: valid and warning-only listings stay public', async () => {
    const { app, db } = await setup();
    db.verificationDocument.findFirst.mockResolvedValue({ id: 'approved-document' });
    expect((await app.inject('/api/v1/search?q=Pepper')).json().data.items.map((i: { id: string }) => i.id)).toEqual(['item-public', 'gated-item']);
    db.verificationDocument.findFirst.mockResolvedValue(null);
    const gates = await db.categoryDocumentGate.findMany(); gates[0]!.enforcement = 'WARN';
    db.categoryDocumentGate.findMany.mockResolvedValue(gates);
    expect((await app.inject('/api/v1/search/trending')).json().data.map((i: { id: string }) => i.id)).toEqual(['item-public', 'gated-item']);
  });
  it('keeps concurrent guest and signed-in searches in separate tenants', async () => {
    const { app, token } = await setup();
    const [guest, signedIn] = await Promise.all([
      app.inject('/api/v1/search?q=Pepper'),
      app.inject({ url: '/api/v1/search?q=Pepper', headers: { authorization: `Bearer ${token()}` } }),
    ]);
    expect(guest.json().data.items.map((i: { id: string }) => i.id)).toEqual(['item-public']);
    expect(signedIn.json().data.items.map((i: { id: string }) => i.id)).toEqual(['item-other']);
  });
  it('keeps ready-index sync available only to an administrator', async () => {
    engine.ready = true; const { app, token } = await setup();
    engine.syncVendors.mockClear(); engine.syncItems.mockClear();
    const res = await app.inject({ method: 'POST', url: '/api/v1/search/sync', headers: { authorization: `Bearer ${token('other', 'ADMIN')}` } });
    expect(res.statusCode).toBe(200); expect(engine.syncVendors).toHaveBeenCalledOnce(); expect(engine.syncItems).toHaveBeenCalledOnce();
  });
  it('keeps invalid sessions refused and sync authenticated/admin-only', async () => {
    const { app, token } = await setup();
    expect((await app.inject({ url: '/api/v1/search?q=Pepper', headers: { authorization: 'Bearer invalid' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/search/sync' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/search/sync', headers: { authorization: `Bearer ${token()}` } })).statusCode).toBe(403);
    const admin = await app.inject({ method: 'POST', url: '/api/v1/search/sync', headers: { authorization: `Bearer ${token('other', 'ADMIN')}` } });
    expect(admin.statusCode).toBe(503); expect(admin.json().error.code).toBe('UNAVAILABLE');
  });
});
