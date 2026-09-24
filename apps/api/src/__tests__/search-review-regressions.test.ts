import { afterEach, describe, expect, it, vi } from 'vitest';
import { guestSearchApp, engine, matches } from './helpers/guest-search';
import { resetBrowserOriginsForTests } from '../modules/auth/browser-session';
import { isVendorVisible, VISIBLE_VENDOR_REL } from '../modules/vendor/vendor-visibility';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); engine.ready = false; resetBrowserOriginsForTests(); });

it('observes whether an expired access cookie without browser headers downgrades', async () => {
  const { app, token, sessions } = await guestSearchApp();
  try {
    const expired = token();
    sessions.clear();
    const res = await app.inject({ url: '/api/v1/search?q=Pepper', headers: { cookie: `swift_at=${expired}` } });
    expect(res.statusCode).toBe(401);
  } finally { await app.close(); }
});

it('observes whether a closed public store appears in guest text search', async () => {
  const { app, vendors } = await guestSearchApp();
  try {
    vendors.find((v) => v['id'] === 'public')!['isCurrentlyOpen'] = false;
    const res = await app.inject('/api/v1/search?q=Pepper');
    expect(res.json().data.vendors.some((v: { id: string }) => v.id === 'public')).toBe(false);
  } finally { await app.close(); }
});

it('observes whether guest nearby is bounded at the database', async () => {
  const { app, db } = await guestSearchApp();
  try {
    await app.inject('/api/v1/search/nearby?lat=6.8&lng=-58.15');
    const query = db.vendor.findMany.mock.calls[0]![0]!;
    expect(query['take']).toBeGreaterThan(0);
  } finally { await app.close(); }
});

it('observes whether a PAUSED subscription alone hides an otherwise active vendor', async () => {
  const { app, vendors } = await guestSearchApp();
  try {
    vendors.find((v) => v['id'] === 'public')!['subscription'] = { status: 'PAUSED' };
    const res = await app.inject('/api/v1/search?q=Pepper');
    expect(res.json().data.vendors.some((v: { id: string }) => v.id === 'public')).toBe(false);
  } finally { await app.close(); }
});

it('observes whether a sole HIDDEN discovery category hides a tagged item', async () => {
  const { app, db, items } = await guestSearchApp();
  try {
    items.push({ ...items.find((i) => i['id'] === 'item-public'), id: 'hidden-category-item', name: 'Pepper hidden category' });
    db.discoveryCategory.findMany.mockResolvedValue([]);
    db.itemDiscoveryCategory.findMany.mockResolvedValue([{ itemId: 'hidden-category-item', categoryId: 'hidden-category' }]);
    const res = await app.inject('/api/v1/search?q=Pepper');
    expect(res.json().data.items.some((i: { id: string }) => i.id === 'hidden-category-item')).toBe(false);
  } finally { await app.close(); }
});

const reads = ['/search?q=Pepper', '/search/suggestions?q=Pepper', '/search/trending', '/search/nearby?lat=6.8&lng=-58.15'];

describe('credential material never becomes an anonymous read', () => {
  it.each(reads)('refuses rejected access/session cookies on %s', async (url) => {
    const { app, token, sessions, db } = await guestSearchApp();
    try {
      vi.stubEnv('CORS_ORIGIN', 'https://web.test'); resetBrowserOriginsForTests();
      const value = token(); sessions.clear();
      const variants = [
        { cookie: `swift_at=${value}` },
        { cookie: `swift_at=${value}`, 'x-swift-client': 'unknown', origin: 'https://web.test' },
        { cookie: `swift_at=${value}`, 'x-swift-client': 'web', origin: 'https://rejected.test' },
        { cookie: `swift_at=${value}`, 'x-swift-client': 'web', referer: 'https://rejected.test/page' },
        { cookie: 'swift_at=' }, { cookie: 'swift_at=%ZZ' }, { cookie: 'swift_rt=invalid' },
        { authorization: '' }, { authorization: 'Basic invalid' },
      ];
      for (const headers of variants) {
        const res = await app.inject({ url: `/api/v1${url}`, headers });
        expect(res.statusCode).toBe(401);
      }
      expect(db.tenant.findUnique).not.toHaveBeenCalled();
      expect(db.item.findMany).not.toHaveBeenCalled();
      expect(db.vendor.findMany).not.toHaveBeenCalled();
      expect((await app.inject({ url: `/api/v1${url}`, headers: { cookie: 'theme=dark' } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});

it.each(['/search?q=Pepper', '/search/suggestions?q=Pepper'])('closed vendors and items stay out of %s', async (url) => {
  const { app, vendors } = await guestSearchApp();
  try {
    vendors.find((v) => v['id'] === 'public')!['isCurrentlyOpen'] = false;
    const res = await app.inject(`/api/v1${url}`);
    expect(res.statusCode).toBe(200); expect(res.body).not.toContain('Pepper');
  } finally { await app.close(); }
});

const now = Date.now();
const subscriptionCases = [
  ['legacy', null, true],
  ['trial', { status: 'TRIAL', gracePeriodEnd: null }, true],
  ['active', { status: 'ACTIVE', gracePeriodEnd: null }, true],
  ['grace', { status: 'PAST_DUE', gracePeriodEnd: new Date(now + 86_400_000) }, true],
  ['no deadline', { status: 'PAST_DUE', gracePeriodEnd: null }, true],
  ['lapsed', { status: 'PAST_DUE', gracePeriodEnd: new Date(now - 86_400_000) }, false],
  ...(['PAUSED', 'SUSPENDED', 'CANCELLED', 'CHURNED'] as const).map((status) => [status, { status, gracePeriodEnd: null }, false] as const),
] as const;

it.each(subscriptionCases)('shared visibility preserves the operate-gate outcome for %s', (_name, subscription, visible) => {
  const vendor = { status: 'ACTIVE', isVerified: true, tenant: { isActive: true }, subscription };
  expect(matches(vendor, VISIBLE_VENDOR_REL)).toBe(visible);
  expect(isVendorVisible(vendor)).toBe(visible);
});

it.each(subscriptionCases)('Market and authenticated DB search obey shared subscription visibility: %s', async (_name, subscription, visible) => {
  const { app, vendors, token } = await guestSearchApp();
  try {
    const vendor = vendors.find((v) => v['id'] === 'public')!;
    vendor['vendorType'] = 'STORE'; vendor['subscription'] = subscription;
    for (const request of [
      { url: '/api/v1/market/items' },
      { url: '/api/v1/search?q=Pepper', headers: { authorization: `Bearer ${token('public')}` } },
    ]) {
      const res = await app.inject(request);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.items.some((i: { id: string }) => i.id === 'item-public')).toBe(visible);
      if (request.url.includes('/search?')) expect(res.json().data.vendors.some((v: { id: string }) => v.id === 'public')).toBe(visible);
    }
  } finally { await app.close(); }
});

it.each(subscriptionCases)('authenticated index hits respect live shared subscription visibility: %s', async (_name, subscription, visible) => {
  engine.ready = true;
  const { app, vendors, token } = await guestSearchApp();
  try {
    vendors.find((v) => v['id'] === 'public')!['subscription'] = subscription;
    engine.vendors.mockResolvedValueOnce({ hits: [{ entityId: 'public', name: 'Pepper public', vendorType: 'RESTAURANT' }], estimatedTotalHits: 1, processingTimeMs: 1 });
    engine.items.mockResolvedValueOnce({ hits: [{ entityId: 'item-public', name: 'Pepper dish public', vendorId: 'public' }], estimatedTotalHits: 1, processingTimeMs: 1 });
    const res = await app.inject({ url: '/api/v1/search?q=Pepper', headers: { authorization: `Bearer ${token('public')}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.vendors.some((v: { id: string }) => v.id === 'public')).toBe(visible);
    expect(res.json().data.items.some((i: { id: string }) => i.id === 'item-public')).toBe(visible);
  } finally { await app.close(); }
});

it.each(['/search?q=Pepper', '/search/suggestions?q=Pepper', '/search/trending', '/market/items'])('shared category projection on %s hides hidden-only tags, preserving active, mixed and untagged items', async (url) => {
  const { app, vendors, items, categories, tags } = await guestSearchApp();
  try {
    vendors.find((v) => v['id'] === 'public')!['vendorType'] = 'STORE';
    categories.push({ id: 'hidden-category', tenantId: 'public', status: 'HIDDEN', slug: 'hidden', kind: 'PRODUCT' });
    categories.push({ id: 'active-category', tenantId: 'public', status: 'ACTIVE', slug: 'active', kind: 'PRODUCT' });
    for (const [id, tagIds] of [['only-hidden', ['hidden-category']], ['mixed-tags', ['hidden-category', 'active-category']], ['only-active', ['active-category']]] as const) {
      items.push({ ...items[0], id, name: `Pepper ${id}` });
      for (const categoryId of tagIds) tags.push({ tenantId: 'public', itemId: id, categoryId });
    }
    const res = await app.inject(`/api/v1${url}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('only-hidden');
    expect(res.body).not.toContain('Pepper gated');
    expect(res.body).toContain('Pepper dish public');
    expect(res.body).toContain('mixed-tags');
    if (!url.includes('suggestions')) expect(res.body).toContain('only-active');
  } finally { await app.close(); }
});

it('bounds nearby DB candidates and responses, validates limits, and retains anonymous throttling', async () => {
  const { app, db, vendors, items } = await guestSearchApp(5);
  try {
    for (let n = 0; n < 70; n++) vendors.push({ ...vendors[0], id: `near-${n}`, items: [items[0]] });
    const res = await app.inject('/api/v1/search/nearby?lat=6.8&lng=-58.15&limit=3');
    expect(res.statusCode).toBe(200); expect(res.json().data).toHaveLength(3);
    expect(db.vendor.findMany.mock.calls[0]![0]!['take']).toBe(3);
    const defaults = await app.inject('/api/v1/search/nearby?lat=6.8&lng=-58.15');
    expect(defaults.json().data).toHaveLength(20);
    for (const limit of [0, 51]) expect((await app.inject(`/api/v1/search/nearby?lat=6.8&lng=-58.15&limit=${limit}`)).statusCode).toBe(400);
    expect((await app.inject('/api/v1/search/nearby?lat=6.8&lng=-58.15&radius=0.001')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/search/nearby?lat=6.8&lng=-58.15')).statusCode).toBe(429);
  } finally { await app.close(); }
});

it('honors cuisine in the guest DB vendor search', async () => {
  const { app } = await guestSearchApp();
  try {
    expect((await app.inject('/api/v1/search?q=Pepper&cuisine=Creole')).json().data.vendors).toHaveLength(1);
    expect((await app.inject('/api/v1/search?q=Pepper&cuisine=Italian')).json().data.vendors).toEqual([]);
  } finally { await app.close(); }
});

it('evaluates grace expiry at read time, including the exact deadline', () => {
  const deadline = new Date('2026-09-23T12:00:00Z');
  const vendor = { status: 'ACTIVE', isVerified: true, tenant: { isActive: true }, subscription: { status: 'PAST_DUE' as const, gracePeriodEnd: deadline } };
  vi.useFakeTimers();
  try {
    for (const [offset, visible] of [[-1, true], [0, true], [1, false]] as const) {
      vi.setSystemTime(deadline.getTime() + offset);
      expect(matches(vendor, VISIBLE_VENDOR_REL)).toBe(visible);
      expect(isVendorVisible(vendor)).toBe(visible);
    }
  } finally { vi.useRealTimers(); }
});

it('keeps nearby radius filtering inside the bounded candidate page', async () => {
  const { app, vendors } = await guestSearchApp();
  try {
    vendors[0]!['latitude'] = 7.8;
    const res = await app.inject('/api/v1/search/nearby?lat=6.8&lng=-58.15&radius=1&limit=50');
    expect(res.statusCode).toBe(200); expect(res.json().data).toEqual([]);
  } finally { await app.close(); }
});
