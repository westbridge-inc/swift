import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260824150000_launch2_ugc_tenant_audit/migration.sql',
  ),
  'utf8',
);

function migrationFunction(name: string): string {
  const start = migration.indexOf(`CREATE FUNCTION "${name}"()`);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf('$$;', start);
  expect(end, `${name} must have a complete body`).toBeGreaterThan(start);
  return migration.slice(start, end + 3);
}

describe('LAUNCH-2 UGC audit migration structure', () => {
  it('derives report tenancy from the reporter and fails on unknown provenance', () => {
    expect(migration).toMatch(
      /UPDATE "content_reports" AS report[\s\S]*SET "tenantId" = reporter\."tenantId"[\s\S]*WHERE report\."reporterId" = reporter\."id"/,
    );
    expect(migration).toMatch(
      /FROM "content_reports"[\s\S]*WHERE "tenantId" IS NULL[\s\S]*IF orphan_count > 0 THEN[\s\S]*RAISE EXCEPTION/,
    );
    expect(migration).not.toMatch(
      /UPDATE "content_reports"\s+SET "tenantId" = 'swift-default'/,
    );
  });

  it.each(['content_reports', 'user_blocks'])('%s denies DELETE and TRUNCATE', (table) => {
    expect(migration).toContain(`REVOKE TRUNCATE ON "${table}" FROM PUBLIC`);
    expect(migration).toMatch(
      new RegExp(`CREATE TRIGGER "${table}_no_delete"\\s+BEFORE DELETE ON "${table}"`),
    );
    expect(migration).toMatch(
      new RegExp(`CREATE TRIGGER "${table}_no_truncate"\\s+BEFORE TRUNCATE ON "${table}"`),
    );
  });

  it('makes report provenance and captured evidence immutable', () => {
    const guard = migrationFunction('guard_content_report_update');
    for (const column of [
      'id',
      'tenantId',
      'reporterId',
      'targetType',
      'targetId',
      'reason',
      'detail',
      'targetSnapshot',
      'createdAt',
    ]) {
      expect(guard).toContain(`NEW."${column}"`);
      expect(guard).toContain(`OLD."${column}"`);
    }
    expect(migration).toMatch(
      /CREATE TRIGGER "content_reports_guard_update"\s+BEFORE UPDATE ON "content_reports"\s+FOR EACH ROW EXECUTE FUNCTION "guard_content_report_update"\(\)/,
    );
  });

  it('keeps block episode identity immutable and permits only one-way closure', () => {
    const guard = migrationFunction('guard_user_block_update');
    for (const column of ['id', 'tenantId', 'blockerId', 'blockedId', 'createdAt']) {
      expect(guard).toContain(`NEW."${column}"`);
      expect(guard).toContain(`OLD."${column}"`);
    }
    expect(guard).toMatch(
      /OLD\."unblockedAt" IS NOT NULL[\s\S]*NEW\."unblockedAt" IS DISTINCT FROM OLD\."unblockedAt"/,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER "user_blocks_guard_update"\s+BEFORE UPDATE ON "user_blocks"\s+FOR EACH ROW EXECUTE FUNCTION "guard_user_block_update"\(\)/,
    );
  });

  it('owns the self-block, one-active-episode, and tenant-RLS invariants in SQL', () => {
    expect(migration).toContain(
      'CONSTRAINT "user_blocks_not_self_check" CHECK ("blockerId" <> "blockedId")',
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "user_blocks_one_active_episode_key"[\s\S]*WHERE "unblockedAt" IS NULL/,
    );
    for (const table of ['content_reports', 'user_blocks']) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(migration).toMatch(
        new RegExp(`CREATE POLICY "tenant_isolation" ON "${table}"`),
      );
    }
  });
});
