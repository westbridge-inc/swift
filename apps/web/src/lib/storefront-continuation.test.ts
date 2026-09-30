import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from './auth';
import { clearStorefrontContinuation, queueStorefrontContinuation, readStorefrontContinuation, takeStorefrontContinuation } from './storefront-continuation';

const key = 'swift_storefront_add';
const intent = { storeSlug: 'garden-kitchen', itemId: 'roti', selectedOptions: { filling: ['chickpea'] }, returnPath: '/store/garden-kitchen?src=qr' };
beforeEach(() => { sessionStorage.clear(); });

describe('tab-scoped store Add continuation', () => {
  it('keeps the store and choices, drops prices and consumes before a second delivery', () => {
    queueStorefrontContinuation({ ...intent, price: 1 } as typeof intent);
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(intent);
    expect(takeStorefrontContinuation('another-store')).toBeNull();
    expect(readStorefrontContinuation()).toEqual(intent);
    expect(takeStorefrontContinuation(intent.storeSlug)).toEqual(intent);
    expect(takeStorefrontContinuation(intent.storeSlug)).toBeNull();
  });
  it('replaces an earlier choice with the latest explicit Add', () => {
    queueStorefrontContinuation(intent);
    queueStorefrontContinuation({ ...intent, itemId: 'soup' });
    expect(takeStorefrontContinuation(intent.storeSlug)?.itemId).toBe('soup');
  });
  it.each(['cancel', 'sign-out'])('clears on %s', action => {
    queueStorefrontContinuation(intent);
    if (action === 'cancel') clearStorefrontContinuation(); else clearSession();
    expect(readStorefrontContinuation()).toBeNull();
  });
  it.each(['https://evil.example/store/garden-kitchen', '//evil.example/store/garden-kitchen', '/store/another', '/store/garden-kitchen/../../evil', '/store/garden-kitchen%2f..', '/store/garden-kitchen\\evil', '/cart'])('rejects a non-bound return path: %s', returnPath => {
    sessionStorage.setItem(key, JSON.stringify({ ...intent, returnPath }));
    expect(readStorefrontContinuation()).toBeNull();
    queueStorefrontContinuation({ ...intent, returnPath });
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('does not throw when storage is blocked', () => {
    const blocked = vi.fn(() => { throw new Error('blocked'); });
    vi.stubGlobal('sessionStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(() => queueStorefrontContinuation(intent)).not.toThrow();
    expect(readStorefrontContinuation()).toBeNull();
    expect(takeStorefrontContinuation(intent.storeSlug)).toBeNull();
    expect(() => clearSession()).not.toThrow();
  });
  it('does not deliver if removing the saved intent fails', () => {
    queueStorefrontContinuation(intent);
    const getItem = sessionStorage.getItem.bind(sessionStorage);
    vi.stubGlobal('sessionStorage', { getItem, removeItem: () => { throw new Error('blocked'); } });
    expect(takeStorefrontContinuation(intent.storeSlug)).toBeNull();
  });
});
