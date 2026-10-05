import { describe, it, expect } from 'vitest';
import {
  billingBlocked, classifyVendorProfile, failureOf, memberRoleOf, unwrapOptionalVendorProfile,
} from './vendorProfile';

// ---------------------------------------------------------------------------
// [MOB-038] AN OUTAGE IS NOT "YOU HAVE NO BUSINESS".
//
// The vendor profile ran through a helper that turned EVERY failure into null:
//
//     async function tryUnwrap(p) { try { return await unwrap(p); } catch { return null; } }
//
// and the shell read that null as absence: `if (!store) return <BusinessSetup />`.
// A 401, a 403, a 500, a dropped connection or a schema change told a working
// restaurant it had no business and offered to set one up — while its orders
// were live and its customers were waiting.
//
// The same shape defaulted the member role: `owner?.myRole ?? 'OWNER'`. An
// outage did not merely hide the business; it handed whoever was looking OWNER
// capability over it.
//
// And the operational gate required `store.status === 'SUSPENDED'`, so a
// subscription that was SUSPENDED or CHURNED without that mirror left the
// business taking orders it could not be paid for.
// ---------------------------------------------------------------------------

const err = (status?: number) => ({ response: status === undefined ? undefined : { status } });

describe('[MOB-038] absence is a 404, and nothing else', () => {
  it('a 404 is absence — the one case that means "no business yet"', async () => {
    await expect(unwrapOptionalVendorProfile(Promise.reject(err(404)))).resolves.toBeNull();
  });

  it('every other failure stays a failure — it never becomes "no business"', async () => {
    for (const status of [401, 403, 409, 500, 502, 503]) {
      await expect(unwrapOptionalVendorProfile(Promise.reject(err(status)))).rejects.toBeTruthy();
    }
    await expect(unwrapOptionalVendorProfile(Promise.reject(err(undefined)))).rejects.toBeTruthy();
  });

  it('a good answer is unwrapped', async () => {
    await expect(unwrapOptionalVendorProfile(Promise.resolve({ data: { data: { myRole: 'OWNER' } } })))
      .resolves.toEqual({ myRole: 'OWNER' });
  });
});

// ---------------------------------------------------------------------------
// [phone feedback P2] The account that has never been a vendor.
//
// The server answers the self-profile read of an unheld role with 403 — on
// purpose, pinned by its authz matrix ("authz answers, not existence"), so a
// wrong-role token never gets a route oracle. For the owner's fresh customer
// account that 403 arrived as "This account cannot open that store. Ask the
// owner to add you again." He has no store to be added to; he wanted to list
// one. When the account itself holds no vendor role, the 403 is the server
// confirming "no business" — the one answer that means the setup wizard.
// ---------------------------------------------------------------------------
describe('[P2] an outsider’s own 403 is "no business yet"', () => {
  it('for an account that holds no vendor role, the self-profile 403 is absence → the setup wizard', async () => {
    await expect(unwrapOptionalVendorProfile(Promise.reject(err(403)), { outsider: true })).resolves.toBeNull();
    expect(classifyVendorProfile({ isLoading: false, error: null, owner: null, fetched: true }))
      .toMatchObject({ state: 'absent' });
  });

  it('for an account that HOLDS the vendor role a 403 stays the failure it is — nothing is papered over', async () => {
    await expect(unwrapOptionalVendorProfile(Promise.reject(err(403)), { outsider: false })).rejects.toBeTruthy();
    await expect(unwrapOptionalVendorProfile(Promise.reject(err(403)))).rejects.toBeTruthy();
    expect(classifyVendorProfile({ isLoading: false, error: err(403), owner: undefined, fetched: true }))
      .toEqual({ state: 'error', failure: 'forbidden', myRole: undefined });
  });

  it('only a 403 reads that way: an outage is still an outage for an outsider', async () => {
    for (const status of [401, 409, 500, 502, 503]) {
      await expect(unwrapOptionalVendorProfile(Promise.reject(err(status)), { outsider: true })).rejects.toBeTruthy();
    }
    await expect(unwrapOptionalVendorProfile(Promise.reject(err(undefined)), { outsider: true })).rejects.toBeTruthy();
  });

  it('a good answer is unwrapped whatever the local roles say — the server seats staff and stale-role owners', async () => {
    await expect(unwrapOptionalVendorProfile(Promise.resolve({ data: { data: { myRole: 'STAFF', vendors: [{ id: 'v1' }] } } }), { outsider: true }))
      .resolves.toEqual({ myRole: 'STAFF', vendors: [{ id: 'v1' }] });
  });
});

describe('[MOB-038] the shell is told which of the four states it is in', () => {
  const ready = { myRole: 'MANAGER', vendors: [{ id: 'v1' }] };

  it('a completed read with a store is ready', () => {
    expect(classifyVendorProfile({ isLoading: false, error: null, owner: ready, fetched: true }))
      .toEqual({ state: 'ready', myRole: 'MANAGER' });
  });

  it('a verified 404 is absent — this is what the setup wizard is FOR', () => {
    expect(classifyVendorProfile({ isLoading: false, error: null, owner: null, fetched: true }))
      .toMatchObject({ state: 'absent' });
  });

  it('a well-formed owner with no stores is absent too — they really have none', () => {
    expect(classifyVendorProfile({ isLoading: false, error: null, owner: { myRole: 'OWNER', vendors: [] }, fetched: true }))
      .toMatchObject({ state: 'absent' });
  });

  it('EVERY failure is an error state, never absence — the defect, one case at a time', () => {
    for (const [status, failure] of [[401, 'unauthorized'], [403, 'forbidden'], [500, 'unreachable'], [503, 'unreachable']] as const) {
      expect(classifyVendorProfile({ isLoading: false, error: err(status), owner: null, fetched: true }))
        .toEqual({ state: 'error', failure, myRole: undefined });
    }
    // an offline device has no status at all, and is still not "no business"
    expect(classifyVendorProfile({ isLoading: false, error: new Error('Network Error'), owner: null, fetched: true }))
      .toMatchObject({ state: 'error', failure: 'unreachable' });
  });

  it('a payload that is not a profile is MALFORMED, not absence — a schema change is an outage, not a closed business', () => {
    for (const owner of ['a string' as unknown as null, [] as unknown as null]) {
      expect(classifyVendorProfile({ isLoading: false, error: null, owner, fetched: true }))
        .toMatchObject({ state: 'error', failure: 'malformed' });
    }
  });

  it('a read that has not finished is loading, not absent', () => {
    expect(classifyVendorProfile({ isLoading: true, error: null, owner: null, fetched: false })).toMatchObject({ state: 'loading' });
    expect(classifyVendorProfile({ isLoading: false, error: null, owner: null, fetched: false })).toMatchObject({ state: 'loading' });
  });

  it('an error outranks everything — a stale cached owner never renders as ready during an outage', () => {
    expect(classifyVendorProfile({ isLoading: false, error: err(500), owner: ready, fetched: true }))
      .toMatchObject({ state: 'error', myRole: undefined });
  });
});

describe('[MOB-038] an unknown role is unknown, not the most privileged one', () => {
  it('only the three roles the server names are roles', () => {
    expect(memberRoleOf('OWNER')).toBe('OWNER');
    expect(memberRoleOf('MANAGER')).toBe('MANAGER');
    expect(memberRoleOf('STAFF')).toBe('STAFF');
    for (const value of [undefined, null, '', 'owner', 'ADMIN', 42, {}]) {
      expect(memberRoleOf(value), String(value)).toBeUndefined();
    }
  });

  it('an outage grants NO role — it used to grant OWNER', () => {
    expect(classifyVendorProfile({ isLoading: false, error: err(500), owner: null, fetched: true }).myRole).toBeUndefined();
    expect(classifyVendorProfile({ isLoading: true, error: null, owner: null, fetched: false }).myRole).toBeUndefined();
    expect(classifyVendorProfile({ isLoading: false, error: null, owner: { vendors: [{ id: 'v' }] }, fetched: true }).myRole).toBeUndefined();
  });

  it('failureOf names what happened, so the screen can say something true', () => {
    expect(failureOf(err(401))).toBe('unauthorized');
    expect(failureOf(err(403))).toBe('forbidden');
    expect(failureOf(err(500))).toBe('unreachable');
    expect(failureOf(new Error('offline'))).toBe('unreachable');
  });
});

describe('[MOB-038] a blocked subscription blocks, mirrored or not', () => {
  it('a SUSPENDED or CHURNED subscription blocks even when the store row says ACTIVE — the defect', () => {
    expect(billingBlocked({ status: 'ACTIVE', subscription: { status: 'SUSPENDED' } })).toBe(true);
    expect(billingBlocked({ status: 'ACTIVE', subscription: { status: 'CHURNED' } })).toBe(true);
  });

  it('a store suspended BY billing is blocked, whatever its subscription row says', () => {
    expect(billingBlocked({ status: 'SUSPENDED', suspensionSource: 'BILLING', subscription: { status: 'ACTIVE' } })).toBe(true);
  });

  it('a healthy store is not blocked, and neither is a missing one', () => {
    expect(billingBlocked({ status: 'ACTIVE', subscription: { status: 'ACTIVE' } })).toBe(false);
    expect(billingBlocked({ status: 'ACTIVE', subscription: null })).toBe(false);
    expect(billingBlocked(null)).toBe(false);
    expect(billingBlocked(undefined)).toBe(false);
  });

  it('a store suspended for MODERATION is not a billing problem — the reason shown must be the real one', () => {
    // billingBlocked says the subscription is fine; the caller keeps the
    // moderation reason rather than telling them to pay a bill they do not owe
    expect(billingBlocked({ status: 'SUSPENDED', suspensionSource: 'MODERATION', subscription: { status: 'ACTIVE' } })).toBe(false);
  });
});
