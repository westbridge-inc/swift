import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { recordStorageOrphan, retryStorageOrphans } from '../lib/storage-orphans';

// ---------------------------------------------------------------------------
// [F-026-02] The storage-deletion census: a failed object delete must land in
// a DURABLE, RETRYABLE table — a log line is not a deletion barrier, because
// once users.avatar is nulled or replaced nothing can rediscover the key.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
const log = { error: () => undefined };
const marker = nanoid(8).toLowerCase();
const key = (n: string) => `avatars/test-${marker}/${n}.jpg`;

afterAll(async () => {
  await prisma.storageOrphan.deleteMany({ where: { key: { contains: `test-${marker}` } } });
  await prisma.$disconnect();
});

beforeAll(() => {
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
});

describe('storage-orphan census', () => {
  it('records a failed delete durably, one open row per key', async () => {
    await recordStorageOrphan(prisma, log, { key: key('a'), reason: 'SELFIE_UNWIND_DELETE_FAILED', userId: 'u-1' });
    const row = await prisma.storageOrphan.findUnique({ where: { key: key('a') } });
    expect(row).not.toBeNull();
    expect(row!.purgedAt).toBeNull();
    expect(row!.reason).toBe('SELFIE_UNWIND_DELETE_FAILED');
  });

  it('re-orphaning the same key re-opens its row instead of failing the unique', async () => {
    await prisma.storageOrphan.update({ where: { key: key('a') }, data: { purgedAt: new Date() } });
    await recordStorageOrphan(prisma, log, { key: key('a'), reason: 'REPLACED_SELFIE_DELETE_FAILED' });
    const row = await prisma.storageOrphan.findUniqueOrThrow({ where: { key: key('a') } });
    expect(row.purgedAt).toBeNull();
    expect(row.reason).toBe('REPLACED_SELFIE_DELETE_FAILED');
  });

  it('retry purges what it can, closes those rows, and leaves failures open', async () => {
    await recordStorageOrphan(prisma, log, { key: key('ok'), reason: 'ACCOUNT_DELETION_DELETE_FAILED' });
    await recordStorageOrphan(prisma, log, { key: key('bad'), reason: 'ACCOUNT_DELETION_DELETE_FAILED' });

    const deleted: string[] = [];
    const storage = {
      delete: async (k: string) => {
        if (k === key('bad')) throw new Error('still down');
        deleted.push(k);
      },
    };
    const purged = await retryStorageOrphans(prisma, storage, log, 50);

    expect(purged).toBeGreaterThanOrEqual(2); // key('a') reopened above + key('ok')
    expect(deleted).toContain(key('ok'));
    const ok = await prisma.storageOrphan.findUniqueOrThrow({ where: { key: key('ok') } });
    const bad = await prisma.storageOrphan.findUniqueOrThrow({ where: { key: key('bad') } });
    expect(ok.purgedAt).not.toBeNull();
    expect(bad.purgedAt).toBeNull(); // stays open for the next pass — the census survives
  });

  it('the census writer never throws even when the DB write fails', async () => {
    const broken = { storageOrphan: { upsert: async () => { throw new Error('db down'); } } } as never;
    await expect(
      recordStorageOrphan(broken, log, { key: key('x'), reason: 'SELFIE_UNWIND_DELETE_FAILED' }),
    ).resolves.toBeUndefined();
  });
});
