import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  SearchService,
  type SearchClientLike,
  type SearchIndexLike,
} from './search.service';
import { ITEM_INDEX, VENDOR_INDEX } from './search-scope';

type TaskState = {
  taskUid?: number;
  status: 'enqueued' | 'succeeded' | 'failed';
  error?: { code?: string; message?: string } | null;
};

function waitableTask(final: TaskState) {
  const queued = Promise.resolve<TaskState>({ taskUid: 1, status: 'enqueued' });
  return Object.assign(queued, {
    waitTask: vi.fn(async () => final),
  });
}

class RecordingIndex implements SearchIndexLike {
  addOptions: Array<{ primaryKey?: string } | undefined> = [];
  addTask = waitableTask({ status: 'succeeded', error: null });
  settingsTask = waitableTask({ status: 'succeeded', error: null });

  addDocuments(_docs: Record<string, unknown>[], options?: { primaryKey?: string }) {
    this.addOptions.push(options);
    return this.addTask;
  }

  deleteDocument() { return waitableTask({ status: 'succeeded', error: null }); }
  deleteDocuments() { return waitableTask({ status: 'succeeded', error: null }); }
  async getDocuments() { return { results: [], total: 0 }; }
  async search() { return { hits: [], estimatedTotalHits: 0, processingTimeMs: 1 }; }
  updateSettings() { return this.settingsTask; }
}

function clientWith(primaryKeys: Record<string, string | null>) {
  const indexes = new Map<string, RecordingIndex>();
  const updateTasks = new Map<string, ReturnType<typeof waitableTask>>();
  const client = {
    createIndex: vi.fn((_uid: string) => waitableTask({ status: 'succeeded', error: null })),
    getRawIndex: vi.fn(async (uid: string) => ({ uid, primaryKey: primaryKeys[uid] })),
    updateIndex: vi.fn((uid: string, options?: { primaryKey?: string }) => {
      if (options?.primaryKey) primaryKeys[uid] = options.primaryKey;
      const task = waitableTask({ status: 'succeeded', error: null });
      updateTasks.set(uid, task);
      return task;
    }),
    index: (uid: string) => {
      let index = indexes.get(uid);
      if (!index) {
        index = new RecordingIndex();
        indexes.set(uid, index);
      }
      return index;
    },
  };
  return { client: client as unknown as SearchClientLike, raw: client, indexes, updateTasks };
}

function itemPrisma() {
  return {
    item: {
      findMany: vi.fn(async () => [{
        id: 'item-1',
        name: 'Phone Case — Clear',
        description: 'Clear phone case',
        vendorId: 'vendor-1',
        vendor: { name: 'Camp Street Electronics', tenantId: 'tenant-1' },
        category: { name: 'Accessories' },
        basePrice: 2500,
        imageUrl: null,
        createdAt: new Date('2026-09-20T00:00:00.000Z'),
        isAvailable: true,
        isPopular: false,
        dietaryTags: [],
        allergens: [],
        totalOrdered: 0,
      }]),
    },
    itemDiscoveryCategory: { findMany: vi.fn(async () => []) },
    discoveryCategory: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaClient;
}

describe('search index readiness', () => {
  it('repairs a legacy empty index whose primary key was never established and waits for every settings task', async () => {
    const { client, raw, indexes, updateTasks } = clientWith({
      [VENDOR_INDEX]: null,
      [ITEM_INDEX]: null,
    });
    const service = new SearchService({} as PrismaClient, undefined, undefined, client);

    await service.initialize();

    expect(raw.updateIndex).toHaveBeenCalledWith(VENDOR_INDEX, { primaryKey: 'id' });
    expect(raw.updateIndex).toHaveBeenCalledWith(ITEM_INDEX, { primaryKey: 'id' });
    expect(updateTasks.get(VENDOR_INDEX)?.waitTask).toHaveBeenCalledOnce();
    expect(updateTasks.get(ITEM_INDEX)?.waitTask).toHaveBeenCalledOnce();
    expect(indexes.get(VENDOR_INDEX)?.settingsTask.waitTask).toHaveBeenCalledOnce();
    expect(indexes.get(ITEM_INDEX)?.settingsTask.waitTask).toHaveBeenCalledOnce();
  });

  it('refuses an index bound to a different primary key instead of reporting it ready', async () => {
    const { client } = clientWith({
      [VENDOR_INDEX]: 'vendorId',
      [ITEM_INDEX]: 'id',
    });
    const service = new SearchService({} as PrismaClient, undefined, undefined, client);

    await expect(service.initialize()).rejects.toThrow(/primary key/i);
  });

  it('supplies the id primary key on document writes and surfaces an asynchronous indexing failure', async () => {
    const { client, indexes } = clientWith({
      [VENDOR_INDEX]: 'id',
      [ITEM_INDEX]: 'id',
    });
    const service = new SearchService(itemPrisma(), undefined, undefined, client);
    const index = indexes.get(ITEM_INDEX) ?? client.index(ITEM_INDEX) as RecordingIndex;
    index.addTask = waitableTask({
      status: 'failed',
      error: { code: 'index_primary_key_multiple_candidates_found', message: 'primary key inference failed' },
    });

    await expect(service.syncAllItems()).rejects.toThrow(/primary key inference failed/i);
    expect(index.addOptions).toEqual([{ primaryKey: 'id' }]);
    expect(index.addTask.waitTask).toHaveBeenCalledOnce();
  });
});
