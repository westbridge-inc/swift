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
const publiclyLive = (vendor: { status: string; isVerified: boolean }): boolean =>
  vendor.status === 'ACTIVE' && vendor.isVerified;

export type QrLookupRow = QrLookup & { id: string; tenantId: string; version: number };

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
      select: { id: true, tenantId: true, shortCode: true, status: true, supersededAt: true, version: true, entityId: true },
    });
    if (!qr) return null;
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: qr.entityId },
      select: { slug: true, status: true, isVerified: true },
    });
    return {
      id: qr.id,
      tenantId: qr.tenantId,
      shortCode: qr.shortCode,
      status: qr.status,
      supersededAt: qr.supersededAt,
      version: qr.version,
      entity: vendor ? { live: publiclyLive(vendor), slug: vendor.slug } : null,
    };
  }

  /** Idempotent get-or-create of the entity's ACTIVE code. Concurrency-safe:
   *  the partial unique makes the second creator lose with P2002 → re-read. */
  async getOrCreateForVendor(vendorId: string, createdByUserId: string): Promise<QrCode> {
    const existing = await this.prisma.qrCode.findFirst({
      where: { entityType: 'VENDOR', entityId: vendorId, status: 'ACTIVE' },
    });
    if (existing) return existing;

    const vendor = await this.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { slug: true, tenantId: true },
    });
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
        where: { entityType: 'VENDOR', entityId: vendorId, status: 'ACTIVE' },
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
        where: { entityType: 'VENDOR', entityId: vendorId, status: 'ACTIVE' },
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
      where: { entityType: 'VENDOR', entityId: vendorId, status: 'ACTIVE' },
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
