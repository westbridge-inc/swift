import type { PrismaClient, QrCode } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { generateShortCode, type QrLookup } from './qr-codes';

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

/** The resolver's row-4 liveness rule — the SAME predicate the public
 *  storefront surface uses (public.routes.ts PUBLIC_WHERE): live commerce only,
 *  and a scan of anything else explains nothing (no suspension leakage). */
// [F-028-07] tenant.isActive is part of the rule: a scan of a code whose
// OPERATOR the platform deactivated used to classify as a live destination.
const publiclyLive = (vendor: { status: string; isVerified: boolean; tenant?: { isActive: boolean } | null }): boolean =>
  vendor.status === 'ACTIVE' && vendor.isVerified && vendor.tenant?.isActive === true;

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
    const qr = await this.prisma.qrCode.findUnique({
      where: { shortCode },
      select: { id: true, tenantId: true, shortCode: true, status: true, supersededAt: true, version: true, entityId: true, entityType: true },
    });
    if (!qr) return null;
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
    const vendor = qr.entityType === 'VENDOR'
      ? await this.prisma.vendor.findFirst({
        where: { id: qr.entityId, tenantId: qr.tenantId },
        select: { slug: true, status: true, isVerified: true, tenant: { select: { isActive: true } } },
      })
      : null;
    return {
      id: qr.id,
      tenantId: qr.tenantId,
      shortCode: qr.shortCode,
      status: qr.status,
      supersededAt: qr.supersededAt,
      version: qr.version,
      entityId: qr.entityId,
      entity: vendor ? { live: publiclyLive(vendor), slug: vendor.slug } : null,
    };
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
    // vendor cannot leave its lineage behind (`vendors_tenant_move_guard`), and
    // the supported move (`move_vendor_tenant`) carries the printed codes with
    // it, so a code whose tenant does not match its vendor should not exist. If
    // one does — historical residue predating the guard — this read simply does
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
        const target = isUniqueViolation(e) ? String((e.meta as { target?: unknown } | undefined)?.target ?? '') : '';
        if (attempt === 0 && target.includes('shortCode')) continue;
        throw e;
      }
    }
  }
}
