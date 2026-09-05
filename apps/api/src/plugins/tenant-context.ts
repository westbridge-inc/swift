import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request tenant context (multi-tenancy stage 2 enforcement). Set once,
 * right after a request authenticates, from the caller's `tenantId`; read by
 * the Prisma tenant-scope extension so tenant-owned queries are filtered to the
 * caller's tenant automatically.
 *
 * When NO context is set — background jobs, the scheduler, tests seeding
 * fixtures, pre-auth queries (OTP lookup) — queries run UNSCOPED, exactly as
 * before. That keeps single-tenant behavior byte-identical and makes this safe
 * to ship: scoping only activates for an authenticated request.
 */
export interface TenantStore {
  tenantId: string | null;
  /** [TEN-01] How this async flow reached the database: a REQUEST (tenant
   *  bound by authentication, or not yet), a SYSTEM capability (audited
   *  cross-tenant work that names itself), or nothing at all. */
  mode?: 'request' | 'system';
  capability?: string;
}

export type TenantMode = 'request' | 'system' | 'unbound';
export interface TenantContextView { tenantId: string | null; mode: TenantMode; capability: string | null }

/** [TEN-01] The whole context, never just the id: an absent store is
 *  UNBOUND — a composition root that never began a context — and is told
 *  apart from a request that has not bound a tenant yet and from audited
 *  system work. */
export function getTenantContext(): TenantContextView {
  const store = tenantContext.getStore();
  if (!store) return { tenantId: null, mode: 'unbound', capability: null };
  return { tenantId: store.tenantId, mode: store.mode ?? (store.tenantId ? 'request' : 'unbound'), capability: store.capability ?? null };
}

// Pin the ALS to the global symbol registry so there is EXACTLY ONE instance
// process-wide. A module bundler or test runner can otherwise load this file
// twice (two module instances → two AsyncLocalStorage objects), and then the
// store set by `run()` is invisible to `getStore()` in the other copy — which
// silently disables tenant scoping. `Symbol.for` guarantees a single instance.
const KEY = Symbol.for('swift.tenantContext');
const globalRef = globalThis as unknown as { [KEY]?: AsyncLocalStorage<TenantStore> };
export const tenantContext: AsyncLocalStorage<TenantStore> =
  globalRef[KEY] ?? (globalRef[KEY] = new AsyncLocalStorage<TenantStore>());

/** The active tenant for the current async context, or null (unscoped). */
export function getTenantId(): string | null {
  return tenantContext.getStore()?.tenantId ?? null;
}

/**
 * Start a FRESH tenant store for the current request (call from an onRequest
 * hook, before auth). Every request gets its own store object, so a later
 * `enterTenant` mutation can't leak into another request's async context.
 */
export function beginRequestTenantContext(): void {
  tenantContext.enterWith({ tenantId: null, mode: 'request' });
}

/**
 * Bind the current request to a tenant. Mutates the fresh per-request store
 * from beginRequestTenantContext when present (the safe path); falls back to
 * enterWith so it still works if the onRequest hook wasn't installed.
 */
export function enterTenant(tenantId: string | null): void {
  const store = tenantContext.getStore();
  if (store) store.tenantId = tenantId;
  else tenantContext.enterWith({ tenantId, mode: 'request' });
}

/** Run a function with tenant scoping explicitly OFF (cross-tenant admin/system
 *  work). Restores the prior context afterwards. The `await` inside `run` keeps
 *  the context alive across the callee's deferred continuations (e.g. Prisma
 *  runs its query extensions in a later microtask) — without it, a callback
 *  that merely RETURNS a promise loses the context the moment run() unwinds. */
/** [TEN-01] Audited cross-tenant SYSTEM work. Every caller is a capability;
 *  the legacy name stays callable and is counted under `legacy-unscoped` so
 *  the remaining unnamed callers can be found and named (TEN-05). */
/**
 * [STA-1 DL-7 / 4.1] An UNAUTHENTICATED browse of the public surfaces is
 * sanctioned cross-operator work — a guest sees every active PRODUCTION
 * operator (home-popular-rail.test.ts), never the fiction. It runs as audited
 * system work under this capability so `TENANT_UNSCOPED_ACCESS=deny` allows it
 * and counts it, instead of refusing every guest with a 500; the vendor
 * predicates on those surfaces say `kind = PRODUCTION` (visibleVendorForCaller).
 * Called by the public-browse hook ONLY after optional auth bound nobody.
 */
export const PUBLIC_BROWSE_CAPABILITY = 'public-browse';
export function enterPublicBrowse(): void {
  const store = tenantContext.getStore();
  if (store) {
    store.tenantId = null;
    store.mode = 'system';
    store.capability = PUBLIC_BROWSE_CAPABILITY;
  } else {
    tenantContext.enterWith({ tenantId: null, mode: 'system', capability: PUBLIC_BROWSE_CAPABILITY });
  }
}

export async function runWithoutTenant<T>(fn: () => Promise<T>, capability = 'legacy-unscoped'): Promise<T> {
  return tenantContext.run({ tenantId: null, mode: 'system', capability }, async () => await fn());
}

/** The typed, audited system capability: cross-tenant work that names itself. */
export async function runAsSystem<T>(capability: string, fn: () => Promise<T>): Promise<T> {
  if (!capability || capability.length < 3) throw new Error('runAsSystem needs a capability name');
  return tenantContext.run({ tenantId: null, mode: 'system', capability }, async () => await fn());
}

/** Run a function scoped to a specific tenant (tests, targeted system tasks). */
export async function runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId, mode: 'request' }, async () => await fn());
}
