import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, NotFoundError } from '../../utils/errors';
import { enterTenant, getTenantContext } from '../../plugins/tenant-context';
import { searchScopeCounter } from '../../plugins/observability';

// ---------------------------------------------------------------------------
// [R048-003] THE PUBLIC MARKET / SEARCH SCOPE.
//
// The catalogue and search surfaces resolved a category by slug without a
// tenant, loaded taxonomy rows by category alone, queried visible items across
// every active tenant, kept ONE global `vendors` and ONE global `items` index
// whose documents carried no tenant field, filtered with strings that
// interpolated user-controlled values, and never deleted a removed tenant's
// stale documents. Two operators with the same category slug — the taxonomy
// is unique per (tenant, slug) — meant a guest could receive the other
// operator's catalogue.
//
// Every public catalogue/search request now carries ONE explicit scope: the
// tenant. It is resolved here, bound to the request (so the tenant-scoped
// Prisma models partition themselves), carried through the index document id,
// the index filter (server-built, escaped, mandatory), the page cursor, and
// the database fallback.
// ---------------------------------------------------------------------------

/** Bumped when the document shape changes: a new index is a new name, so an
 *  old index can stay read-only for rollback while the new one fills. */
export const SEARCH_INDEX_VERSION = 'v2';
export const VENDOR_INDEX = `vendors_${SEARCH_INDEX_VERSION}`;
export const ITEM_INDEX = `items_${SEARCH_INDEX_VERSION}`;

/** Meilisearch primary keys allow [A-Za-z0-9_-]; tenant ids and cuids do too.
 *  A part may hold a single underscore but never the double one, so the id
 *  parses back unambiguously. */
const DOC_ID_SEP = '__';
const ID_PART = /^[A-Za-z0-9_-]+$/;
const isIdPart = (v: string): boolean => ID_PART.test(v) && !v.includes(DOC_ID_SEP);
export function docId(tenantId: string, entityId: string): string {
  if (!isIdPart(tenantId) || !isIdPart(entityId)) {
    throw new Error(`[R048-003] cannot build a document id from tenant "${tenantId}" and entity "${entityId}"`);
  }
  return `${tenantId}${DOC_ID_SEP}${entityId}`;
}
export function parseDocId(id: string): { tenantId: string; entityId: string } | null {
  const at = id.indexOf(DOC_ID_SEP);
  if (at <= 0 || at + DOC_ID_SEP.length >= id.length) return null;
  return { tenantId: id.slice(0, at), entityId: id.slice(at + DOC_ID_SEP.length) };
}

// ---------------------------------------------------------------------------
// The filter builder. Never a concatenated string: every value is validated
// and escaped, and the tenant clause is the one clause a caller cannot omit.
// ---------------------------------------------------------------------------

export class FilterValueRejected extends Error {
  readonly code = 'FILTER_VALUE_REJECTED';
  constructor(attribute: string, reason: string) {
    super(`[R048-003] filter value for "${attribute}" rejected: ${reason}`);
    this.name = 'FilterValueRejected';
  }
}

const ATTRIBUTE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_VALUE_LENGTH = 120;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A string value becomes a double-quoted Meilisearch literal: backslashes and
 *  quotes are escaped; control characters are refused. Whatever else the value
 *  holds — operators, parentheses, AND/OR — stays literal inside the quotes. */
export function escapeFilterValue(attribute: string, value: string): string {
  if (value.length === 0) throw new FilterValueRejected(attribute, 'empty');
  if (value.length > MAX_VALUE_LENGTH) throw new FilterValueRejected(attribute, `longer than ${MAX_VALUE_LENGTH}`);
  if (CONTROL.test(value)) throw new FilterValueRejected(attribute, 'control character');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export type FilterClause =
  | { attribute: string; op: '=' | '!='; value: string | boolean }
  | { attribute: string; op: '<' | '<=' | '>' | '>='; value: number };

export function renderClause(c: FilterClause): string {
  if (!ATTRIBUTE.test(c.attribute)) throw new FilterValueRejected(c.attribute, 'not an attribute name');
  if (typeof c.value === 'boolean') return `${c.attribute} ${c.op} ${c.value ? 'true' : 'false'}`;
  if (typeof c.value === 'number') {
    if (!Number.isFinite(c.value)) throw new FilterValueRejected(c.attribute, 'not a finite number');
    return `${c.attribute} ${c.op} ${c.value}`;
  }
  return `${c.attribute} ${c.op} ${escapeFilterValue(c.attribute, c.value)}`;
}

/** The server-built filter: the tenant clause first and always, then the
 *  caller's clauses. Returns Meilisearch's array form (each element ANDed). */
export function buildScopedFilter(tenantId: string, clauses: FilterClause[]): string[] {
  if (!tenantId) throw new FilterValueRejected('tenantId', "missing — every search is one tenant's");
  return [renderClause({ attribute: 'tenantId', op: '=', value: tenantId }), ...clauses.map(renderClause)];
}

// ---------------------------------------------------------------------------
// The resolvers: who is this request's tenant?
// ---------------------------------------------------------------------------

/** An authenticated caller's tenant, as the auth plugin bound it. A request
 *  that reached a search route without one is a wiring fault — refused, never
 *  widened to "all tenants". */
export function requireRequestTenant(request?: Pick<FastifyRequest, 'tenantId'>): string {
  const ctx = getTenantContext();
  const tenantId = request?.tenantId ?? ctx.tenantId;
  if (!tenantId) {
    searchScopeCounter.labels('unbound_request_refused').inc();
    throw new AppError(500, 'TENANT_CONTEXT_REQUIRED', 'This search reached the database with no tenant bound.');
  }
  return tenantId;
}

/**
 * The explicit PUBLIC market resolver — the same rule the public storefront
 * directory uses, made a single function with a name so a guest surface cannot
 * forget it: `PUBLIC_TENANT_ID` names the operator and is verified on every
 * request (an id pointing at nothing or at a deactivated operator is a loud
 * 503, never an empty grid); with it unset, exactly one active tenant may
 * exist, and two means the deployment has to say which.
 */
export async function resolvePublicMarketTenant(app: FastifyInstance): Promise<string> {
  const explicit = process.env['PUBLIC_TENANT_ID'];
  if (explicit) {
    const configured = await app.prisma.tenant.findUnique({ where: { id: explicit }, select: { id: true, isActive: true, kind: true } });
    if (!configured) {
      searchScopeCounter.labels('public_tenant_unresolved').inc();
      throw new AppError(503, 'PUBLIC_TENANT_UNRESOLVED', 'PUBLIC_TENANT_ID names a tenant that does not exist — the deployment is misconfigured.');
    }
    if (!configured.isActive) {
      searchScopeCounter.labels('disabled_tenant_hit').inc();
      throw new AppError(503, 'PUBLIC_TENANT_UNRESOLVED', 'PUBLIC_TENANT_ID names an INACTIVE tenant — its catalogue is not public.');
    }
    if (configured.kind !== 'PRODUCTION') {
      // [STA-1 DL-7] A fiction is never the public catalogue, however the
      // deployment is configured.
      searchScopeCounter.labels('public_tenant_unresolved').inc();
      throw new AppError(503, 'PUBLIC_TENANT_UNRESOLVED', `PUBLIC_TENANT_ID names a ${configured.kind} tenant — only a PRODUCTION tenant can be the public catalogue.`);
    }
    return configured.id;
  }
  // [STA-1 DL-7] Only PRODUCTION tenants are candidates: provisioning the
  // store-review fiction (a second ACTIVE tenant) must not make the public
  // catalogue ambiguous, and must never make it the fiction.
  const active = await app.prisma.tenant.findMany({ where: { isActive: true, kind: 'PRODUCTION' }, select: { id: true }, take: 2 });
  if (active.length === 1) return active[0]!.id;
  searchScopeCounter.labels('public_tenant_unresolved').inc();
  if (active.length === 0) throw new NotFoundError('Catalogue');
  throw new AppError(503, 'PUBLIC_TENANT_UNRESOLVED', 'The public catalogue is not configured for a multi-tenant deployment — set PUBLIC_TENANT_ID.');
}

/** A preHandler for guest catalogue routes: resolve the public tenant and BIND
 *  it to the request, so every tenant-scoped model the handler touches —
 *  categories, taxonomy rows, vendors — partitions itself, and the handler can
 *  read the same id back for the models that carry no tenant of their own. */
export function bindPublicMarketTenant(app: FastifyInstance) {
  return async (request: FastifyRequest): Promise<void> => {
    const tenantId = await resolvePublicMarketTenant(app);
    enterTenant(tenantId);
    request.publicTenantId = tenantId;
  };
}

/** Tenant-checked cursors: a page cursor names the tenant it was minted for,
 *  and is refused for any other — a cursor cannot walk another operator's
 *  catalogue, nor a different sort. */
export function encodeScopedCursor(tenantId: string, id: string, sort: string): string {
  return Buffer.from(JSON.stringify({ i: id, s: sort, t: tenantId })).toString('base64url');
}
export function decodeScopedCursor(raw: string, tenantId: string, sort: string): string {
  let parsed: { i?: unknown; s?: unknown; t?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new AppError(400, 'BAD_CURSOR', 'That page cursor is not readable — start from the first page.');
  }
  if (typeof parsed.i !== 'string' || parsed.s !== sort) {
    throw new AppError(400, 'BAD_CURSOR', 'That page cursor belongs to a different sort — start from the first page.');
  }
  if (parsed.t !== tenantId) {
    searchScopeCounter.labels('cross_tenant_cursor').inc();
    throw new AppError(400, 'BAD_CURSOR', 'That page cursor belongs to a different catalogue — start from the first page.');
  }
  return parsed.i;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** [R048-003] The caller's tenant as the auth plugin bound it (authenticated requests). */
    tenantId?: string | null;
    /** [R048-003] The public tenant this guest request was bound to. */
    publicTenantId?: string;
  }
}
