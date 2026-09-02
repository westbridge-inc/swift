// PERSISTED AUTH NORMALIZATION [MOB-007 / TST-008] — pure, no RN imports.
//
// The auth store persists an identity tuple (user, access token, refresh
// token, isAuthenticated, principal generation, ad-event scope) in encrypted
// storage. Storage is a device: it can be partial, truncated, hand-edited,
// restored from a backup of another build, or written by a future version.
// The store used to accept whatever came back — a `migrate` that only ran on a
// version change and returned v2 state as-is — so a tuple that said
// "authenticated" with no user, or no refresh token, entered the runtime and
// reached the root navigator, which applied the selfie gate only when a user
// was present. Partial auth, privileged stack.
//
// Every hydration now passes through ONE normalizer with one law: the tuple is
// either fully consistent — authenticated with a user id, both tokens, a
// well-formed role set, a safe-integer generation and a non-empty scope — or
// it is SIGNED OUT, atomically, before the first privileged render. Device
// context (country, dial code, currency) survives; everything session-scoped
// goes; the principal generation advances so any work keyed to the old
// boundary is stale. The reason is recorded (never a credential). Rollback
// prefers sign-out; nothing here tolerates partial auth.

export const AUTH_PERSIST_VERSION = 2;

export const AUTH_INTENTS = ['customer', 'mover', 'vendor', 'advertiser'] as const;
export type AuthIntent = (typeof AUTH_INTENTS)[number];
export const MOVER_PRESETS = ['delivery', 'taxi'] as const;
export type MoverPreset = (typeof MOVER_PRESETS)[number];

/** Exactly the fields the store persists (its `partialize`). */
export interface PersistedAuth {
  user: PersistedUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  intent: AuthIntent | null;
  moverPreset: MoverPreset | null;
  countryCode: string | null;
  dialCode: string | null;
  currencyCode: string | null;
  currencySymbol: string | null;
  sessionGeneration: number;
  adEventScopeId: string;
}

/** The parts of a persisted user the gate depends on; the rest rides along. */
export interface PersistedUser {
  id: string;
  roles: string[];
  activeRole: string;
  [key: string]: unknown;
}

export type HydrationReason =
  | 'ok'
  | 'signed_out'
  | 'not_an_object'
  | 'unknown_version'
  | 'authenticated_without_user'
  | 'user_without_id'
  | 'missing_access_token'
  | 'missing_refresh_token'
  | 'credentials_without_authentication'
  | 'invalid_generation'
  | 'invalid_scope'
  | 'invalid_roles'
  | 'invalid_active_role'
  | 'unreadable';

export interface HydrationResult {
  state: PersistedAuth;
  reason: HydrationReason;
  /** True when the persisted tuple was inconsistent and was replaced by a signed-out state. */
  normalized: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const validGeneration = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function deviceContext(p: Record<string, unknown>): Pick<PersistedAuth, 'countryCode' | 'dialCode' | 'currencyCode' | 'currencySymbol'> {
  return { countryCode: str(p['countryCode']), dialCode: str(p['dialCode']), currencyCode: str(p['currencyCode']), currencySymbol: str(p['currencySymbol']) };
}

function signedOut(p: Record<string, unknown> | null, reason: HydrationReason, generationAfter: number, newScopeId: () => string): HydrationResult {
  return {
    reason,
    normalized: reason !== 'signed_out',
    state: {
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      intent: null,
      moverPreset: null,
      ...(p ? deviceContext(p) : { countryCode: null, dialCode: null, currencyCode: null, currencySymbol: null }),
      sessionGeneration: generationAfter,
      adEventScopeId: newScopeId(),
    },
  };
}

/**
 * The one law, applied to whatever storage returned. `version` is the persisted
 * schema version (zustand's); a legacy v1 tuple is repaired the way the old
 * migration did — a missing generation is 0, a missing scope is minted — and
 * then judged by exactly the same rule as a v2 tuple.
 */
export function normalizePersistedAuth(raw: unknown, version: number, newScopeId: () => string): HydrationResult {
  if (!isRecord(raw)) return signedOut(null, 'not_an_object', 1, newScopeId);
  const p = raw;
  const legacy = version < AUTH_PERSIST_VERSION;
  const generationRaw = legacy && p['sessionGeneration'] === undefined ? 0 : p['sessionGeneration'];
  const scopeRaw = legacy && p['adEventScopeId'] === undefined ? newScopeId() : p['adEventScopeId'];
  const generationOk = validGeneration(generationRaw);
  // The boundary after a normalization: past any VALID persisted generation (so
  // work keyed to it is stale), or 1 when the persisted one cannot be trusted.
  const bumped = (generationOk ? generationRaw : 0) + 1;
  if (!Number.isSafeInteger(version) || version > AUTH_PERSIST_VERSION) return signedOut(p, 'unknown_version', bumped, newScopeId);

  const user = p['user'];
  const accessToken = p['accessToken'];
  const refreshToken = p['refreshToken'];

  if (p['isAuthenticated'] !== true) {
    // A signed-out tuple must carry nothing session-scoped; credentials or a
    // user without the flag are a partial state, not a signed-out one.
    if (user != null || accessToken != null || refreshToken != null) return signedOut(p, 'credentials_without_authentication', bumped, newScopeId);
    if (!generationOk) return signedOut(p, 'invalid_generation', bumped, newScopeId);
    const scope = str(scopeRaw);
    return {
      reason: 'signed_out',
      normalized: false,
      state: {
        user: null, accessToken: null, refreshToken: null, isAuthenticated: false, intent: null, moverPreset: null,
        ...deviceContext(p), sessionGeneration: generationRaw, adEventScopeId: scope ?? newScopeId(),
      },
    };
  }

  if (!isRecord(user)) return signedOut(p, 'authenticated_without_user', bumped, newScopeId);
  if (!str(user['id'])) return signedOut(p, 'user_without_id', bumped, newScopeId);
  if (!str(accessToken)) return signedOut(p, 'missing_access_token', bumped, newScopeId);
  if (!str(refreshToken)) return signedOut(p, 'missing_refresh_token', bumped, newScopeId);
  if (!generationOk) return signedOut(p, 'invalid_generation', bumped, newScopeId);
  const scope = str(scopeRaw);
  if (!scope) return signedOut(p, 'invalid_scope', bumped, newScopeId);
  const roles = user['roles'];
  if (!Array.isArray(roles) || roles.length === 0 || !roles.every((r) => typeof r === 'string' && r.length > 0)) return signedOut(p, 'invalid_roles', bumped, newScopeId);
  const activeRole = user['activeRole'];
  if (typeof activeRole !== 'string' || !roles.includes(activeRole)) return signedOut(p, 'invalid_active_role', bumped, newScopeId);

  const intent = (AUTH_INTENTS as readonly string[]).includes(p['intent'] as string) ? (p['intent'] as AuthIntent) : null;
  const moverPreset = (MOVER_PRESETS as readonly string[]).includes(p['moverPreset'] as string) ? (p['moverPreset'] as MoverPreset) : null;
  return {
    reason: 'ok',
    normalized: false,
    state: {
      user: user as PersistedUser,
      accessToken: accessToken as string,
      refreshToken: refreshToken as string,
      isAuthenticated: true,
      intent,
      moverPreset,
      ...deviceContext(p),
      sessionGeneration: generationRaw,
      adEventScopeId: scope,
    },
  };
}

/** The consistency law as a predicate, for tests and assertions: authenticated ⇔ a full tuple. */
export function isConsistentAuth(state: PersistedAuth): boolean {
  const full = !!state.user && typeof state.user.id === 'string' && state.user.id.length > 0 && !!state.accessToken && !!state.refreshToken
    && Array.isArray(state.user.roles) && state.user.roles.length > 0 && state.user.roles.includes(state.user.activeRole)
    && validGeneration(state.sessionGeneration) && typeof state.adEventScopeId === 'string' && state.adEventScopeId.length > 0;
  const empty = state.user === null && state.accessToken === null && state.refreshToken === null && state.intent === null && state.moverPreset === null
    && validGeneration(state.sessionGeneration) && typeof state.adEventScopeId === 'string' && state.adEventScopeId.length > 0;
  return state.isAuthenticated ? full : empty;
}

// ---------------------------------------------------------------------------
// The metric: auth_hydration_normalized_reason — a reason, never a credential.
// ---------------------------------------------------------------------------

const counts = new Map<HydrationReason, number>();

export function recordHydration(reason: HydrationReason): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

export function hydrationCounters(): Partial<Record<HydrationReason, number>> {
  return Object.fromEntries(counts) as Partial<Record<HydrationReason, number>>;
}

export function resetHydrationCountersForTests(): void {
  counts.clear();
}
