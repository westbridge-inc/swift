import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { RIDER_COUNTERPARTY_SELECT, liveLocationVisible, redactLiveLocation, riderCounterpartySelect } from '../utils/counterparty';

// ---------------------------------------------------------------------------
// [F-027-07] What one party to an order may see about the other.
//
// The customer, vendor and courier-sender surfaces reached their mover with
// `include: { rider: { include: { user: {...} } } }`. The nested `user` was
// carefully selected; the Rider row itself was not — `include` means EVERY
// column. So the person who ordered a parcel received the mover's KYC document
// keys, their safety-enforcement state (including a SHADOW restriction, which
// is the one thing that must never be visible), their float limits, and
// internal performance rates.
//
// This test is written against the Prisma DMMF rather than a hand-written
// list, so that ADDING A COLUMN TO RIDER cannot silently add it to a
// customer's response. A new sensitive field fails here until someone decides.
// ---------------------------------------------------------------------------

// Enum columns count too (vehicleType, riderType) — filtering to `scalar`
// alone silently dropped them and made the allow-list check report a real
// column as bogus.
const riderFields = (Prisma.dmmf.datamodel.models.find((m) => m.name === 'Rider')?.fields ?? [])
  .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
  .map((f) => f.name);

/** Columns that must never reach a counterparty. Named individually so the
 *  reason for each is on the record. */
const FORBIDDEN: Record<string, string> = {
  nationalIdUrl: 'KYC document',
  driverLicenseUrl: 'KYC document',
  vehicleInsuranceUrl: 'KYC document',
  safetySuspendedAt: 'safety enforcement state',
  safetyShadowRestrictedAt: 'a SHADOW restriction — disclosing it defeats the point',
  livenessLockedAt: 'identity-check state',
  lastLivenessPassAt: 'identity-check state',
  livenessPromptDeadlineAt: 'identity-check state',
  floatLimit: 'the mover’s cash position with Swift',
  committedFloat: 'the mover’s cash position with Swift',
  acceptanceRate: 'internal performance metric',
  completionRate: 'internal performance metric',
  documentsVerifiedBy: 'an internal admin’s id',
  locationSessionId: 'internal session handle',
};

/** [F-028-12] Every Rider column the schema will EVER grow must be classified
 *  somewhere. FORBIDDEN and the select partition only the columns someone
 *  already thought about; a NEWLY added sensitive field used to land in
 *  neither set and pass every test until somebody also remembered to extend
 *  FORBIDDEN — DMMF proves existence, not sensitivity. UNREMARKABLE is the
 *  third bucket: fields a human LOOKED AT and judged not worth exposing and
 *  not dangerous to name. The exhaustiveness test below turns "nobody
 *  decided" from a silent pass into a failure that demands the decision. */
const UNREMARKABLE: Record<string, string> = {
  userId: 'internal linkage — selected per-call-site where needed, never wholesale',
  vehicleYear: 'harmless but unused by any counterparty surface',
  isAvailable: 'dispatch input, not counterparty information',
  isOnline: 'dispatch input, not counterparty information',
  currentLat: 'live position — exposed ONLY via the gated RIDER_LIVE_LOCATION_SELECT',
  currentLng: 'live position — exposed ONLY via the gated RIDER_LIVE_LOCATION_SELECT',
  lastLocationUpdate: 'live position freshness — same gate as the coordinates',
  createdAt: 'row bookkeeping',
  updatedAt: 'row bookkeeping',
  riderType: 'fleet segmentation — a counterparty sees the vehicle, not the contract',
  documentsVerified: 'verification OUTCOME is implied by the mover being dispatched at all; the flag itself is internal',
  documentsVerifiedAt: 'internal verification bookkeeping',
  currentOrderId: 'another customer\u2019s order id — cross-customer linkage, never exposed',
  totalCourierJobs: 'internal volume metric; totalDeliveries is the exposed figure',
};

describe('[F-027-07] the counterparty view of a mover', () => {
  it('leaks none of the columns that must never reach the other party', () => {
    const selected = Object.keys(RIDER_COUNTERPARTY_SELECT);
    const leaked = selected.filter((f) => f in FORBIDDEN).map((f) => `${f} (${FORBIDDEN[f]})`);
    expect(leaked, `counterparty select exposes: ${leaked.join('; ')}`).toEqual([]);
  });

  it('every forbidden column actually exists on Rider — the guard cannot rot into a list of typos', () => {
    // If a column is renamed, this fails and someone re-decides, rather than
    // the guard silently passing because it is checking for nothing.
    const missing = Object.keys(FORBIDDEN).filter((f) => !riderFields.includes(f));
    expect(missing, `FORBIDDEN names columns that no longer exist: ${missing.join(', ')}`).toEqual([]);
  });

  it('is an ALLOW-LIST: every selected column is a real Rider column', () => {
    const bogus = Object.keys(RIDER_COUNTERPARTY_SELECT).filter((f) => !riderFields.includes(f));
    expect(bogus, `select names columns Rider does not have: ${bogus.join(', ')}`).toEqual([]);
  });

  it('[F-028-12] EVERY Rider column is classified — a new field fails until a human decides', () => {
    // The defect this pins: adding a sensitive column to Rider used to change
    // nothing here — it was not selected, not forbidden, and no test noticed.
    // Exhaustive three-way partition makes "unclassified" itself the failure.
    const selected = new Set(Object.keys(RIDER_COUNTERPARTY_SELECT));
    const classified = new Set([
      ...selected,
      ...Object.keys(FORBIDDEN),
      ...Object.keys(UNREMARKABLE),
    ]);
    const undecided = riderFields.filter((f) => !classified.has(f));
    expect(
      undecided,
      `new Rider column(s) with NO classification decision — add each to the select, FORBIDDEN, or UNREMARKABLE with a reason: ${undecided.join(', ')}`,
    ).toEqual([]);

    // The buckets must stay disjoint, or a field's classification is ambiguous.
    for (const f of Object.keys(FORBIDDEN)) {
      expect(selected.has(f), `${f} is both selected and FORBIDDEN`).toBe(false);
      expect(f in UNREMARKABLE, `${f} is both FORBIDDEN and UNREMARKABLE`).toBe(false);
    }
    for (const f of Object.keys(UNREMARKABLE)) {
      expect(selected.has(f), `${f} is both selected and UNREMARKABLE`).toBe(false);
    }

    // And UNREMARKABLE cannot rot into typos any more than FORBIDDEN can.
    const ghosts = Object.keys(UNREMARKABLE).filter((f) => !riderFields.includes(f));
    expect(ghosts, `UNREMARKABLE names columns that no longer exist: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('[F-028-20] the default user shape carries NO raw avatar key', () => {
    // Under the production private-storage contract `avatar` is a bare object
    // key; resolveAvatarUrl exists precisely so a key is never the fallback.
    // The shared select handed courier, vendor and dispatch surfaces a raw
    // key none of them resolve — avatar is opt-in now, and opting in is a
    // declaration that the caller runs the resolver on the way out.
    const base = riderCounterpartySelect({ withPhone: true }) as { user: { select: Record<string, unknown> } };
    expect('avatar' in base.user.select).toBe(false);
    const optIn = riderCounterpartySelect({ withPhone: false, withAvatar: true }) as { user: { select: Record<string, unknown> } };
    expect('avatar' in optIn.user.select).toBe(true);
  });

  it('still carries what a counterparty actually needs — the fix must not blind the customer', () => {
    // [F-028-11] currentLat/currentLng USED to be asserted here as "needed".
    // They are not: they are the mover's PROFILE position, unscoped to this
    // order, and keeping them in the default view is what made every
    // historical surface a tracking surface. Live position is opt-in and
    // status-gated now — see the F-028-11 block below.
    for (const needed of ['vehicleMake', 'vehicleModel', 'vehicleColor', 'licensePlate', 'vehiclePhotoUrl', 'averageRating']) {
      expect(Object.keys(RIDER_COUNTERPARTY_SELECT), needed).toContain(needed);
    }
  });

  it('withPhone gates the contact number — only surfaces where the parties actually meet', () => {
    const meeting = riderCounterpartySelect({ withPhone: true });
    const notMeeting = riderCounterpartySelect({ withPhone: false });
    expect(Object.keys(meeting.user.select)).toContain('phone');
    expect(Object.keys(notMeeting.user.select)).not.toContain('phone');
  });

  it('a NEW Rider column is not in the select by default — additions are opt-in', () => {
    // The property that makes this durable: the select is an allow-list, so
    // the set of exposed columns can only grow by someone editing it.
    const exposed = new Set(Object.keys(RIDER_COUNTERPARTY_SELECT));
    const unexposed = riderFields.filter((f) => !exposed.has(f));
    expect(unexposed.length, 'every Rider column is exposed — the allow-list is not narrowing anything').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// [F-028-11] Live position is not part of the counterparty view.
//
// Rider.currentLat/currentLng is the mover's PROFILE position — it keeps
// updating every ~10s whenever that person is online, on ANY later job. It is
// not scoped to the order being viewed. Including it by default meant every
// historical surface kept leaking it, and the worst was an unauthenticated
// `/courier/track/:token` link with no expiry: a recipient who kept the link
// from a parcel delivered months ago could watch that courier's day.
//
// Unlike the storage keys elsewhere in this class, these are the live
// production values themselves — nothing has to be signed or fetched to use
// them.
// ---------------------------------------------------------------------------
describe('[F-028-11] live mover position', () => {
  it('is NOT in the default counterparty view', () => {
    for (const f of ['currentLat', 'currentLng', 'lastLocationUpdate']) {
      expect(Object.keys(RIDER_COUNTERPARTY_SELECT), f).not.toContain(f);
    }
  });

  it('is opt-in, and only when the caller asks for it', () => {
    expect(Object.keys(riderCounterpartySelect({ withPhone: false }))).not.toContain('currentLat');
    expect(Object.keys(riderCounterpartySelect({ withPhone: false, withLiveLocation: true }))).toContain('currentLat');
  });

  it('is visible only while the handover is actually in flight', () => {
    for (const live of ['RIDER_EN_ROUTE_PICKUP', 'PICKED_UP', 'EN_ROUTE_DELIVERY', 'RIDE_IN_PROGRESS', 'DRIVER_ARRIVED']) {
      expect(liveLocationVisible(live), live).toBe(true);
    }
    for (const done of ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED', 'PENDING']) {
      expect(liveLocationVisible(done), done).toBe(false);
    }
    expect(liveLocationVisible(null)).toBe(false);
    expect(liveLocationVisible(undefined)).toBe(false);
  });

  it('an UNKNOWN status is not trackable — new statuses default to closed', () => {
    // The list is a positive allow-list of live states, so a status added to
    // the enum later cannot silently become a tracking window.
    expect(liveLocationVisible('SOME_FUTURE_STATUS')).toBe(false);
  });

  it('redacts the position on a settled order, and leaves a live one alone', () => {
    const at = new Date();
    const settled = redactLiveLocation({ status: 'DELIVERED', rider: { currentLat: 6.8, currentLng: -58.1, lastLocationUpdate: at, id: 'r1' } });
    expect(settled.rider).toMatchObject({ currentLat: null, currentLng: null, lastLocationUpdate: null, id: 'r1' });

    const inFlight = redactLiveLocation({ status: 'EN_ROUTE_DELIVERY', rider: { currentLat: 6.8, currentLng: -58.1, lastLocationUpdate: at } });
    expect(inFlight.rider).toMatchObject({ currentLat: 6.8, currentLng: -58.1 });
  });

  it('redacts a DRIVER the same way — the rule is about the person, not the field name', () => {
    const settled = redactLiveLocation({ status: 'COMPLETED', driver: { currentLat: 6.8, currentLng: -58.1 } });
    expect(settled.driver).toMatchObject({ currentLat: null, currentLng: null });
  });

  it('survives a party that is absent or null', () => {
    expect(() => redactLiveLocation({ status: 'DELIVERED' })).not.toThrow();
    expect(() => redactLiveLocation({ status: 'DELIVERED', rider: null })).not.toThrow();
  });
});
