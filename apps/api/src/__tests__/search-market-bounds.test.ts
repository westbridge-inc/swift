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
