// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { StorePhotoCache } from './store-photo-cache';

describe('store photo LRU byte and entry bounds', () => {
  const value = (path: string, bytes: number, expiresAt = 3600) => ({ path, body: Buffer.alloc(bytes), freshAt: 0, expiresAt });
  it('evicts the least recently used entry, with reads refreshing recency only', () => {
    const cache = new StorePhotoCache(2, 100);
    cache.set('a', value('/a', 10), 0); cache.set('b', value('/b', 10), 0);
    cache.get('a', 100); cache.set('c', value('/c', 10), 100);
    expect(cache.get('a', 100)?.expiresAt).toBe(3600);
    expect(cache.get('b', 100)).toBeUndefined();
    expect(cache.get('c', 100)).toBeDefined();
  });
  it('byte bound evicts even below the entry bound, never retaining an oversized entry', () => {
    const cache = new StorePhotoCache(10, 15);
    cache.set('a', value('/a', 10), 0); cache.set('b', value('/b', 10), 0);
    expect(cache.get('a', 0)).toBeUndefined(); expect(cache.get('b', 0)).toBeDefined();
    cache.set('huge', value('/huge', 16), 0);
    expect(cache.get('huge', 0)).toBeUndefined();
    expect(cache.get('b', 0)).toBeDefined();
  });
  it('replacement, expiry and path eviction release accounted bytes', () => {
    const cache = new StorePhotoCache(10, 15);
    cache.set('a', value('/same', 10), 0); cache.set('a', value('/same', 5), 0);
    cache.set('b', value('/same', 5), 0); cache.set('c', value('/c', 5, 100), 0);
    expect(cache.get('a', 0)).toBeDefined(); expect(cache.get('b', 0)).toBeDefined();
    expect(cache.get('c', 100)).toBeUndefined();
    cache.evictPath('/same');
    expect(cache.get('a', 0)).toBeUndefined(); expect(cache.get('b', 0)).toBeUndefined();
    cache.set('d', value('/d', 15), 100); expect(cache.get('d', 100)).toBeDefined();
  });
  it('prunes expired entries during writes and never stores an already expired result', () => {
    const cache = new StorePhotoCache(10, 15);
    cache.set('a', value('/a', 10, 100), 0); cache.set('b', value('/b', 10), 100);
    expect(cache.get('a', 100)).toBeUndefined(); expect(cache.get('b', 100)).toBeDefined();
    cache.set('expired', value('/expired', 5, 100), 100);
    expect(cache.get('expired', 100)).toBeUndefined();
  });
});
