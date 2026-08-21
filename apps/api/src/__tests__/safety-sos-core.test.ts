import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { SosService, SOS_TRANSITIONS } from '../modules/safety/sos.service';

// SOS engine — the life-safety state machine, proven with server-side evidence
// (DB rows + state), per spec §14 A/B/C. Driven through the service directly
// (the route layer's auth is covered by authz-matrix.test.ts). io is stubbed;
// notifyAdmins is best-effort with no admins seeded, so fan-out never throws.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
let sos: SosService;
const ids: string[] = [];
const track = <T extends { id: string }>(a: T) => { ids.push(a.id); return a; };

beforeAll(async () => {
  process.env['SOS_CANCEL_GRACE_SECONDS'] = '3';
  await prisma.$connect();
  sos = new SosService(prisma, io);
});
afterAll(async () => {
  await prisma.sosAlert.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

const u = () => 'u-' + nanoid(8);

describe('SOS state machine [safety M2]', () => {
  it('the transition table has no path OUT of a terminal state', () => {
    expect(SOS_TRANSITIONS.RESOLVED).toEqual([]);
    expect(SOS_TRANSITIONS.CANCELLED).toEqual([]);
    expect(SOS_TRANSITIONS.TRIGGER_PENDING).toContain('ACTIVE');
    expect(SOS_TRANSITIONS.TRIGGER_PENDING).toContain('CANCELLED');
  });

  it('A: a button trigger is born TRIGGER_PENDING with a server-owned grace deadline', async () => {
    const a = track(await sos.create({ actorUserId: u(), actorRole: 'CUSTOMER', orderType: 'TAXI', triggerSource: 'BUTTON', lat: 6.8, lng: -58.15 }));
    expect(a.status).toBe('TRIGGER_PENDING');
    expect(a.graceEndsAt).toBeInstanceOf(Date);
    expect(a.graceEndsAt!.getTime()).toBeGreaterThan(a.triggeredAt.getTime());
  });

  it('[F-026-15] the ACTIVE fan-out pages ONLY the alert tenant\'s admins', async () => {
    // The grace-expiry backstop runs in a background worker with NO request
    // tenant context, and notifyAdmins without a tenantId deliberately pages
    // every active admin. An alert in one tenant was therefore paging every
    // tenant's admins with its role, order id and coordinates.
    const tenantB = `sos-t-${nanoid(6)}`;
    await prisma.tenant.create({ data: { id: tenantB, name: 'SOS tenant B', slug: tenantB, isActive: true } });
    const adminB = await prisma.user.create({
      data: {
        phone: `+59277${Math.floor(Math.random() * 900000) + 100000}`,
        firstName: 'Other', lastName: 'Admin',
        roles: ['ADMIN'] as never[], activeRole: 'ADMIN' as never,
        isPhoneVerified: true, status: 'ACTIVE', tenantId: tenantB,
      },
    });
    try {
      // An alert in the DEFAULT tenant, promoted the way the worker does it.
      const a = track(await sos.create({ actorUserId: u(), actorRole: 'CUSTOMER', triggerSource: 'BUTTON', lat: 6.8, lng: -58.15 }));
      await prisma.sosAlert.update({ where: { id: a.id }, data: { graceEndsAt: new Date(Date.now() - 1000) } });
      await sos.promoteExpiredGrace();
      const leaked = await prisma.notification.count({
        where: { userId: adminB.id, data: { path: ['sosAlertId'], equals: a.id } as never },
      });
      expect(leaked, 'a tenant-B admin was paged about a tenant-A SOS').toBe(0);
    } finally {
      await prisma.notification.deleteMany({ where: { userId: adminB.id } });
      await prisma.user.delete({ where: { id: adminB.id } });
      await prisma.tenant.delete({ where: { id: tenantB } });
    }
  });

  it('[F-027-18] an alert raised with NO request context is filed to the ACTOR\'s tenant, and pages THEM', async () => {
    // The bug this replaces: nothing set tenantId here, so it came from the
    // request-scoped Prisma extension — which stamps nothing in a background
    // sweep. The guardian check-in-timeout ladder and the grace-expiry
    // backstop both run there, so those alerts silently took the schema
    // default, `swift-default`. Since F-026-15 the ops page follows
    // alert.tenantId, so a tenant-B customer's auto-escalated alert paged
    // swift-default's admins and NOBODY IN TENANT B WAS EVER TOLD. The
    // server-guessed emergency — raised precisely because the person stopped
    // answering — went to the wrong room.
    const tenantB = `sos-t-${nanoid(6)}`;
    await prisma.tenant.create({ data: { id: tenantB, name: 'SOS tenant B', slug: tenantB, isActive: true } });
    const victimB = await prisma.user.create({
      data: {
        phone: `+59278${Math.floor(Math.random() * 900000) + 100000}`,
        firstName: 'Victim', lastName: 'B',
        roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
        isPhoneVerified: true, status: 'ACTIVE', tenantId: tenantB,
      },
    });
    const adminB = await prisma.user.create({
      data: {
        phone: `+59279${Math.floor(Math.random() * 900000) + 100000}`,
        firstName: 'Responder', lastName: 'B',
        roles: ['ADMIN'] as never[], activeRole: 'ADMIN' as never,
        isPhoneVerified: true, status: 'ACTIVE', tenantId: tenantB,
      },
    });
    try {
      // No request context — exactly how the guardian sweep raises one.
      const a = track(await sos.create({
        actorUserId: victimB.id, actorRole: 'CUSTOMER',
        triggerSource: 'CHECKIN_TIMEOUT', immediate: true,
        clientIdempotencyKey: `guardian:${nanoid(10)}`,
      }));
      expect(a.tenantId, 'the alert was filed under the wrong tenant').toBe(tenantB);
      const pagedB = await prisma.notification.count({
        where: { userId: adminB.id, data: { path: ['sosAlertId'], equals: a.id } as never },
      });
      expect(pagedB, "tenant B's own responder was not paged about their own customer's SOS").toBeGreaterThan(0);
    } finally {
      await prisma.notification.deleteMany({ where: { userId: { in: [adminB.id, victimB.id] } } });
      await prisma.sosAlert.deleteMany({ where: { actorUserId: victimB.id } });
      await prisma.user.deleteMany({ where: { id: { in: [adminB.id, victimB.id] } } });
      await prisma.tenant.delete({ where: { id: tenantB } });
    }
  });

  it('[F-026-12] the grace deadline closes on the CLOCK, not on the sweep tick', async () => {
    // promoteExpiredGrace is what flips TRIGGER_PENDING -> ACTIVE, so between
    // graceEndsAt passing and the next sweep run the row is still
    // TRIGGER_PENDING. Cancel must refuse anyway: an alert whose window has
    // elapsed is already escalating, whatever the sweep is doing.
    const a = track(await sos.create({ actorUserId: u(), actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    expect(a.status).toBe('TRIGGER_PENDING');
    await prisma.sosAlert.update({ where: { id: a.id }, data: { graceEndsAt: new Date(Date.now() - 1000) } });
    // Deliberately do NOT run the sweep — this is the gap the old check left.
    await expect(sos.cancel(a.id)).rejects.toThrow(/no longer be cancelled/);
    const after = await prisma.sosAlert.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.status).toBe('TRIGGER_PENDING');
    expect(after.cancelledAt).toBeNull();
  });

  it('cancel still works INSIDE the window (the fix must not close the door early)', async () => {
    const a = track(await sos.create({ actorUserId: u(), actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    const c = await sos.cancel(a.id);
    expect(c.status).toBe('CANCELLED');
  });

  it('an ops-raised alert skips grace and is ACTIVE immediately', async () => {
    const a = track(await sos.create({ actorUserId: u(), actorRole: 'ADMIN', triggerSource: 'OPS_MANUAL' }));
    expect(a.status).toBe('ACTIVE');
    expect(a.graceEndsAt).toBeNull();
  });

  it('immediate:true (the in-ride button) skips grace → ACTIVE, even for a BUTTON source', async () => {
    const a = track(await sos.create({ actorUserId: u(), actorRole: 'CUSTOMER', orderType: 'TAXI', triggerSource: 'BUTTON', immediate: true }));
    expect(a.status).toBe('ACTIVE'); // no slide-to-cancel window — the caller owns the UX
    expect(a.graceEndsAt).toBeNull();
    // fan-out ran at creation → receipts are persisted (create() returns the
    // pre-fan-out row, so re-read to see them).
    const fresh = await prisma.sosAlert.findUniqueOrThrow({ where: { id: a.id } });
    expect(fresh.deliveryReceipts).toBeTruthy();
  });

  it('confirm promotes TRIGGER_PENDING → ACTIVE and records fan-out receipts', async () => {
    const a = track(await sos.create({ actorUserId: u(), actorRole: 'MOVER', triggerSource: 'BUTTON' }));
    const active = await sos.confirm(a.id);
    expect(active.status).toBe('ACTIVE');
    expect(active.graceEndsAt).toBeNull();
    expect(active.deliveryReceipts).toBeTruthy(); // fan-out ran, receipts stored
  });

  it('B: slide-to-cancel works ONLY during grace; after ACTIVE it is impossible', async () => {
    const a = track(await sos.create({ actorUserId: u(), actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    const cancelled = await sos.cancel(a.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);

    const b = track(await sos.create({ actorUserId: u(), actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    await sos.confirm(b.id); // now ACTIVE
    await expect(sos.cancel(b.id)).rejects.toMatchObject({ statusCode: 409, code: 'SOS_NOT_CANCELLABLE' });
  });

  it('C: "I\'m safe" flags but NEVER resolves — only ops close it (coercion doctrine)', async () => {
    const a = track(await sos.create({ actorUserId: u(), actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    await sos.confirm(a.id);
    const safe = await sos.markSafe(a.id);
    expect(safe.userSafeFlaggedAt).toBeInstanceOf(Date);
    expect(safe.status).toBe('ACTIVE'); // still open — a human must resolve
  });

  it('ops ack then resolve (with a code) closes the alert; a code is required', async () => {
    const a = track(await sos.create({ actorUserId: u(), actorRole: 'MOVER', triggerSource: 'OPS_MANUAL' })); // ACTIVE
    const acked = await sos.ack(a.id, 'ops-1');
    expect(acked.status).toBe('ACKNOWLEDGED');
    expect(acked.acknowledgedBy).toBe('ops-1');
    const resolved = await sos.resolve(a.id, 'ops-1', 'SAFE_CONFIRMED', 'called back, safe');
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolutionCode).toBe('SAFE_CONFIRMED');
  });

  it('rejects illegal transitions (resolve a CANCELLED, ack a RESOLVED)', async () => {
    const c = track(await sos.create({ actorUserId: u(), actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    await sos.cancel(c.id);
    await expect(sos.resolve(c.id, 'ops-1', 'FALSE_ALARM')).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_SOS_TRANSITION' });

    const r = track(await sos.create({ actorUserId: u(), actorRole: 'MOVER', triggerSource: 'OPS_MANUAL' }));
    await sos.resolve(r.id, 'ops-1', 'SAFE_CONFIRMED');
    await expect(sos.ack(r.id, 'ops-1')).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_SOS_TRANSITION' });
  });

  it('D: a retried offline trigger (same idempotency key) yields EXACTLY ONE alert', async () => {
    const key = 'idem-' + nanoid(12);
    const first = track(await sos.create({ actorUserId: 'off-1', actorRole: 'CUSTOMER', triggerSource: 'BUTTON', clientIdempotencyKey: key }));
    const replay = await sos.create({ actorUserId: 'off-1', actorRole: 'CUSTOMER', triggerSource: 'BUTTON', clientIdempotencyKey: key });
    expect(replay.id).toBe(first.id); // the original, not a second alert
    const count = await prisma.sosAlert.count({ where: { clientIdempotencyKey: key } });
    expect(count).toBe(1);
  });

  it('[F-026-17] D2: the same key from ANOTHER person raises THEIR OWN alert, never a handback of mine', async () => {
    // The defect: the lookup was by key alone, so whoever asked second was
    // told "you already have an alert" and pointed at a stranger's — while
    // nobody was ever paged for them. Reusing or guessing a key must never
    // decide whether someone else's emergency exists.
    const key = 'idem-shared-' + nanoid(12);
    const mine = track(await sos.create({ actorUserId: 'off-a', actorRole: 'CUSTOMER', triggerSource: 'BUTTON', clientIdempotencyKey: key }));
    const theirs = track(await sos.create({ actorUserId: 'off-b', actorRole: 'CUSTOMER', triggerSource: 'BUTTON', clientIdempotencyKey: key }));
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.actorUserId).toBe('off-b');
    expect(await prisma.sosAlert.count({ where: { clientIdempotencyKey: key } })).toBe(2);
  });

  it('[F-026-17] D3: a key claimed FIRST by a stranger cannot suppress the rightful owner\'s escalation', async () => {
    // The server derives keys for the escalations it raises on someone's
    // behalf ("guardian:<sessionId>"). Before the fix, anyone who wrote that
    // string first owned it, and the real escalation silently returned the
    // squatter's row instead of paging for the person in danger.
    const derived = `guardian:${nanoid(12)}`;
    const squatter = track(await sos.create({ actorUserId: 'off-squat', actorRole: 'CUSTOMER', triggerSource: 'BUTTON', clientIdempotencyKey: derived }));
    const victim = track(await sos.create({ actorUserId: 'off-victim', actorRole: 'CUSTOMER', triggerSource: 'CHECKIN_TIMEOUT', immediate: true, clientIdempotencyKey: derived }));
    expect(victim.id).not.toBe(squatter.id);
    expect(victim.actorUserId).toBe('off-victim');
    expect(victim.status).toBe('ACTIVE'); // the escalation actually happened
  });

  it('[F-026-17] D4: two CONCURRENT retries from one device settle on one alert — the loser gets the winner, not a 500', async () => {
    // read-then-create is not atomic. Both callers can miss the read; one
    // loses on the unique index. A person mid-emergency must not receive an
    // error because their phone retried a request that already succeeded.
    const key = 'idem-race-' + nanoid(12);
    const settled = await Promise.all([
      sos.create({ actorUserId: 'off-race', actorRole: 'CUSTOMER', triggerSource: 'BUTTON', clientIdempotencyKey: key }),
      sos.create({ actorUserId: 'off-race', actorRole: 'CUSTOMER', triggerSource: 'BUTTON', clientIdempotencyKey: key }),
      sos.create({ actorUserId: 'off-race', actorRole: 'CUSTOMER', triggerSource: 'BUTTON', clientIdempotencyKey: key }),
    ]);
    settled.forEach(track);
    expect(new Set(settled.map((a) => a.id)).size).toBe(1); // all three name the SAME alert
    expect(await prisma.sosAlert.count({ where: { clientIdempotencyKey: key } })).toBe(1);
  });

  it('[F-027-17] D5: tapping again while an alert is LIVE collapses onto it — ops gets rising urgency, not duplicates', async () => {
    // The life-safety routes are rate-limit exempt, so the alert mint was the
    // unbounded surface: one account could bury the ops war room and lose real
    // emergencies in the noise. The bound is on ALERTS, not requests.
    const who = u();
    const first = track(await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    for (let i = 0; i < 5; i++) {
      const again = await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON' });
      expect(again.id).toBe(first.id);
    }
    expect(await prisma.sosAlert.count({ where: { actorUserId: who } })).toBe(1);
    const after = await prisma.sosAlert.findUniqueOrThrow({ where: { id: first.id } });
    expect(after.retriggerCount).toBe(5);
    expect(after.lastRetriggerAt).toBeInstanceOf(Date);
  });

  it('[F-027-17] D6: under a SIMULTANEOUS burst the collapse reduces but does NOT bound — nobody is refused, and this is the residual', async () => {
    // Honest statement of what the mechanism actually guarantees.
    //
    // The collapse is a read-then-write, so callers that all read before any
    // of them commits will each mint. That is fine for the case it exists to
    // serve — a frightened person tapping repeatedly, hundreds of milliseconds
    // apart, which D5 proves collapses to exactly one. It is NOT a defence
    // against deliberate flooding: measured here, 40 simultaneous triggers
    // still produced tens of alerts.
    //
    // It is deliberately not a partial unique index yet. That would give a
    // hard bound, but it puts a rule that can REFUSE an insert on the path
    // between a person and help, and it cannot be expressed in the Prisma
    // schema — so a routine `db push` would silently drop it. Choosing that
    // mechanism belongs in the ops-war-room grouping work (W1), not in a
    // same-day patch on a life-safety path.
    //
    // What must hold unconditionally is the part below: every caller gets a
    // real alert back. Nobody is ever refused.
    const who = u();
    const N = 40;
    const settled = await Promise.all(Array.from({ length: N }, () =>
      sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON' })));
    settled.forEach(track);
    expect(settled).toHaveLength(N);
    expect(settled.every((a) => a.id && a.status)).toBe(true);
    const minted = await prisma.sosAlert.count({ where: { actorUserId: who } });
    expect(minted).toBeGreaterThan(0);
    expect(minted).toBeLessThanOrEqual(N); // the residual: NOT yet a real bound
  });

  it('[F-027-17] D7: the STRONGER trigger wins — an immediate re-trigger promotes a pending alert instead of waiting out its grace', async () => {
    // Collapsing must never leave someone counting down a window they have
    // already overridden by pressing the in-ride panic button.
    const who = u();
    const pending = track(await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    expect(pending.status).toBe('TRIGGER_PENDING');
    const escalated = await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', immediate: true });
    expect(escalated.id).toBe(pending.id);
    expect(escalated.status).toBe('ACTIVE');
    expect(escalated.graceEndsAt).toBeNull();
  });

  it('[F-027-17] D8: collapse never swallows a LATER emergency — a closed alert does not absorb the next one', async () => {
    const who = u();
    const first = track(await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'OPS_MANUAL' }));
    await sos.resolve(first.id, 'ops-1', 'SAFE_CONFIRMED');
    const later = track(await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    expect(later.id).not.toBe(first.id);
    expect(await prisma.sosAlert.count({ where: { actorUserId: who } })).toBe(2);
  });

  it('[F-027-17] D9: a different trip is a different emergency — collapse is scoped to the order', async () => {
    const who = u();
    const onFoot = track(await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    const onTrip = track(await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', orderId: `ord-${nanoid(8)}` }));
    expect(onTrip.id).not.toBe(onFoot.id);
  });

  it('E: the grace-expiry sweep promotes an overdue TRIGGER_PENDING → ACTIVE (app-kill-proof)', async () => {
    const a = track(await sos.create({ actorUserId: u(), actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    // Simulate grace elapsed (as if the app died during the countdown).
    await prisma.sosAlert.update({ where: { id: a.id }, data: { graceEndsAt: new Date(Date.now() - 1000) } });
    const promoted = await sos.promoteExpiredGrace(new Date());
    expect(promoted).toContain(a.id);
    const after = await prisma.sosAlert.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.status).toBe('ACTIVE');
  });
});
