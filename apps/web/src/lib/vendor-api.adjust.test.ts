import { describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn(async (_path: string, _init?: RequestInit) => ({ data: {} })));
vi.mock('./auth', () => ({ apiFetch }));

import { adjustStock } from './vendor-api';

// [MASTER-025] A stock adjustment is one command. The page mints a key per
// adjustment as entered and the server answers a repeat of that key with the
// movement it already committed, so the key must reach the server on every send.
describe('[MASTER-025] adjustStock names the adjustment it sends', () => {
  it('sends the adjustment key as the Idempotency-Key header, with only the delta and reason in the body', async () => {
    await adjustStock('item-1', -3, 'DAMAGED', 'adjust-key-1');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetch.mock.calls[0]!;
    expect(path).toMatch(/\/items\/item-1\/adjust$/);
    expect(init).toMatchObject({ method: 'POST', headers: { 'Idempotency-Key': 'adjust-key-1' } });
    expect(JSON.parse(String(init!.body))).toEqual({ delta: -3, reason: 'DAMAGED' });
  });
});
