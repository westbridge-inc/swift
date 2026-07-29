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

  it('an ops-raised alert skips grace and is ACTIVE immediately', async () => {
    const a = track(await sos.create({ actorUserId: u(), actorRole: 'ADMIN', triggerSource: 'OPS_MANUAL' }));
    expect(a.status).toBe('ACTIVE');
    expect(a.graceEndsAt).toBeNull();
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
