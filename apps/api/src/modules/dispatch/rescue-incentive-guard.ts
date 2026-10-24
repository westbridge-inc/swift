import type { PrismaClient } from '@prisma/client';
import { isProduction } from '../../utils/runtime-mode';

// ---------------------------------------------------------------------------
// [Row 208 guard · GUARDRAILS §7 · coordinator ruling 2026-10-05 Q1]
// `rescue.incentiveGyd` is Swift's OWN money owed to a mover. Nothing pays it
// out yet, and account deletion does not wait for an unpaid one, so it stays 0
// until BOTH a payout path and a deletion block for unpaid incentives ship.
// The code default alone was not a guard: one algo_config row switched it on.
// This is the guard: the installer's seed plan refuses to write a non-zero
// value, production does not complete its boot contract with one stored, and
// an offer in production never carries one. Lifting it is the same change
// that ships the payout path and the deletion block.
// ---------------------------------------------------------------------------

export const RESCUE_INCENTIVE_KEY = 'rescue.incentiveGyd';

/** Why a value for `key` is refused, or null. Only exactly 0 (or JSON null,
 *  a row that says nothing) keeps the incentive off; anything else, a numeric
 *  string included, is refused. */
export function rescueIncentiveRefusal(key: string, value: unknown): string | null {
  if (key !== RESCUE_INCENTIVE_KEY) return null;
  if (value === 0 || value === null) return null;
  return `${RESCUE_INCENTIVE_KEY} must stay 0 until a payout path and a deletion block for unpaid incentives ship (got ${JSON.stringify(value)})`;
}

/** The tenants whose CURRENT rescue.incentiveGyd is not 0. In production this
 *  throws (the boot contract stays incomplete: readiness 503); elsewhere it
 *  names them. */
export async function enforceRescueIncentiveOffAtBoot(
  prisma: PrismaClient,
  log: { warn: (obj: { tenants: string[] }, msg: string) => void },
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const rows = await prisma.algoConfig.findMany({
    where: { key: RESCUE_INCENTIVE_KEY },
    orderBy: [{ tenantId: 'asc' }, { version: 'desc' }],
    select: { tenantId: true, value: true, version: true },
  });
  const seen = new Set<string>();
  const on: string[] = [];
  for (const row of rows) {
    if (seen.has(row.tenantId)) continue; // only the newest version is in force
    seen.add(row.tenantId);
    if (rescueIncentiveRefusal(RESCUE_INCENTIVE_KEY, row.value)) on.push(row.tenantId);
  }
  if (on.length > 0) {
    if (isProduction(env)) throw new Error(`${RESCUE_INCENTIVE_KEY} is switched on for tenant(s) ${on.join(', ')}: it must stay 0 until a payout path and a deletion block ship`);
    log.warn({ tenants: on }, `${RESCUE_INCENTIVE_KEY} is not 0 here: production refuses to boot like this`);
  }
  return on;
}

/** The amount an offer may carry. Production carries none while the guard stands. */
export function rescueIncentivePayable(gyd: number, env: Record<string, string | undefined> = process.env): number {
  return isProduction(env) ? 0 : gyd;
}
