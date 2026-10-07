import type { PrismaClient } from '@prisma/client';
import { resolvePublicMarketTenant } from '../search/search-scope';
import { getTenantId } from '../../plugins/tenant-context';

/**
 * [L04 · R0 promo finding] Which tenant a promo code belongs to.
 *
 * promo_codes carries no tenant of its own. A vendor's code belongs to its
 * vendor's tenant; a platform-wide code (no vendor) is Swift's production
 * offer and belongs to the production operator (the public catalogue's
 * tenant). Lookup and redemption ask this first: a caller in any other tenant
 * — the app-store REVIEW fiction, or another operator — is told exactly what
 * an unknown code gets, and can never move a production code's redemption
 * count.
 */
export async function promoBelongsToCallerTenant(
  prisma: PrismaClient,
  promo: { vendorId: string | null },
  callerUserId: string,
): Promise<boolean> {
  // The caller's tenant is the one authentication bound for this request — the
  // same source the cart wall reads (vendorTenantForCaller). Outside a bound
  // request (a direct service call) it is read from the account.
  const callerTenantId = getTenantId()
    ?? (await prisma.user.findUnique({ where: { id: callerUserId }, select: { tenantId: true } }))?.tenantId;
  if (!callerTenantId) return false;
  // The production operator by IDENTITY, not by kind: a second PRODUCTION-kind
  // operator must never inherit Swift's platform codes. Same rule as the public
  // catalogue (PUBLIC_TENANT_ID, else the one active PRODUCTION tenant; an
  // ambiguous deployment is a loud refusal, never a guess) — and that rule only
  // ever names a PRODUCTION tenant, so the fiction can never match it.
  if (promo.vendorId === null) {
    return callerTenantId === await resolvePublicMarketTenant({ prisma });
  }
  const vendor = await prisma.vendor.findUnique({ where: { id: promo.vendorId }, select: { tenantId: true } });
  return vendor !== null && vendor.tenantId === callerTenantId;
}
