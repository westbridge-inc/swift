import type { PrismaClient, QrCode } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { generateShortCode, type QrLookup } from './qr-codes';
import { VISIBLE_VENDOR } from '../vendor/vendor-visibility';
import { runAsSystem } from '../../plugins/tenant-context';

// ---------------------------------------------------------------------------
// QrCode lifecycle. One ACTIVE code per entity, enforced by the raw-SQL
// partial unique index one_active_qr_per_entity — get-or-create and regenerate
// are concurrency-safe by catching P2002 and re-reading the winner, the same
// race-guard shape the trial-law engagement established.
// ---------------------------------------------------------------------------

/** Per-tenant knob (PlatformConfig, dotted-key idiom): how long a superseded
 *  code keeps resolving. Printed materials die slowly. */
export const QR_GRACE_CONFIG_KEY = 'qr.supersede_grace_days';
export const QR_GRACE_DEFAULT_DAYS = 30;

export type QrLookupRow = QrLookup & { id: string; tenantId: string; version: number; entityId: string };

const isUniqueViolation = (e: unknown): e is Prisma.PrismaClientKnownRequestError =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export class QrService {
  constructor(private prisma: PrismaClient) {}

  async graceDays(): Promise<number> {
    const row = await this.prisma.platformConfig.findUnique({ where: { key: QR_GRACE_CONFIG_KEY } });
    const value = Number(row?.value);
    return Number.isFinite(value) && value >= 0 ? value : QR_GRACE_DEFAULT_DAYS;
  }

  /** Resolver lookup: the code row + its entity's public liveness, one shape
   *  for classifyScan. Unauthenticated path — runs without tenant context by
   *  design (shortCode is globally unique; the row itself names its tenant). */
  async findByShortCode(shortCode: string): Promise<QrLookupRow | null> {
    // This is always a PUBLIC lookup, even if a caller has a REVIEW session.
    // The named system capability permits the globally unique code lookup
    // under the app's RLS client; the destination is explicitly tenant-bound
    // and PRODUCTION-only. Hidden targets take the missing path BEFORE any
    // lifecycle classification, including retired codes and app-open reports.
    return runAsSystem('public-qr-resolution', async () => {
      const qr = await this.prisma.qrCode.findUnique({
        where: { shortCode },
        select: { id: true, tenantId: true, shortCode: true, status: true, supersededAt: true, version: true, entityId: true, entityType: true },
      });
      if (!qr || qr.entityType !== 'VENDOR') return null;
      // [PR1197-S1-04] THE TARGET MUST BELONG TO THE CODE'S OWN TENANT.
      //
      // This looked up the vendor by `id` ALONE. The resolver is deliberately
      // unauthenticated — a printed code names its own tenant — so nothing else
      // bound the two, and a malformed or migrated row could pair tenant A's QR
      // code with tenant B's storefront. AttributionService then persists that
      // pairing: tenant A gets the credit, tenant B gets the traffic, and the
      // attribution ledger records something that never happened.
      //
      // `entityType` is checked for the same reason. It is a single-valued enum
      // today, which is exactly when a polymorphic read is written without a
      // check and exactly when the second value silently breaks it.
      const vendor = await this.prisma.vendor.findFirst({
        where: { ...VISIBLE_VENDOR, id: qr.entityId, tenantId: qr.tenantId, tenant: { isActive: true, kind: 'PRODUCTION' } },
        select: { slug: true },
      });
      if (!vendor) return null;
      return {
        id: qr.id,
        tenantId: qr.tenantId,
        shortCode: qr.shortCode,
        status: qr.status,
        supersededAt: qr.supersededAt,
        version: qr.version,
        entityId: qr.entityId,
        entity: { live: true, slug: vendor.slug },
      };
    });
  }

  /** Idempotent get-or-create of the entity's ACTIVE code. Concurrency-safe:
   *  the partial unique makes the second creator lose with P2002 → re-read. */
  async getOrCreateForVendor(vendorId: string, createdByUserId: string): Promise<QrCode> {
    // [PR1197-S1-04] The vendor is read FIRST, because its tenant is part of
    // what makes an existing code THIS vendor's code. Matching on entityId
    // alone returned a row stamped with a tenant the vendor no longer belongs
    // to — and once the resolver correctly began binding id + tenantId, that
    // stale row resolved to NOTHING. A printed code that silently stops working
    // is a worse outcome than the disclosure it replaced.
    //
    // That is now prevented at the source rather than compensated for here: a
    // vendor's tenant never changes (`vendors_tenant_immutable`), and a code's
    // tenant must match its vendor's (`qr_codes_tenant_matches_vendor`), so a
    // code whose tenant does not match its vendor should not exist. If one
    // does — historical residue predating the guard — this read simply does
    // not reuse it and the vendor mints a fresh one.
    //
    // An earlier version of this comment said the stale code "stays deactivated
    // history". It did not: nothing deactivated it, and it remained ACTIVE and
    // unreachable. Said plainly instead of asserted.
    const vendor = await this.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { slug: true, tenantId: true },
    });
    const existing = await this.prisma.qrCode.findFirst({
      where: { entityType: 'VENDOR', entityId: vendorId, tenantId: vendor.tenantId, status: 'ACTIVE' },
    });
    if (existing) return existing;
    // Version continuity: minting after a deactivate continues the sequence
    // (…v2 DEACTIVATED → v3 ACTIVE), so per-version analytics never collide.
    const latest = await this.prisma.qrCode.aggregate({
      _max: { version: true },
      where: { entityType: 'VENDOR', entityId: vendorId },
    });
    try {
      return await this.createRow(vendor.tenantId, vendorId, vendor.slug, createdByUserId, (latest._max.version ?? 0) + 1);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Lost the one-ACTIVE race — the winner's row is the vendor's code.
      return this.prisma.qrCode.findFirstOrThrow({
        where: { entityType: 'VENDOR', entityId: vendorId, tenantId: vendor.tenantId, status: 'ACTIVE' },
      });
    }
  }

  /** Supersede the current code (grace clock starts) and mint the next
   *  version. Returns the new ACTIVE row. */
  async regenerateForVendor(vendorId: string, createdByUserId: string): Promise<{ current: QrCode; superseded: QrCode | null }> {
    const vendor = await this.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { slug: true, tenantId: true },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const active = await this.prisma.qrCode.findFirst({
        // Bound to the VENDOR'S tenant, exactly as getOrCreateForVendor is. An
        // unscoped caller (a job, system mode, or a raw PrismaClient) otherwise
        // picks up a stale ACTIVE row from the tenant the vendor used to be in,
        // supersedes THAT, and creates in the new one — where the partial
        // unique then bites and the fallback read below can return the foreign
        // row. The route answers 200 with a code that resolves to /qr/unavailable.
        where: { entityType: 'VENDOR', entityId: vendorId, status: 'ACTIVE', tenantId: vendor.tenantId },
      });
      try {
        if (!active) {
          return { current: await this.createRow(vendor.tenantId, vendorId, vendor.slug, createdByUserId, 1), superseded: null };
        }
        const current = await this.prisma.$transaction(async (tx) => {
          // Guarded supersede: if a concurrent regenerate got here first this
          // matches 0 rows, the create below then hits the partial unique.
          await tx.qrCode.updateMany({
            where: { id: active.id, status: 'ACTIVE' },
            data: { status: 'SUPERSEDED', supersededAt: new Date() },
          });
          return tx.qrCode.create({
            data: {
              tenantId: vendor.tenantId,
              entityType: 'VENDOR',
              entityId: vendorId,
              shortCode: generateShortCode(),
              slug: vendor.slug,
              version: active.version + 1,
              createdById: createdByUserId,
            },
          });
        });
        return { current, superseded: active };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        // Concurrent lifecycle write — loop once to observe the new state.
      }
    }
    const winner = await this.prisma.qrCode.findFirstOrThrow({
      where: { entityType: 'VENDOR', entityId: vendorId, status: 'ACTIVE', tenantId: vendor.tenantId },
    });
    return { current: winner, superseded: null };
  }

  /** Vendor kill switch (stolen materials): effective immediately, idempotent. */
  async deactivateForVendor(vendorId: string): Promise<{ deactivated: number }> {
    const result = await this.prisma.qrCode.updateMany({
      where: { entityType: 'VENDOR', entityId: vendorId, status: 'ACTIVE' },
      data: { status: 'DEACTIVATED', deactivatedAt: new Date() },
    });
    return { deactivated: result.count };
  }

  private async createRow(
    tenantId: string,
    vendorId: string,
    slug: string,
    createdById: string,
    version: number,
  ): Promise<QrCode> {
    // A shortCode collision is a ~28^-10 event; one retry makes it impossible
    // to observe while still surfacing genuine one-ACTIVE races to the caller.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.qrCode.create({
          data: {
            tenantId,
            entityType: 'VENDOR',
            entityId: vendorId,
            shortCode: generateShortCode(),
            slug,
            version,
            createdById,
          },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        const target = String((e.meta as { target?: unknown } | undefined)?.target ?? '');
        // A short code that was EVER issued is refused by the identity
        // registry's trigger (qr_codes_token_reserve) as a unique violation
        // that reaches Prisma without a target. Either way the code is taken:
        // draw a new one once. (A one-ACTIVE race then fails again on the
        // second attempt and surfaces to the caller exactly as before.)
        if (attempt === 0 && (target.includes('shortCode') || target === '')) continue;
        throw e;
      }
    }
  }
}
