import type { PrismaClient } from '@prisma/client';
import { runWithTenant } from '../../plugins/tenant-context';
import { AppError } from '../../utils/errors';

const MAX_TENANT_ID_LENGTH = 128;

/**
 * Discovery jobs are allowed to touch taxonomy and catalogue projections only
 * when one concrete tenant is named. There is deliberately no default tenant:
 * a missing worker payload must fail and retry instead of silently operating on
 * Swift's primary tenant.
 */
export function requireDiscoveryTenantId(value: unknown): string {
  const tenantId = typeof value === 'string' ? value.trim() : '';
  if (!tenantId || tenantId.length > MAX_TENANT_ID_LENGTH) {
    throw new AppError(
      400,
      'DISCOVERY_TENANT_REQUIRED',
      'Discovery work requires one explicit tenant id.',
    );
  }
  return tenantId;
}

export function discoveryTenantIdFromJobData(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return requireDiscoveryTenantId(undefined);
  }
  return requireDiscoveryTenantId((data as { tenantId?: unknown }).tenantId);
}

/** Validate the tenant before a targeted admin-triggered job begins. */
export async function requireActiveDiscoveryTenant(
  prisma: PrismaClient,
  data: unknown,
): Promise<string> {
  const tenantId = discoveryTenantIdFromJobData(data);
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { isActive: true },
  });
  if (!tenant?.isActive) {
    throw new AppError(
      409,
      'DISCOVERY_TENANT_UNAVAILABLE',
      'The discovery tenant does not exist or is inactive.',
    );
  }
  return tenantId;
}

/**
 * Recurring platform sweeps enumerate active tenants intentionally, then run
 * every tenant's work inside the same ALS boundary used by authenticated
 * requests. A failure aborts the aggregate job so BullMQ retries it; discovery
 * writes are idempotent, making replay safer than silently skipping a tenant.
 */
export async function runForActiveDiscoveryTenants<T>(
  prisma: PrismaClient,
  work: (tenantId: string) => Promise<T>,
): Promise<Array<{ tenantId: string; result: T }>> {
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  const results: Array<{ tenantId: string; result: T }> = [];
  for (const tenant of tenants) {
    const tenantId = requireDiscoveryTenantId(tenant.id);
    const result = await runWithTenant(tenantId, () => work(tenantId));
    results.push({ tenantId, result });
  }
  return results;
}
