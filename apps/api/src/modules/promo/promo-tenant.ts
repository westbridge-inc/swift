import type { PrismaClient } from '@prisma/client';
import { resolvePublicMarketTenant } from '../search/search-scope';
import { getTenantId } from '../../plugins/tenant-context';
import { AppError } from '../../utils/errors';

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
  promo: { vendorId: string | null } | null,
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
  // Use the same indexed ownership reads for unknown, platform and store
  // codes. Callers must not skip this check when the code lookup is empty:
  // the extra query count must not identify a foreign code.
  let publicTenantId: string | null = null;
  try { publicTenantId = await resolvePublicMarketTenant({ prisma }); }
  catch (error) {
    // The resolver already counts misconfiguration for operators. Its
    // diagnostic must not tell a foreign caller that this code exists.
    if (!(error instanceof AppError && (error.code === 'PUBLIC_TENANT_UNRESOLVED' || error.code === 'NOT_FOUND'))) throw error;
  }
  const vendor = await prisma.vendor.findUnique({
    where: { id: promo?.vendorId ?? '__no_promo_vendor__' }, select: { tenantId: true },
  });
  if (!promo) return false;
  return promo.vendorId === null
    ? callerTenantId === publicTenantId
    : vendor !== null && vendor.tenantId === callerTenantId;
}
