import type { PrismaClient } from '@prisma/client';

/**
 * [L04 · R0 promo finding] Which tenant a promo code belongs to.
 *
 * promo_codes carries no tenant of its own. A vendor's code belongs to its
 * vendor's tenant; a platform-wide code (no vendor) is Swift's production
 * offer and belongs to the PRODUCTION tenant. Lookup and redemption ask this
 * first: a caller in any other tenant — the app-store REVIEW fiction above
 * all — is told exactly what an unknown code gets, and can never move a
 * production code's redemption count.
 */
export async function promoBelongsToCallerTenant(
  prisma: PrismaClient,
  promo: { vendorId: string | null },
  callerUserId: string,
): Promise<boolean> {
  const caller = await prisma.user.findUnique({
    where: { id: callerUserId },
    select: { tenantId: true, tenant: { select: { kind: true } } },
  });
  if (!caller) return false;
  if (promo.vendorId === null) return caller.tenant.kind === 'PRODUCTION';
  const vendor = await prisma.vendor.findUnique({ where: { id: promo.vendorId }, select: { tenantId: true } });
  return vendor !== null && vendor.tenantId === caller.tenantId;
}
