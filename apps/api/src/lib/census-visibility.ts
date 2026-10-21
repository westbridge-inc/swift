import { normalizePolicyExpression, TENANT_POLICY_CONTRACT } from './rls-attestation';

/**
 * [Phase C] May a GLOBAL census trust what THIS connection reads of a table?
 *
 * Erasure proofs (an avatar's obligation census, an object's "no one else
 * points at it" census) read every tenant's rows on purpose. They used to
 * demand `row_security_active(table) = false`, which only the wall-off
 * posture gives (a superuser, a BYPASSRLS login, the owner of an unforced
 * table). On the walled credentials the system login is a swift_bypass_rls
 * member instead: the escape is a term of the tenant policy, not a role
 * attribute, so Postgres still reports row security ACTIVE for it, and the
 * bare check refused it for ever.
 *
 * Each site runs its own catalogue read (so its marker stays its own) and
 * hands the one row here. The answer is true only when either:
 *  - row security is not applied to this connection at all; or
 *  - this connection is a swift_bypass_rls member, every policy that filters
 *    its reads is permissive, and one of them is exactly the tenant contract
 *    (whose escape admits that membership).
 * Anything else, including a missing or malformed row, is false (fail closed).
 */
export type CensusPolicy = { permissive: boolean; cmd: string; applies: boolean; qual: string | null };
export type CensusVisibilityRow = { active: boolean; bypass?: boolean; policies?: CensusPolicy[] };

export function censusSeesEveryRow(rows: readonly CensusVisibilityRow[]): boolean {
  if (rows.length !== 1) return false;
  const [row] = rows;
  if (row?.active === false) return true;
  if (row?.active !== true || row.bypass !== true || !Array.isArray(row.policies)) return false;
  const reads = row.policies.filter((p) => p.applies && (p.cmd === '*' || p.cmd === 'r'));
  return !reads.some((p) => !p.permissive)
    && reads.some((p) => p.permissive && normalizePolicyExpression(p.qual) === TENANT_POLICY_CONTRACT);
}
