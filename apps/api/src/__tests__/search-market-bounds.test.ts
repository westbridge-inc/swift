import { afterEach, describe, expect, it, vi } from 'vitest';
import { guestSearchApp, engine } from './helpers/guest-search';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); engine.ready = false; });
const boundaries = [
  { name: 'north', inside: [8.9999, -58.15], outside: [9.0001, -58.15] },
  { name: 'south', inside: [1.0001, -58.15], outside: [0.9999, -58.15] },
  { name: 'west', inside: [6.8, -61.9999], outside: [6.8, -62.0001] },
  { name: 'east', inside: [6.8, -56.0001], outside: [6.8, -55.9999] },
];
for (const mode of ['guest', 'authenticated fallback', 'authenticated index']) describe(`/search market bounds — ${mode}`, () => {
  it.each(boundaries)('uses the live store pin on both sides of $name for vendors and items', async ({ inside, outside }) => {
    engine.ready = mode === 'authenticated index';
    const { app, vendors, items, token } = await guestSearchApp();
    try {
      const vendor = vendors.find((v) => v['id'] === (mode === 'guest' ? 'public' : 'other'))!;
      const item = items.find((i) => i['vendorId'] === vendor['id'])!;
      if (engine.ready) { vendor['id'] = 'indexed-vendor'; item['id'] = 'indexed-item'; item['vendorId'] = vendor['id']; }
      const headers = mode === 'guest' ? {} : { authorization: `Bearer ${token()}` };
      [vendor['latitude'], vendor['longitude']] = inside;
      const accepted = await app.inject({ url: '/api/v1/search?q=Pepper', headers });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().data.vendors.map((v: { id: string }) => v.id)).toContain(vendor['id']);
      expect(accepted.json().data.items.map((i: { id: string }) => i.id)).toContain(item['id']);
      [vendor['latitude'], vendor['longitude']] = outside;
      const refused = await app.inject({ url: '/api/v1/search?q=Pepper', headers });
      expect(refused.statusCode, refused.body).toBe(200);
      expect(refused.json().data.vendors.map((v: { id: string }) => v.id)).not.toContain(vendor['id']);
      expect(refused.json().data.items.map((i: { id: string }) => i.id)).not.toContain(item['id']);
      if (engine.ready) expect(engine.vendors).toHaveBeenCalledTimes(2);
    } finally { await app.close(); }
  });
});

// [DS982] The other search rails wear the same committed-pin predicate as /search.
for (const mode of ['guest', 'authenticated'] as const) describe(`search rails market bounds — ${mode}`, () => {
  async function setup(pin: number[]) {
    const ctx = await guestSearchApp();
    const vendor = ctx.vendors.find((v) => v['id'] === (mode === 'guest' ? 'public' : 'other'))!;
    [vendor['latitude'], vendor['longitude']] = pin;
    const headers = mode === 'guest' ? {} : { authorization: `Bearer ${ctx.token()}` };
    const read = async (url: string) => {
      const res = await ctx.app.inject({ url, headers });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().data as Array<{ id?: string; text?: string }>;
    };
    return { ...ctx, vendor, read };
  }

  it.each(boundaries)('/search/suggestions uses the live store pin on both sides of $name', async ({ inside, outside }) => {
    const { app, vendor, read } = await setup(inside);
    try {
      const texts = async () => (await read('/api/v1/search/suggestions?q=Pepper')).map((s) => s.text);
      expect(await texts()).toEqual(expect.arrayContaining([`Pepper ${vendor['id']}`, `Pepper dish ${vendor['id']}`]));
      [vendor['latitude'], vendor['longitude']] = outside;
      const refused = await texts();
      expect(refused).not.toContain(`Pepper ${vendor['id']}`);
      expect(refused).not.toContain(`Pepper dish ${vendor['id']}`);
    } finally { await app.close(); }
  });

  it.each(boundaries)('/search/trending uses the live store pin on both sides of $name', async ({ inside, outside }) => {
    const { app, vendor, read } = await setup(inside);
    try {
      const ids = async () => (await read('/api/v1/search/trending')).map((i) => i.id);
      expect(await ids()).toContain(`item-${vendor['id']}`);
      [vendor['latitude'], vendor['longitude']] = outside;
      expect(await ids()).not.toContain(`item-${vendor['id']}`);
    } finally { await app.close(); }
  });

  it.each(boundaries)('/search/nearby uses the live store pin on both sides of $name', async ({ inside, outside }) => {
    const { app, vendor, read } = await setup(inside);
    try {
      const near = async () => (await read(`/api/v1/search/nearby?lat=${inside[0]}&lng=${inside[1]}&radius=5`)).map((v) => v.id);
      expect(await near()).toContain(vendor['id']);
      [vendor['latitude'], vendor['longitude']] = outside;
      expect(await near()).not.toContain(vendor['id']);
    } finally { await app.close(); }
  });

  it.each(boundaries)('/search/nearby reads a caller just outside $name as no location: nothing is near it', async ({ inside, outside }) => {
    const { app, vendor, read } = await setup(inside);
    try {
      expect((await read(`/api/v1/search/nearby?lat=${inside[0]}&lng=${inside[1]}&radius=5`)).map((v) => v.id)).toContain(vendor['id']);
      expect(await read(`/api/v1/search/nearby?lat=${outside[0]}&lng=${outside[1]}&radius=5`)).toEqual([]);
    } finally { await app.close(); }
  });
});
