import { afterEach, describe, expect, it, vi } from 'vitest';
import { engine, guestSearchApp } from './helpers/guest-search';

// ---------------------------------------------------------------------------
// [Review S2-PRE · GUARDRAILS §8] The listing gate is the SAME for everyone.
//
// The shared listing gate (verification/category-gate.ts) keeps two kinds of
// listing out of public view: an item tagged ONLY in hidden discovery
// categories, and an item in a licence-gated category (BLOCK_LISTING) whose
// seller holds no valid licence. The Market feed applies it to every caller;
// search applied it to GUESTS only. A signed-in customer's search — the index
// path, the database path and the suggestions, and the trending rail — could
// list exactly what a guest was refused.
//
// The fixtures (helpers/guest-search) carry a licence-gated item with no
// licence on file ("Pepper gated"); this file adds one tagged only in a hidden
// category ("Pepper hushed"). A signed-in customer of the same operator must
// not see either, on any search door.
// ---------------------------------------------------------------------------

const apps: Awaited<ReturnType<typeof guestSearchApp>>[] = [];
async function setup() {
  const h = await guestSearchApp();
  apps.push(h);
  h.items.push({ ...h.items[0]!, id: 'hushed-item', name: 'Pepper hushed' });
  h.categories.push({ id: 'withdrawn', tenantId: 'public', status: 'HIDDEN', slug: 'withdrawn', kind: 'PRODUCT' });
  h.tags.push({ tenantId: 'public', itemId: 'hushed-item', categoryId: 'withdrawn' });
  return h;
}
afterEach(async () => { for (const h of apps.splice(0)) await h.app.close(); vi.unstubAllEnvs(); vi.clearAllMocks(); engine.ready = false; });

const DENIED = ['gated-item', 'hushed-item'];

describe('a signed-in customer gets the same listing gate as a guest', () => {
  it('/search on the database path', async () => {
    const { app, token } = await setup();
    const res = await app.inject({ url: '/api/v1/search?q=Pepper&limit=50', headers: { authorization: `Bearer ${token('public')}` } });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain('item-public'); // not vacuous: the ordinary dish is found
    for (const denied of DENIED) expect(ids).not.toContain(denied);
  });

  it('/search on the index path (the index holds the gated items; the live gate must refuse them)', async () => {
    engine.ready = true;
    const { app, token } = await setup();
    engine.items.mockResolvedValue({
      hits: ['gated-item', 'hushed-item', 'item-public'].map((id) => ({ entityId: id, name: `Pepper ${id}`, vendorId: 'public', vendorName: 'Pepper public' })),
      estimatedTotalHits: 3, processingTimeMs: 1,
    });
    engine.vendors.mockResolvedValue({ hits: [], estimatedTotalHits: 0, processingTimeMs: 1 });
    const res = await app.inject({ url: '/api/v1/search?q=Pepper&limit=50', headers: { authorization: `Bearer ${token('public')}` } });
    expect(res.statusCode).toBe(200);
    expect(engine.items).toHaveBeenCalled();
    const ids = (res.json().data.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain('item-public');
    for (const denied of DENIED) expect(ids).not.toContain(denied);
  });

  it('/search on the index path: the database top-up of a short index answer is gated too', async () => {
    engine.ready = true;
    const h = await setup();
    // a listing the index has not caught up with: only the top-up can find it
    h.items.push({ ...h.items[0]!, id: 'unindexed-item', name: 'Pepper unindexed' });
    engine.items.mockResolvedValue({
      hits: [{ entityId: 'item-public', name: 'Pepper dish public', vendorId: 'public' }],
      estimatedTotalHits: 1, processingTimeMs: 1,
    });
    engine.vendors.mockResolvedValue({ hits: [], estimatedTotalHits: 0, processingTimeMs: 1 });
    const res = await h.app.inject({ url: '/api/v1/search?q=Pepper&limit=50', headers: { authorization: `Bearer ${h.token('public')}` } });
    expect(res.statusCode).toBe(200);
    expect(engine.items).toHaveBeenCalled();
    const ids = (res.json().data.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain('item-public');
    expect(ids).toContain('unindexed-item'); // not vacuous: the top-up ran and found rows
    for (const denied of DENIED) expect(ids).not.toContain(denied);
  });

  it('/search/suggestions', async () => {
    const { app, token } = await setup();
    const res = await app.inject({ url: '/api/v1/search/suggestions?q=Pepper', headers: { authorization: `Bearer ${token('public')}` } });
    const texts = (res.json().data as Array<{ text: string }>).map((s) => s.text);
    expect(texts).toContain('Pepper dish public');
    expect(texts).not.toContain('Pepper gated');
    expect(texts).not.toContain('Pepper hushed');
  });

  it('/search/trending', async () => {
    const { app, token } = await setup();
    const res = await app.inject({ url: '/api/v1/search/trending', headers: { authorization: `Bearer ${token('public')}` } });
    const ids = (res.json().data as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain('item-public');
    for (const denied of DENIED) expect(ids).not.toContain(denied);
  });

  it('a guest is refused the same rows (unchanged)', async () => {
    const { app } = await setup();
    const ids = ((await app.inject({ url: '/api/v1/search?q=Pepper&limit=50' })).json().data.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain('item-public');
    for (const denied of DENIED) expect(ids).not.toContain(denied);
  });
});
