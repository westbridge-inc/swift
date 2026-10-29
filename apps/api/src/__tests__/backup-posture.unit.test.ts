/**
 * [SEC-BACKUP] Until the owner stores a key limited to the backup bucket, the host's backups fall
 * back to the API's own storage key so they never stop, and a unit installed before the backup
 * store backs up unsigned. Both keep backups RUNNING, so neither trips the freshness alarm: this
 * page is what says it out loud, weekly, until it is fixed. deploy/backup.sh records both facts in
 * platform_config (last_backup_storage_key, last_backup_signed); the page path is the shared
 * ops-page module (proven in ops-responders.test.ts), here a spy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

vi.mock('../modules/ops/ops-page', () => ({
  pageOps: vi.fn(async () => ({ status: 'delivered', opsAlertId: 'a1', recipients: 1 })),
  resolveOpsPage: vi.fn(async () => 1),
}));

import { pageOps, resolveOpsPage } from '../modules/ops/ops-page';
import {
  BACKUP_POSTURE_PAGE_TITLE,
  LAST_BACKUP_SIGNED_KEY,
  LAST_BACKUP_STORAGE_KEY_KEY,
  checkBackupPosture,
  pageBackupPosture,
} from '../modules/ops/backup-freshness';
import { alertClassOf } from '../providers/notifications/alert-class';

/** platform_config as backup.sh leaves it (only the two keys this check reads). */
function store(rows: Record<string, unknown>) {
  const findMany = vi.fn(async (args: { where: { key: { in: string[] } } }) =>
    Object.entries(rows).filter(([key]) => args.where.key.in.includes(key)).map(([key, value]) => ({ key, value })));
  return { prisma: { platformConfig: { findMany } } as unknown as PrismaClient, findMany };
}
const deps = (prisma: PrismaClient) => ({ prisma, redis: {} as never, notifications: {} as never });

afterEach(() => {
  vi.mocked(pageOps).mockClear();
  vi.mocked(resolveOpsPage).mockClear();
});

describe('[SEC-BACKUP] backup posture: a shared API storage key or an unsigned dump is paged', () => {
  it('reads exactly the two heartbeat keys backup.sh writes', async () => {
    const { prisma, findMany } = store({});
    await checkBackupPosture(prisma);
    expect(findMany).toHaveBeenCalledWith({ where: { key: { in: ['last_backup_signed', 'last_backup_storage_key'] } } });
    expect([LAST_BACKUP_SIGNED_KEY, LAST_BACKUP_STORAGE_KEY_KEY]).toEqual(['last_backup_signed', 'last_backup_storage_key']);
  });

  it('a backup that used the API storage key is weak, and says who could destroy the backups', async () => {
    const r = await checkBackupPosture(store({ last_backup_storage_key: 'shared', last_backup_signed: true }).prisma);
    expect(r).toMatchObject({ weak: true, sharedKey: true, unsigned: false });
    expect(r.reason).toMatch(/API's storage key: whoever obtains it can read, overwrite or delete every off-site backup/);
    expect(r.reason).toContain('BACKUP-KEY-SETUP');
  });

  it('an unsigned backup is weak: restores refuse it', async () => {
    const r = await checkBackupPosture(store({ last_backup_storage_key: 'dedicated', last_backup_signed: false }).prisma);
    expect(r).toMatchObject({ weak: true, sharedKey: false, unsigned: true });
    expect(r.reason).toMatch(/not signed: restores refuse it/);
  });

  it("the backup bucket's own key and a signed dump are not weak", async () => {
    const r = await checkBackupPosture(store({ last_backup_storage_key: 'dedicated', last_backup_signed: true }).prisma);
    expect(r).toMatchObject({ weak: false, sharedKey: false, unsigned: false });
  });

  it('a heartbeat from before this check (neither key recorded) is not judged', async () => {
    expect((await checkBackupPosture(store({ last_backup_at: '2026-10-28' }).prisma)).weak).toBe(false);
  });

  it('weak: one platform page, weekly, on the backup alert kind; fixed: the open page is closed', async () => {
    const weak = await pageBackupPosture(deps(store({ last_backup_storage_key: 'shared', last_backup_signed: false }).prisma));
    expect(weak.page?.status).toBe('delivered');
    expect(vi.mocked(pageOps)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pageOps).mock.calls[0]![1]).toMatchObject({
      key: 'ops_page:backup-posture',
      windowSeconds: 7 * 24 * 3600,
      title: BACKUP_POSTURE_PAGE_TITLE,
      data: { kind: 'ops_backup_stale', backupPosture: true, sharedKey: true, unsigned: true },
    });
    expect(vi.mocked(resolveOpsPage)).not.toHaveBeenCalled();
    const fixed = store({ last_backup_storage_key: 'dedicated', last_backup_signed: true }).prisma;
    expect((await pageBackupPosture(deps(fixed))).page).toBeNull();
    expect(vi.mocked(pageOps)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveOpsPage)).toHaveBeenCalledWith(fixed, BACKUP_POSTURE_PAGE_TITLE, 'backup-protected');
  });

  it('the page travels as an ops page, like the freshness alarm', () => {
    expect(alertClassOf('ops_backup_stale')).toBeDefined();
  });
});
