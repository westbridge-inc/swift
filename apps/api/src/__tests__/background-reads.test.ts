import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { trackBackgroundRead, settleBackgroundReads, backgroundReadsPending } from '../lib/background-reads';
import { prohibitedStoreIds, resetHiddenItemIdsCacheForTests, HIDDEN_IDS_CACHE_MS } from '../modules/compliance/prohibited-gate';

// [#1678 · CI shard 4 on 7ee6bed2] A stale list refreshed in the background was still reading when a server closed;
// the close disconnected the one shared database client under it, and every later query in the process failed with
// "Engine is not yet connected". A close now waits for background reads first.

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('background reads finish before the database disconnects', () => {
  beforeEach(async () => {
    resetHiddenItemIdsCacheForTests();
    await settleBackgroundReads();
    expect(backgroundReadsPending()).toBe(0);
  });

  it('settling waits for every tracked read, including one started while it waits, and stops at its limit', async () => {
    const done: string[] = [];
    trackBackgroundRead(wait(30).then(() => {
      done.push('first');
      trackBackgroundRead(wait(30).then(() => { done.push('second'); }));
    }));
    await settleBackgroundReads();
    expect(done).toEqual(['first', 'second']);
    expect(backgroundReadsPending()).toBe(0);

    const slow = trackBackgroundRead(wait(600));
    const started = Date.now();
    await settleBackgroundReads(50);
    expect(Date.now() - started).toBeLessThan(500);
    expect(backgroundReadsPending()).toBe(1);
    await slow;
    expect(backgroundReadsPending()).toBe(0);
  });

  it('a server close waits for a background read before the database client disconnects', async () => {
    const app = Fastify({ logger: false });
    await app.register(prismaPlugin);
    await app.ready();
    let answered = false;
    trackBackgroundRead(wait(150).then(() => app.prisma.$queryRaw`SELECT 1`).then(() => { answered = true; }));
    await app.close();
    expect(answered).toBe(true);
  });

  it('a stale store list is refreshed as a tracked background read', async () => {
    let reads = 0;
    const db = {
      discoveryCategory: { findMany: async () => { reads += 1; await wait(60); return []; } },
      vendorDiscoveryCategory: { findMany: async () => [] },
    } as never;
    expect(await prohibitedStoreIds(db, 'bg-reads-tenant', 0)).toEqual([]);
    expect(reads).toBe(1);
    // Older than the cache window: the old list is served at once and one refresh starts behind it.
    expect(await prohibitedStoreIds(db, 'bg-reads-tenant', HIDDEN_IDS_CACHE_MS + 1)).toEqual([]);
    expect(backgroundReadsPending()).toBe(1);
    await settleBackgroundReads();
    expect(reads).toBe(2);
    expect(backgroundReadsPending()).toBe(0);
  });
});
