import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { recordStorageOrphan, retryStorageOrphans } from '../lib/storage-orphans';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';
import { tenantScopeExtensionFor } from '../plugins/prisma';
import { runWithTenant } from '../plugins/tenant-context';

// Security-lane tests never fall back to Claude's swift_test database.
process.env['DATABASE_URL'] = process.env['DATABASE_URL']
  || 'postgresql://swift:swift@localhost:5434/swift_test2';

const prisma = new PrismaClient();
const scopedPrisma = prisma.$extends(tenantScopeExtensionFor(prisma)) as unknown as PrismaClient;
const log = { error: () => undefined };
const marker = nanoid(8).toLowerCase();
const userId = `test-${marker}`;
const otherUserId = `other-${marker}`;
const foreignTenantId = `tenant-${marker}`;
const verificationKeys = new Map<string, string>();
let oldAvatar = '';
let currentAvatar = '';
const previousRlsBind = process.env['TENANT_RLS_BIND'];
const verificationKey = (name: string) => verificationKeys.get(name)!;

afterAll(async () => {
  await prisma.storageOrphan.deleteMany({ where: { key: { contains: marker } } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  await prisma.tenant.delete({ where: { id: foreignTenantId } });
  await prisma.$disconnect();
  if (previousRlsBind === undefined) delete process.env['TENANT_RLS_BIND'];
  else process.env['TENANT_RLS_BIND'] = previousRlsBind;
});

afterEach(async () => {
  await prisma.storageOrphan.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
});

beforeAll(async () => {
  process.env['STORAGE_PROVIDER'] = 'local';
  process.env['TENANT_RLS_BIND'] = '0';
  await prisma.tenant.create({ data: { id: foreignTenantId, name: `Storage ${marker}`, slug: `storage-${marker}` } });
  await prisma.user.createMany({ data: [
    {
      id: userId, phone: `orphan-${marker}-a`, firstName: 'Storage', lastName: 'Subject',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: 'swift-default',
    },
    {
      id: otherUserId, phone: `orphan-${marker}-b`, firstName: 'Storage', lastName: 'Other',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: foreignTenantId,
    },
  ] });
  oldAvatar = await signupSelfieFixture(prisma, userId);
  currentAvatar = `/uploads/avatars/${userId}/${nanoid(16)}.jpg`;
  await prisma.user.update({ where: { id: userId }, data: { avatar: currentAvatar } });
  for (const name of ['record', 'ok', 'bad']) {
    verificationKeys.set(name, await ownedVerificationFixture(prisma, userId, name));
  }
});

describe('storage-orphan census', () => {
  it('records a failed delete durably and never upgrades conflicting provenance', async () => {
    const key = verificationKey('record');
    await recordStorageOrphan(prisma, log, {
      key, reason: 'VERIFICATION_UNWIND_DELETE_FAILED', userId, tenantId: 'swift-default',
    });
    await prisma.storageOrphan.update({ where: { key }, data: { purgedAt: new Date() } });
    await recordStorageOrphan(prisma, log, {
      key, reason: 'REPLACED_SELFIE_DELETE_FAILED', userId: otherUserId, tenantId: 'swift-default',
    });
    const row = await prisma.storageOrphan.findUniqueOrThrow({ where: { key } });
    expect(row).toMatchObject({
      key, reason: 'VERIFICATION_UNWIND_DELETE_FAILED', userId,
      tenantId: 'swift-default', purgedAt: null,
    });
  });

  it('retries an unreferenced subject avatar but refuses the current pointer and a foreign alias', async () => {
    await recordStorageOrphan(prisma, log, {
      key: oldAvatar, reason: 'REPLACED_SELFIE_DELETE_FAILED', userId, tenantId: 'swift-default',
    });
    await recordStorageOrphan(prisma, log, {
      key: currentAvatar, reason: 'REPLACED_SELFIE_DELETE_FAILED', userId, tenantId: 'swift-default',
    });
    const absent = new Set<string>();
    const storage = {
      delete: async (key: string) => { absent.add(key); },
      getObject: async (key: string) => {
        if (absent.has(key)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        return Buffer.from('present');
      },
    };
    expect(await runWithTenant('swift-default', () => retryStorageOrphans(scopedPrisma, storage, log, 50))).toBe(1);
    expect(await prisma.storageOrphan.findUniqueOrThrow({ where: { key: oldAvatar } })).toMatchObject({ purgedAt: expect.any(Date) });
    expect(await prisma.storageOrphan.findUniqueOrThrow({ where: { key: currentAvatar } })).toMatchObject({ purgedAt: null });

    await prisma.storageOrphan.update({ where: { key: oldAvatar }, data: { purgedAt: null } });
    await prisma.user.update({
      where: { id: otherUserId },
      data: { avatar: oldAvatar.replace(`/avatars/${userId}/`, `/avatars/${userId}/spare/../`) },
    });
    absent.delete(oldAvatar);
    expect(await runWithTenant('swift-default', () => retryStorageOrphans(scopedPrisma, storage, log, 50))).toBe(0);
    expect(await prisma.storageOrphan.findUniqueOrThrow({ where: { key: oldAvatar } })).toMatchObject({ purgedAt: null });
    await prisma.user.update({ where: { id: otherUserId }, data: { avatar: null } });
  });

  it('closes only rows whose post-delete probe confirms absence and retries later', async () => {
    await recordStorageOrphan(prisma, log, {
      key: verificationKey('ok'), reason: 'VERIFICATION_UNWIND_DELETE_FAILED', userId, tenantId: 'swift-default',
    });
    await recordStorageOrphan(prisma, log, {
      key: verificationKey('bad'), reason: 'VERIFICATION_UNWIND_DELETE_FAILED', userId, tenantId: 'swift-default',
    });
    const absent = new Set<string>();
    let badDeleteFails = true;
    const storage = {
      delete: async (key: string) => {
        if (key === verificationKey('bad') && badDeleteFails) return;
        absent.add(key);
      },
      getObject: async (key: string) => {
        if (absent.has(key)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        return Buffer.from('still present');
      },
    };
    expect(await retryStorageOrphans(prisma, storage, log, 50)).toBeGreaterThanOrEqual(1);
    expect(await prisma.storageOrphan.findUniqueOrThrow({ where: { key: verificationKey('ok') } })).toMatchObject({ purgedAt: expect.any(Date) });
    expect(await prisma.storageOrphan.findUniqueOrThrow({ where: { key: verificationKey('bad') } })).toMatchObject({ purgedAt: null });
    badDeleteFails = false;
    expect(await retryStorageOrphans(prisma, storage, log, 50)).toBeGreaterThanOrEqual(1);
    expect(await prisma.storageOrphan.findUniqueOrThrow({ where: { key: verificationKey('bad') } })).toMatchObject({ purgedAt: expect.any(Date) });
  });

  it('the best-effort census writer never masks the original failure', async () => {
    const broken = { storageOrphan: { upsert: async () => { throw new Error('db down'); } } } as never;
    await expect(recordStorageOrphan(broken, log, {
      key: `/uploads/avatars/${userId}/${nanoid(16)}.jpg`,
      reason: 'SELFIE_UNWIND_DELETE_FAILED', userId, tenantId: 'swift-default',
    })).resolves.toBeUndefined();
  });
});
