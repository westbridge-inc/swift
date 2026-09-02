import { describe, it, expect } from 'vitest';
import { AUTH_PERSIST_VERSION, hydrationCounters, isConsistentAuth, normalizePersistedAuth, recordHydration, resetHydrationCountersForTests, type HydrationReason } from './authHydration';

// ---------------------------------------------------------------------------
// [MOB-007 / TST-008] Persisted auth is either a full tuple or signed out.
//
// The property, checked EXHAUSTIVELY rather than sampled: over every
// combination of the tuple's fields being valid, missing or malformed, exactly
// one combination hydrates authenticated (the fully valid one) and every other
// one becomes a signed-out state that is itself consistent, carries no
// credential, keeps only device context, and advances the principal boundary.
// ---------------------------------------------------------------------------

let n = 0;
const newScope = () => `scope-new-${++n}`;
const without = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

const VALID = {
  user: { id: 'u-1', roles: ['CUSTOMER', 'VENDOR'], activeRole: 'VENDOR', firstName: 'A' },
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  isAuthenticated: true,
  intent: 'vendor',
  moverPreset: null,
  countryCode: 'GY',
  dialCode: '+592',
  currencyCode: 'GYD',
  currencySymbol: 'GY$',
  sessionGeneration: 7,
  adEventScopeId: 'scope-7',
};

/** Every way each tuple field can go wrong, one variant per field per row. */
const CORRUPTIONS: Record<string, unknown[]> = {
  user: [undefined, null, 'u-1', 42, [], { roles: ['CUSTOMER'], activeRole: 'CUSTOMER' }, { id: '', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' }, { id: 'u-1', roles: 'CUSTOMER', activeRole: 'CUSTOMER' }, { id: 'u-1', roles: [], activeRole: 'CUSTOMER' }, { id: 'u-1', roles: ['CUSTOMER', 3], activeRole: 'CUSTOMER' }, { id: 'u-1', roles: ['CUSTOMER'], activeRole: 'VENDOR' }, { id: 'u-1', roles: ['CUSTOMER'] }],
  accessToken: [undefined, null, '', 0, {}],
  refreshToken: [undefined, null, '', 0, {}],
  isAuthenticated: [undefined, null, false, 'true', 1],
  sessionGeneration: [undefined, null, -1, 1.5, Number.NaN, '7', Number.MAX_SAFE_INTEGER + 1],
  adEventScopeId: [undefined, null, '', 9],
};

describe('[MOB-007] the exhaustive law: one valid tuple, every other combination signed out', () => {
  it('walks every single-field and every pairwise corruption of the tuple', () => {
    const fields = Object.keys(CORRUPTIONS);
    const rows: Array<{ label: string; state: Record<string, unknown> }> = [];
    for (const f of fields) for (const v of CORRUPTIONS[f]!) rows.push({ label: `${f}=${JSON.stringify(v)}`, state: { ...VALID, [f]: v } });
    for (let i = 0; i < fields.length; i += 1) {
      for (let j = i + 1; j < fields.length; j += 1) {
        for (const a of CORRUPTIONS[fields[i]!]!) for (const b of CORRUPTIONS[fields[j]!]!) {
          rows.push({ label: `${fields[i]}=${JSON.stringify(a)} & ${fields[j]}=${JSON.stringify(b)}`, state: { ...VALID, [fields[i]!]: a, [fields[j]!]: b } });
        }
      }
    }
    expect(rows.length).toBeGreaterThan(500);
    for (const { label, state } of rows) {
      const r = normalizePersistedAuth(state, AUTH_PERSIST_VERSION, newScope);
      expect(r.state.isAuthenticated, label).toBe(false);
      expect(r.reason, label).not.toBe('ok');
      expect(r.state.user, label).toBeNull();
      expect(r.state.accessToken, label).toBeNull();
      expect(r.state.refreshToken, label).toBeNull();
      expect(r.state.intent, label).toBeNull();
      expect(r.state.moverPreset, label).toBeNull();
      expect(isConsistentAuth(r.state), label).toBe(true);
      // device context survives; the boundary advances past any valid persisted generation; the scope is fresh
      expect(r.state.countryCode, label).toBe('GY');
      expect(r.state.dialCode, label).toBe('+592');
      if (typeof state['sessionGeneration'] === 'number' && Number.isSafeInteger(state['sessionGeneration']) && state['sessionGeneration'] >= 0) {
        expect(r.state.sessionGeneration, label).toBe((state['sessionGeneration'] as number) + 1);
      } else {
        expect(r.state.sessionGeneration, label).toBe(1);
      }
      expect(r.state.adEventScopeId, label).toMatch(/^scope-new-/);
      // the one signed-out-but-clean row (isAuthenticated false with NO credentials) never occurs here: VALID carries credentials
      expect(r.normalized, label).toBe(true);
      // no credential in the reason
      expect(r.reason, label).not.toMatch(/access-1|refresh-1|u-1/);
    }
  });

  it('the fully valid tuple hydrates authenticated, unchanged, with reason ok', () => {
    const r = normalizePersistedAuth(VALID, AUTH_PERSIST_VERSION, newScope);
    expect(r).toMatchObject({ reason: 'ok', normalized: false });
    expect(r.state).toEqual(VALID);
    expect(isConsistentAuth(r.state)).toBe(true);
  });

  it('names the FIRST inconsistency it meets, in gate order', () => {
    const cases: Array<[Record<string, unknown>, HydrationReason]> = [
      [{ ...VALID, user: null }, 'authenticated_without_user'],
      [{ ...VALID, user: { roles: ['CUSTOMER'], activeRole: 'CUSTOMER' } }, 'user_without_id'],
      [{ ...VALID, accessToken: '' }, 'missing_access_token'],
      [{ ...VALID, refreshToken: null }, 'missing_refresh_token'],
      [{ ...VALID, sessionGeneration: 1.5 }, 'invalid_generation'],
      [{ ...VALID, adEventScopeId: '' }, 'invalid_scope'],
      [{ ...VALID, user: { id: 'u-1', roles: 'CUSTOMER', activeRole: 'CUSTOMER' } }, 'invalid_roles'],
      [{ ...VALID, user: { id: 'u-1', roles: ['CUSTOMER'], activeRole: 'VENDOR' } }, 'invalid_active_role'],
      [{ ...VALID, isAuthenticated: false }, 'credentials_without_authentication'],
      [{ ...VALID, isAuthenticated: 'true' }, 'credentials_without_authentication'],
    ];
    for (const [state, reason] of cases) expect(normalizePersistedAuth(state, AUTH_PERSIST_VERSION, newScope).reason, reason).toBe(reason);
  });
});

describe('[MOB-007] signed-out tuples, versions and garbage', () => {
  it('a clean signed-out tuple is consistent as it is: not normalized, generation kept, scope kept', () => {
    const r = normalizePersistedAuth({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false, intent: 'customer', countryCode: 'GY', sessionGeneration: 4, adEventScopeId: 'scope-4' }, 2, newScope);
    expect(r).toMatchObject({ reason: 'signed_out', normalized: false });
    expect(r.state).toMatchObject({ isAuthenticated: false, user: null, intent: null, countryCode: 'GY', sessionGeneration: 4, adEventScopeId: 'scope-4' });
  });
  it('a signed-out tuple with a corrupt generation or scope is repaired and counted', () => {
    expect(normalizePersistedAuth({ isAuthenticated: false, sessionGeneration: 'x', adEventScopeId: 'scope' }, 2, newScope)).toMatchObject({ reason: 'invalid_generation', normalized: true, state: { sessionGeneration: 1 } });
    const r = normalizePersistedAuth({ isAuthenticated: false, sessionGeneration: 2, adEventScopeId: '' }, 2, newScope);
    expect(r).toMatchObject({ reason: 'signed_out', state: { sessionGeneration: 2 } });
    expect(r.state.adEventScopeId).toMatch(/^scope-new-/);
  });
  it('a legacy v1 tuple is repaired the way the old migration did, then judged by the same law', () => {
    const legacy = without(VALID, ['sessionGeneration', 'adEventScopeId']);
    const r = normalizePersistedAuth(legacy, 1, newScope);
    expect(r.reason).toBe('ok');
    expect(r.state.sessionGeneration).toBe(0);
    expect(r.state.adEventScopeId).toMatch(/^scope-new-/);
    const partial = normalizePersistedAuth({ ...legacy, refreshToken: null }, 1, newScope);
    expect(partial).toMatchObject({ reason: 'missing_refresh_token', normalized: true, state: { isAuthenticated: false, sessionGeneration: 1 } });
  });
  it('a tuple from a FUTURE version, or no object at all, is signed out — never trusted', () => {
    // a future tuple with a readable generation still advances past it; one without restarts at 1
    expect(normalizePersistedAuth(VALID, AUTH_PERSIST_VERSION + 1, newScope)).toMatchObject({ reason: 'unknown_version', normalized: true, state: { isAuthenticated: false, countryCode: 'GY', sessionGeneration: 8 } });
    expect(normalizePersistedAuth({ ...VALID, sessionGeneration: 'x' }, AUTH_PERSIST_VERSION + 1, newScope)).toMatchObject({ reason: 'unknown_version', state: { sessionGeneration: 1 } });
    for (const raw of [undefined, null, 'string', 42, [], true]) {
      expect(normalizePersistedAuth(raw, 2, newScope), String(raw)).toMatchObject({ reason: 'not_an_object', normalized: true, state: { isAuthenticated: false, user: null, sessionGeneration: 1 } });
    }
  });
  it('intent and mover preset are validated to their enums; device context to strings', () => {
    const r = normalizePersistedAuth({ ...VALID, intent: 'admin', moverPreset: 'plane', countryCode: 7, dialCode: '' }, 2, newScope);
    expect(r.reason).toBe('ok');
    expect(r.state).toMatchObject({ intent: null, moverPreset: null, countryCode: null, dialCode: null });
    expect(normalizePersistedAuth({ ...VALID, intent: 'mover', moverPreset: 'taxi' }, 2, newScope).state).toMatchObject({ intent: 'mover', moverPreset: 'taxi' });
  });
  it('the metric counts reasons only', () => {
    resetHydrationCountersForTests();
    recordHydration('ok'); recordHydration('ok'); recordHydration('missing_refresh_token');
    expect(hydrationCounters()).toEqual({ ok: 2, missing_refresh_token: 1 });
    expect(JSON.stringify(hydrationCounters())).not.toMatch(/access|refresh-1|u-1/);
  });
});
