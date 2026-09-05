/**
 * [STA-1 DL-4 / RLS-N6] Belt to the tenant wall's braces.
 *
 * The tenant wall (Prisma scoping + RLS) keeps the review fiction out of a
 * request's queries. An aggregate that counts people or money must ALSO say
 * so itself, so the same query run without a tenant context — a job, a
 * report, a founder's dashboard poll — still cannot count the fiction.
 * Spread these into the `where` of every such aggregate.
 */

/** Rows that belong to a PRODUCTION tenant. For any model with a `tenant` relation. */
export const PRODUCTION_TENANT = { tenant: { kind: 'PRODUCTION' as const } };

/** Real people: not synthetic, and in a PRODUCTION tenant. For User and Vendor. */
export const REAL_PEOPLE = { isSynthetic: false, ...PRODUCTION_TENANT };
