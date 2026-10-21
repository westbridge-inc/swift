import type { PrismaClient } from '@prisma/client';
import { runAsSystem } from '../plugins/tenant-context';
import { normalizePolicyExpression, TENANT_POLICY_CONTRACT } from './rls-attestation';
import {
  isOwnedAvatarKey,
  resolveUnreferencedAvatarObject,
  resolveVerificationObject,
} from '../modules/verification/object-authority';

/**
 * [F-026-02] The durable census of storage objects the platform still owes a
 * deletion for. A log line is not a deletion barrier: once the only DB
 * pointer (users.avatar) is nulled or replaced, no sweep can rediscover the
 * object. Every failed delete — and every replaced-pointer purge failure —
 * lands here as one open row per key; purgedAt closes it.
 *
 * Consumers: retryStorageOrphans() runs opportunistically at account-deletion
 * time and from the standing verification sweep. IDV-1 Phase 2 may later
 * absorb this compatibility census into its richer deletion-sink register.
 */

type StorageLike = {
  delete: (key: string) => Promise<unknown>;
  getObject: (key: string) => Promise<unknown>;
};
type Logger = { error: (obj: Record<string, unknown>, msg: string) => void };

export type StorageOrphanInput = {
  key: string;
  reason: string;
  userId?: string;
  tenantId?: string;
};

const RETRYABLE_AVATAR_REASONS = new Set([
  // Historical failure rows already emitted by production.
  'SELFIE_UNWIND_DELETE_FAILED',
  'REPLACED_SELFIE_DELETE_FAILED',
  'ACCOUNT_DELETION_DELETE_FAILED',
  // Durable commands written before the pointer is replaced or cleared.
  'SELFIE_UNWIND_DELETE_PENDING',
  'REPLACED_SELFIE_DELETE_PENDING',
  'ACCOUNT_DELETION_DELETE_PENDING',
]);

/** Completion must include quarantined/untrusted rows as outstanding work.
 * A reason never grants deletion authority; this classifier only prevents an
 * account response from claiming erasure while an attributable avatar-shaped
 * obligation remains open. */
export function isAvatarErasureObligation(
  row: { key: string; reason: string; userId: string | null },
  userId: string,
): boolean {
  return row.userId === userId && (
    isOwnedAvatarKey(row.key, userId)
    || row.reason.includes('SELFIE')
    || row.reason.includes('AVATAR')
    || row.reason.includes('ACCOUNT_DELETION')
  );
}

/** Global completion census. The request-scoped StorageOrphan delegate would
 * hide a mismatched historical tenant row, so completion uses raw SQL on a
 * connection that genuinely sees every tenant's rows, proven on that
 * connection (storageOrphanCensusSeesEveryRow), never inferred from config.
 *
 * [Phase C] On the walled credentials (TENANT_RLS_BIND=1, least-privilege
 * request login) the request's connection is tenant-filtered, so the census
 * is system work: runAsSystem makes its transaction BEGIN on the system login,
 * whose swift_bypass_rls membership the tenant policy admits. It is never
 * called inside a caller's transaction (it takes the client and opens its
 * own), where a system query would be refused rather than moved. With the
 * wall off it runs on the one connection, as before. Without a system login
 * the census still refuses, and the account answer stays pending. */
export async function openAvatarErasureObligationIds(
  db: PrismaClient,
  userId: string,
): Promise<string[]> {
  return runAsSystem('account:erasure-avatar-census', () => db.$transaction(async (tx) => {
    if (!(await storageOrphanCensusSeesEveryRow(tx))) {
      throw new Error('Global avatar erasure census is filtered by row-level security');
    }
    const rows = await tx.$queryRaw<Array<{ id: string; key: string; reason: string; userId: string | null }>>`
      SELECT "id", "key", "reason", "userId"
      FROM "storage_orphans"
      WHERE "userId" = ${userId} AND "purgedAt" IS NULL
      ORDER BY "id" ASC
      /* avatar-obligation-global-census */
    `;
    return rows.filter((row) => isAvatarErasureObligation(row, userId)).map((row) => row.id);
  }));
}

type RawTx = { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> };
type CensusPolicy = { permissive: boolean; cmd: string; applies: boolean; qual: string | null };

/** Does THIS connection see every row of storage_orphans? Either row security
 * is not applied to it at all (a superuser, a BYPASSRLS login, the owner of an
 * unforced table: the wall-off posture), or it is a swift_bypass_rls member
 * (the system login) and every policy that filters its reads is the tenant
 * contract itself, whose escape admits that membership, with no restrictive
 * policy to narrow it. Postgres reports row security ACTIVE for the system
 * login (the escape is a policy term, not a role attribute), so the bare
 * row_security_active check would refuse it for ever. */
export async function storageOrphanCensusSeesEveryRow(tx: RawTx): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ active: boolean; bypass?: boolean; policies?: CensusPolicy[] }>>`
    SELECT row_security_active('storage_orphans'::regclass) AS "active",
           COALESCE((SELECT pg_has_role(current_user, r.oid, 'MEMBER') FROM pg_roles r WHERE r.rolname = 'swift_bypass_rls'), false) AS "bypass",
           COALESCE((SELECT json_agg(json_build_object(
                       'permissive', p.polpermissive,
                       'cmd', p.polcmd::text,
                       'applies', p.polroles = '{0}'::oid[]
                                  OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.oid = ANY(p.polroles) AND pg_has_role(current_user, r.oid, 'MEMBER')),
                       'qual', pg_get_expr(p.polqual, p.polrelid)))
                       FROM pg_policy p WHERE p.polrelid = 'storage_orphans'::regclass), '[]'::json) AS "policies"
    /* avatar-obligation-global-census-visibility */
  `;
  if (rows.length !== 1) return false;
  const [row] = rows;
  if (row?.active === false) return true;
  if (row?.bypass !== true || !Array.isArray(row.policies)) return false;
  const reads = row.policies.filter((p) => p.applies && (p.cmd === '*' || p.cmd === 'r'));
  return !reads.some((p) => !p.permissive)
    && reads.some((p) => p.permissive && normalizePolicyExpression(p.qual) === TENANT_POLICY_CONTRACT);
}

/** The strict writer is used when an object pointer is about to disappear.
 * A conflicting row keeps its original provenance: re-opening it must never
 * upgrade an untrusted historical reason/user into deletion authority. */
export async function queueStorageOrphan(
  db: Pick<PrismaClient, 'storageOrphan'>,
  input: StorageOrphanInput,
) {
  const row = await db.storageOrphan.upsert({
    where: { key: input.key },
    create: {
      key: input.key,
      reason: input.reason,
      userId: input.userId,
      tenantId: input.tenantId ?? 'swift-default',
    },
    update: { purgedAt: null },
  });
  const expectedTenant = input.tenantId ?? 'swift-default';
  if (row.key !== input.key || row.userId !== (input.userId ?? null) || row.tenantId !== expectedTenant) {
    // The caller is about to remove the only source pointer. An existing row
    // with different subject/tenant provenance cannot be silently repurposed,
    // and a request-local orphan id would be forgotten on the next re-sweep.
    // Throw inside the caller's transaction so the pointer mutation rolls back.
    throw new Error('[F-026-02] conflicting storage-orphan provenance; source pointer retained');
  }
  return row;
}

export async function recordStorageOrphan(
  db: PrismaClient,
  log: Logger,
  input: StorageOrphanInput,
): Promise<void> {
  try {
    await queueStorageOrphan(db, input);
  } catch (err) {
    // The census write must never mask the original failure path — but its
    // own failure is the one case where the log line is all that's left.
    log.error({ err, key: input.key, reason: input.reason }, '[F-026-02] storage-orphan census write failed');
  }
}

function isMissingObject(error: unknown): boolean {
  const candidate = error as { code?: string; name?: string } | null;
  return candidate?.code === 'ENOENT'
    || candidate?.name === 'NoSuchKey'
    || candidate?.name === 'NotFound';
}

/** A provider delete acknowledgement is not evidence. Only an explicit
 * post-delete not-found proves absence; readable bytes and unknown errors keep
 * the obligation open. */
export async function deleteStorageObjectAndConfirmAbsent(storage: StorageLike, key: string): Promise<boolean> {
  await storage.delete(key).catch(() => undefined);
  return storage.getObject(key).then(() => false).catch(isMissingObject);
}

/** Retry one exact row under locks. User-before-orphan is the fixed lock order
 * for avatars, shared with the selfie/account writers. The row is re-read after
 * both locks and closed with a compare-and-set so a stale page cannot retire a
 * newly reopened obligation. */
export async function retryStorageOrphan(
  db: PrismaClient,
  storage: StorageLike,
  log: Logger,
  orphanId: string,
): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      const seed = await tx.storageOrphan.findUnique({ where: { id: orphanId } });
      if (!seed || seed.purgedAt) return false;

      const avatarShaped = seed.userId ? isOwnedAvatarKey(seed.key, seed.userId) : false;
      const avatarReason = RETRYABLE_AVATAR_REASONS.has(seed.reason);
      if (avatarShaped || avatarReason || seed.reason.includes('SELFIE') || seed.reason.includes('ACCOUNT_AVATAR')) {
        if (!seed.userId || !avatarShaped || !avatarReason) return false;
        const ownerLock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "users" WHERE "id" = ${seed.userId}
          FOR UPDATE /* avatar-orphan-subject-authority */
        `;
        if (!ownerLock[0]) return false;
        const orphanLock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "storage_orphans" WHERE "id" = ${seed.id} AND "purgedAt" IS NULL
          FOR UPDATE /* avatar-orphan-row-authority */
        `;
        if (!orphanLock[0]) return false;
        const row = await tx.storageOrphan.findUnique({ where: { id: seed.id } });
        if (!row || row.purgedAt || row.key !== seed.key || row.reason !== seed.reason
          || row.userId !== seed.userId || row.tenantId !== seed.tenantId) return false;
        const owner = await tx.user.findUnique({ where: { id: row.userId! }, select: { tenantId: true } });
        if (!owner || owner.tenantId !== row.tenantId) return false;
        await resolveUnreferencedAvatarObject(tx, { fileKey: row.key, userId: row.userId! });
        if (!await deleteStorageObjectAndConfirmAbsent(storage, row.key)) return false;
        const closed = await tx.storageOrphan.updateMany({
          where: {
            id: row.id, key: row.key, reason: row.reason, userId: row.userId,
            tenantId: row.tenantId, purgedAt: null,
          },
          data: { purgedAt: new Date() },
        });
        return closed.count === 1;
      }

      const orphanLock = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "storage_orphans" WHERE "id" = ${seed.id} AND "purgedAt" IS NULL
        FOR UPDATE /* verification-orphan-row-authority */
      `;
      if (!orphanLock[0]) return false;
      const row = await tx.storageOrphan.findUnique({ where: { id: seed.id } });
      if (!row || row.purgedAt || !row.userId || row.key !== seed.key || row.reason !== seed.reason
        || row.userId !== seed.userId || row.tenantId !== seed.tenantId) return false;
      await resolveVerificationObject(tx, { fileKey: row.key, userId: row.userId });
      if (!await deleteStorageObjectAndConfirmAbsent(storage, row.key)) return false;
      const closed = await tx.storageOrphan.updateMany({
        where: {
          id: row.id, key: row.key, reason: row.reason, userId: row.userId,
          tenantId: row.tenantId, purgedAt: null,
        },
        data: { purgedAt: new Date() },
      });
      return closed.count === 1;
    }, { timeout: 15_000 });
  } catch (err) {
    log.error({ err, orphanId }, '[F-026-02] storage-orphan retry failed — stays open');
    return false;
  }
}

/** Retry up to limit deletions, scanning the open census in bounded pages.
 * Failures retain their original rows but cannot starve eligible later rows.
 * createdAt + id gives a deterministic cursor even when timestamps tie. */
export async function retryStorageOrphans(
  db: PrismaClient,
  storage: StorageLike,
  log: Logger,
  limit = 5,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return 0;
  const pageSize = Math.min(limit, 100);
  const through = new Date();
  let after: { id: string; createdAt: Date } | undefined;
  let purged = 0;
  while (purged < limit) {
    const rows = await db.storageOrphan.findMany({
      where: {
        purgedAt: null, createdAt: { lte: through },
        ...(after && { OR: [
          { createdAt: { gt: after.createdAt } },
          { createdAt: after.createdAt, id: { gt: after.id } },
        ] }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: pageSize,
    });
    for (const row of rows) {
      try {
        if (await retryStorageOrphan(db, storage, log, row.id)) {
          purged += 1;
          if (purged === limit) return purged;
        }
      } catch (err) {
        // retryStorageOrphan is fail-closed itself. Keep this last boundary so
        // one unexpected row can never starve later pages.
        log.error({ err, key: row.key }, '[F-026-02] storage-orphan page retry failed — stays open');
      }
    }
    if (rows.length < pageSize) break;
    const next = rows[rows.length - 1]!;
    if (next.id === after?.id) throw new Error('Storage orphan census cursor did not advance');
    after = { id: next.id, createdAt: next.createdAt };
  }
  return purged;
}
