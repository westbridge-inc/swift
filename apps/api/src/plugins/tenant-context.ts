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
  tenantContext.enterWith({ tenantId: null });
}

/**
 * Bind the current request to a tenant. Mutates the fresh per-request store
 * from beginRequestTenantContext when present (the safe path); falls back to
 * enterWith so it still works if the onRequest hook wasn't installed.
 */
export function enterTenant(tenantId: string | null): void {
  const store = tenantContext.getStore();
  if (store) store.tenantId = tenantId;
  else tenantContext.enterWith({ tenantId });
}

/** Run a function with tenant scoping explicitly OFF (cross-tenant admin/system
 *  work). Restores the prior context afterwards. The `await` inside `run` keeps
 *  the context alive across the callee's deferred continuations (e.g. Prisma
 *  runs its query extensions in a later microtask) — without it, a callback
 *  that merely RETURNS a promise loses the context the moment run() unwinds. */
export async function runWithoutTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId: null }, async () => await fn());
}

/** Run a function scoped to a specific tenant (tests, targeted system tasks). */
export async function runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId }, async () => await fn());
}
