import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drive the real module's guarded plain-MMKV store with an in-memory fake —
// the same per-file native-module mocking the repo uses for the ads cache.
const mocks = vi.hoisted(() => {
  const buckets = new Map<string, Map<string, string>>();
  class FakeMMKV {
    readonly id: string;
    constructor(options: { id: string }) {
      this.id = options.id;
    }
    getString(key: string): string | undefined {
      return buckets.get(this.id)?.get(key);
    }
    set(key: string, value: string): void {
      let bucket = buckets.get(this.id);
      if (!bucket) {
        bucket = new Map<string, string>();
        buckets.set(this.id, bucket);
      }
      bucket.set(key, value);
    }
  }
  return { buckets, FakeMMKV };
});

vi.mock('react-native-mmkv', () => ({ MMKV: mocks.FakeMMKV }));

import { rememberedMarketDepth, rememberMarketDepth } from './marketDepthMemory';

const VISIBLE = { visible: true, items: 180, vendors: 3 };
const HIDDEN = { visible: false, items: 0, vendors: 0 };

beforeEach(() => {
  mocks.buckets.clear();
});

describe('the last complete Market depth verdict', () => {
  it('round-trips across a restart, and a complete hidden verdict replaces a remembered visible one', () => {
    rememberMarketDepth(VISIBLE);
    expect(rememberedMarketDepth()).toEqual(VISIBLE);

    rememberMarketDepth(HIDDEN);
    expect(rememberedMarketDepth()).toEqual(HIDDEN);
  });

  it('never persists an unknown body, so a failed read cannot erase a known verdict', () => {
    rememberMarketDepth(VISIBLE);
    for (const junk of [
      undefined,
      null,
      {},
      { visible: 'true', items: 180, vendors: 3 },
      { visible: true, items: -1, vendors: 3 },
      { visible: true, items: 1.5, vendors: 3 },
      'garbage',
    ]) {
      rememberMarketDepth(junk);
      expect(rememberedMarketDepth()).toEqual(VISIBLE);
    }
  });

  it('reads nothing when nothing is stored, or the stored value no longer parses as a verdict', () => {
    expect(rememberedMarketDepth()).toBeNull();

    rememberMarketDepth(VISIBLE);
    // Corrupt what is on disk behind the module's back.
    [...mocks.buckets.values()][0]!.set('depth', '{not json');
    expect(rememberedMarketDepth()).toBeNull();
  });
});
