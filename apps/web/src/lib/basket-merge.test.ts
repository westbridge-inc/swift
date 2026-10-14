import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addGuestLine, prepareGuestMerge, readGuestBasket } from './basket';
import { uploadGuestBasket } from './basket-merge';
import * as auth from './auth';
import * as customer from './customer';
const input = { vendorId: 'v1', vendorName: 'Fixture Menu', storeSlug: 'fixture-menu', itemId: 'soup', name: 'Soup', quantity: 2, unitPrice: 800, selectedOptions: {} };
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
describe('uploading a browser basket', () => {
  it('sends only IDs, quantity and the observed price with a stable key, then clears a confirmed upload', async () => {
    addGuestLine(input); const pending = prepareGuestMerge('customer-a')!;
    const fetch = vi.spyOn(auth, 'apiFetch').mockResolvedValue({ data: { applied: true, verdicts: [{ clientLineId: pending.lines[0]!.clientLineId, status: 'ADDED' }], cart: { items: [] } } } as never);
    expect((await uploadGuestBasket('customer-a'))?.applied).toBe(true);
    const [, request, options] = fetch.mock.calls[0]!;
    expect(request?.headers).toEqual({ 'Idempotency-Key': pending.key }); expect(options).toEqual({ redirectOnExpired: false });
    expect(JSON.parse(String(request?.body))).toEqual({ lines: [{ clientLineId: pending.lines[0]!.clientLineId, vendorId: 'v1', itemId: 'soup', quantity: 2, expectedUnitPrice: 800, selectedOptions: {} }] });
    expect(readGuestBasket().lines).toEqual([]);
  });
  it('keeps the exact upload after a lost response and retries it without a new key', async () => {
    addGuestLine(input); const fetch = vi.spyOn(auth, 'apiFetch').mockRejectedValue(new Error('connection lost'));
    await expect(uploadGuestBasket('customer-a')).rejects.toThrow('connection lost');
    const pending = readGuestBasket().pending!; expect(pending).toBeTruthy();
    await expect(uploadGuestBasket('customer-a')).rejects.toThrow('connection lost');
    expect(fetch.mock.calls.map(c => c[1]?.headers)).toEqual([{ 'Idempotency-Key': pending.key }, { 'Idempotency-Key': pending.key }]);
    expect(readGuestBasket().lines).toHaveLength(1);
  });
  it('keeps rejected lines for review and never accepts a malformed success answer', async () => {
    addGuestLine(input); const pending = prepareGuestMerge('customer-a')!;
    const fetch = vi.spyOn(auth, 'apiFetch').mockResolvedValueOnce({ data: { applied: false, verdicts: [{ clientLineId: pending.lines[0]!.clientLineId, status: 'PRICE_CHANGED', unitPrice: 900 }], cart: null } } as never);
    expect((await uploadGuestBasket('customer-a'))?.applied).toBe(false);
    expect(readGuestBasket().lines[0]?.unitPrice).toBe(800); expect(readGuestBasket().pending).toBeUndefined();
    fetch.mockResolvedValue({ data: { applied: true, verdicts: [], cart: null } } as never);
    await expect(uploadGuestBasket('customer-a')).rejects.toThrow(/confirm/); expect(readGuestBasket().pending).toBeTruthy();
  });  it('does not change a cart while an earlier checkout has an unresolved outcome', async () => {
    addGuestLine(input); const pending = prepareGuestMerge('customer-a')!;
    vi.spyOn(customer, 'readCheckoutAttempt').mockReturnValue({ signature: 'pending-order', key: 'pending-key' });
    const fetch = vi.spyOn(auth, 'apiFetch').mockResolvedValue({ data: { applied: true, verdicts: [{ clientLineId: pending.lines[0]!.clientLineId, status: 'ADDED' }], cart: { items: [] } } } as never);
    await expect(uploadGuestBasket('customer-a')).rejects.toThrow(/earlier checkout/i);
    expect(fetch).not.toHaveBeenCalled(); expect(readGuestBasket().lines).toHaveLength(1);
  });

});
