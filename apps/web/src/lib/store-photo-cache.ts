export interface CachedStorePhoto {
  path: string;
  body: Buffer;
  freshAt: number;
  expiresAt: number;
}

/** Process-local LRU. A hit changes recency, never the photo's expiry. */
export class StorePhotoCache {
  private readonly entries = new Map<string, CachedStorePhoto>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(maxEntries: number, maxBytes: number) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.body.length;
    this.entries.delete(key);
  }

  get(key: string, now: number): CachedStorePhoto | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) { this.remove(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: CachedStorePhoto, now: number): void {
    this.remove(key);
    for (const [oldKey, old] of this.entries) if (old.expiresAt <= now) this.remove(oldKey);
    if (entry.body.length > this.maxBytes || entry.expiresAt <= now) return;
    this.entries.set(key, entry);
    this.bytes += entry.body.length;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.remove(this.entries.keys().next().value!);
    }
  }

  evictPath(path: string): void {
    for (const [key, entry] of this.entries) if (entry.path === path) this.remove(key);
  }
}
