import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { SosService } from '../modules/safety/sos.service';
import { backfillSosEscalations, drainSosEscalations, scanSosEscalations, sosEscalationWorkerKilled, ACTIVE_WITHOUT_PAGE_SECONDS } from '../modules/safety/sos-escalation';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';

// ---------------------------------------------------------------------------
// [S-01] SOS becomes ACTIVE before durable fan-out ownership exists.
//
// The register's red test: inject a process-like failure immediately after
// the ACTIVE commit, restart the worker, and require every required delivery
// exactly once with durable attempts. Around it: two workers deliver once;
// the grace, sweep and re-page paths stage the same way; acknowledgement
// never deletes pending evidence work; a closed alert's pages are skipped
// but its evidence still lands; a failed delivery retries with backoff; the
// watchdog names an ACTIVE alert whose ops page is still undelivered; the
// backfill stages a live alert that has no rows.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) } as unknown as Server;
let sos: SosService;
const userIds: string[] = []; const alertIds: string[] = [];
let seq = 0;
const phone = () => `+${592_708_000_000 + Math.floor(Math.random() * 60_000_000) + (seq += 1)}`;

async function actorWithContact() {
  const user = await prisma.user.create({ data: { phone: phone(), firstName: 'Ana', lastName: 'S', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/a.jpg' } });
  userIds.push(user.id);
  const contactPhone = phone();
  await prisma.emergencyContact.create({ data: { userId: user.id, name: 'Mom', phoneE164: contactPhone, priority: 1, verifiedAt: new Date() } });
  return { user, contactPhone };
}
const rowsOf = (id: string) => prisma.sosEscalation.findMany({ where: { sosAlertId: id }, orderBy: [{ channel: 'asc' }, { targetKey: 'asc' }] });
const opsPages = (id: string) => prisma.notification.count({ where: { data: { path: ['sosAlertId'], equals: id }, title: { contains: 'SOS ACTIVE' } } });
const smsTo = (p: string) => devChannelLog.filter((e) => e.channel === 'sms' && (e as { to?: string }).to === p).length;
const track = <T extends { id: string }>(a: T) => { alertIds.push(a.id); return a; };

beforeAll(async () => { await prisma.$connect(); sos = new SosService(prisma, io); delete process.env['SOS_ESCALATION_WORKER_KILL']; });
beforeEach(() => { resetDevChannelLog(); sos.observer = {}; });
afterAll(async () => {
  await prisma.evidenceBundle.deleteMany({ where: { sosAlertId: { in: alertIds } } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { data: { path: ['sosAlertId'], string_contains: '' }, title: { contains: 'SOS' } } }).catch(() => {});
  await prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } });
  await prisma.emergencyContact.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('the register’s red test: the process dies right after the ACTIVE commit', () => {
  it('leaves rows, not silence; a worker restart delivers every required channel exactly once, with durable attempts; a second run delivers nothing more', async () => {
    const { user, contactPhone } = await actorWithContact();
    sos.observer = { afterActive: async () => { throw new Error('process died'); } };
    await expect(sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', immediate: true, lat: 6.8, lng: -58.15 })).rejects.toThrow('process died');
    const alert = track(await prisma.sosAlert.findFirstOrThrow({ where: { actorUserId: user.id } }));
    expect(alert.status).toBe('ACTIVE');
    const staged = await rowsOf(alert.id);
    expect(staged.map((r) => `${r.channel}:${r.status}`).sort()).toEqual(['CONTACT_SMS:PENDING', 'EVIDENCE:PENDING', 'OPS_PAGE:PENDING', 'WAR_ROOM:PENDING']);
    expect(await opsPages(alert.id)).toBe(0);
    expect(smsTo(contactPhone)).toBe(0);
    expect(await prisma.evidenceBundle.findUnique({ where: { sosAlertId: alert.id } })).toBeNull();
    // the worker restarts
    sos.observer = {};
    const first = await drainSosEscalations(prisma, io, { alertIds: [alert.id] });
    expect(first).toMatchObject({ delivered: 4, failed: 0 });
    const done = await rowsOf(alert.id);
    expect(done.every((r) => r.status === 'SENT' && r.attempts === 1 && r.deliveredAt !== null)).toBe(true);
    const paged = await opsPages(alert.id);
    expect(paged).toBeGreaterThanOrEqual(1);
    expect((done.find((r) => r.channel === 'OPS_PAGE')!.receipt as { opsPaged: number }).opsPaged).toBe(paged);
    expect(smsTo(contactPhone)).toBe(1);
    expect(await prisma.evidenceBundle.findUnique({ where: { sosAlertId: alert.id } })).not.toBeNull();
    const receipts = (await prisma.sosAlert.findUniqueOrThrow({ where: { id: alert.id } })).deliveryReceipts as Record<string, unknown>;
    expect(receipts).toMatchObject({ opsPaged: paged, socketListeners: 0 });
    expect(receipts['contacts']).toEqual([{ id: expect.any(String), ok: true }]);
    // exactly once
    const second = await drainSosEscalations(prisma, io, { alertIds: [alert.id] });
    expect(second.delivered).toBe(0);
    expect(await opsPages(alert.id)).toBe(paged);
    expect(smsTo(contactPhone)).toBe(1);
  });
  it('two workers draining at once deliver each row once', async () => {
    const { user, contactPhone } = await actorWithContact();
    sos.observer = { afterActive: async () => { throw new Error('process died'); } };
    await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', immediate: true }).catch(() => {});
    const alert = track(await prisma.sosAlert.findFirstOrThrow({ where: { actorUserId: user.id } }));
    sos.observer = {};
    const slow = { beforeDeliver: async () => { await new Promise((r) => setTimeout(r, 150)); } };
    const [a, b] = await Promise.all([drainSosEscalations(prisma, io, { alertIds: [alert.id], observer: slow }), drainSosEscalations(prisma, io, { alertIds: [alert.id] })]);
    expect(a.delivered + b.delivered).toBe(4);
    expect(smsTo(contactPhone)).toBe(1);
    expect((await rowsOf(alert.id)).every((r) => r.attempts === 1)).toBe(true);
  });
});

describe('every ACTIVE commit stages the same way', () => {
  it('the owner’s confirm after grace: one transaction, then delivery; a death after the commit is recovered by the worker', async () => {
    const { user, contactPhone } = await actorWithContact();
    const pending = track(await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', lat: 6.8, lng: -58.15 }));
    expect(pending.status).toBe('TRIGGER_PENDING');
    expect(await rowsOf(pending.id)).toHaveLength(0);
    sos.observer = { afterActive: async () => { throw new Error('process died'); } };
    await expect(sos.confirm(pending.id)).rejects.toThrow('process died');
    expect((await prisma.sosAlert.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('ACTIVE');
    expect((await rowsOf(pending.id)).filter((r) => r.status === 'PENDING')).toHaveLength(4);
    sos.observer = {};
    await drainSosEscalations(prisma, io, { alertIds: [pending.id] });
    expect(smsTo(contactPhone)).toBe(1);
    expect(await opsPages(pending.id)).toBeGreaterThanOrEqual(1);
  });
  it('the grace sweep promotes and delivers through the same rows', async () => {
    const { user, contactPhone } = await actorWithContact();
    const pending = track(await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER' }));
    await prisma.sosAlert.update({ where: { id: pending.id }, data: { graceEndsAt: new Date(Date.now() - 1000) } });
    const promoted = await sos.promoteExpiredGrace(new Date());
    expect(promoted).toContain(pending.id);
    expect((await rowsOf(pending.id)).filter((r) => r.status === 'SENT')).toHaveLength(4);
    expect(smsTo(contactPhone)).toBe(1);
  });
  it('a retrigger with a new position re-pages through fresh rows — the first page is never re-sent', async () => {
    const { user } = await actorWithContact();
    const alert = track(await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', immediate: true, lat: 6.80, lng: -58.15 }));
    const firstPages = await opsPages(alert.id);
    await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', immediate: true, lat: 6.81, lng: -58.16 });
    const rows = await rowsOf(alert.id);
    expect(rows.map((r) => r.targetKey).sort()).toEqual(expect.arrayContaining(['ops', 'ops:repage:1', 'war-room', 'war-room:repage:1']));
    expect(rows.filter((r) => r.channel === 'OPS_PAGE').every((r) => r.status === 'SENT' && r.attempts === 1)).toBe(true);
    expect(await opsPages(alert.id)).toBe(firstPages * 2);
    expect(rows.filter((r) => r.channel === 'EVIDENCE')).toHaveLength(1);
    expect(((await prisma.sosAlert.findUniqueOrThrow({ where: { id: alert.id } })).deliveryReceipts as Record<string, unknown>)['repages']).toBe(1);
  });
});

describe('acknowledgement, closure, retry, watchdog, backfill', () => {
  it('acknowledgement never deletes pending evidence work; a closed alert skips its pages but its evidence still lands', async () => {
    const { user } = await actorWithContact();
    sos.observer = { afterActive: async () => { throw new Error('process died'); } };
    await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', immediate: true }).catch(() => {});
    const alert = track(await prisma.sosAlert.findFirstOrThrow({ where: { actorUserId: user.id } }));
    sos.observer = {};
    await sos.ack(alert.id, 'ops-1');
    expect((await rowsOf(alert.id)).find((r) => r.channel === 'EVIDENCE')!.status).toBe('PENDING');
    await sos.resolve(alert.id, 'ops-1', 'FALSE_ALARM');
    const drained = await drainSosEscalations(prisma, io, { alertIds: [alert.id] });
    const rows = await rowsOf(alert.id);
    expect(rows.find((r) => r.channel === 'EVIDENCE')!.status).toBe('SENT');
    expect(await prisma.evidenceBundle.findUnique({ where: { sosAlertId: alert.id } })).not.toBeNull();
    expect(rows.filter((r) => r.channel !== 'EVIDENCE').every((r) => r.status === 'SKIPPED')).toBe(true);
    expect(drained.skipped).toBe(3);
    expect(await opsPages(alert.id)).toBe(0);
  });
  it('a failed delivery keeps its row with the error and attempts, backs off, and is retried to exactly one send', async () => {
    const { user, contactPhone } = await actorWithContact();
    sos.observer = { afterActive: async () => { throw new Error('process died'); } };
    await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', immediate: true }).catch(() => {});
    const alert = track(await prisma.sosAlert.findFirstOrThrow({ where: { actorUserId: user.id } }));
    sos.observer = {};
    let blips = 0;
    const flaky = { beforeDeliver: async (row: { channel: string }) => { if (row.channel === 'CONTACT_SMS' && blips === 0) { blips += 1; throw new Error('sms gateway blip'); } } };
    const first = await drainSosEscalations(prisma, io, { alertIds: [alert.id], observer: flaky });
    expect(first).toMatchObject({ delivered: 3, failed: 1 });
    const sms = (await rowsOf(alert.id)).find((r) => r.channel === 'CONTACT_SMS')!;
    expect(sms).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(sms.lastError).toContain('sms gateway blip');
    // the backoff is set on the database clock: read it back against that clock
    const [due] = await prisma.$queryRaw<Array<{ backoff: number }>>`select extract(epoch from ("availableAt" - clock_timestamp()))::float as backoff from "sos_escalations" where "id" = ${sms.id}`;
    expect(due?.backoff).toBeGreaterThan(1);
    expect(smsTo(contactPhone)).toBe(0);
    await prisma.sosEscalation.update({ where: { id: sms.id }, data: { availableAt: new Date(0) } });
    const second = await drainSosEscalations(prisma, io, { alertIds: [alert.id], observer: flaky });
    expect(second.delivered).toBe(1);
    expect((await rowsOf(alert.id)).find((r) => r.channel === 'CONTACT_SMS')).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
    expect(smsTo(contactPhone)).toBe(1);
  });
  it('the watchdog names an ACTIVE alert whose ops page is still undelivered past the threshold, and forgets it once delivered', async () => {
    const { user } = await actorWithContact();
    sos.observer = { afterActive: async () => { throw new Error('process died'); } };
    await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', immediate: true }).catch(() => {});
    const alert = track(await prisma.sosAlert.findFirstOrThrow({ where: { actorUserId: user.id } }));
    sos.observer = {};
    await prisma.sosAlert.update({ where: { id: alert.id }, data: { triggeredAt: new Date(Date.now() - (ACTIVE_WITHOUT_PAGE_SECONDS + 60) * 1000) } });
    const scan = await scanSosEscalations(prisma);
    const stuck = scan.activeWithoutPage.find((s) => s.sosAlertId === alert.id);
    expect(stuck).toBeDefined();
    expect(stuck!.ageSeconds).toBeGreaterThanOrEqual(ACTIVE_WITHOUT_PAGE_SECONDS);
    expect(scan.pending).toBeGreaterThanOrEqual(4);
    await drainSosEscalations(prisma, io, { alertIds: [alert.id] });
    expect((await scanSosEscalations(prisma)).activeWithoutPage.some((s) => s.sosAlertId === alert.id)).toBe(false);
  });
  it('a live alert with no rows (before the outbox) is found and its policy staged, then delivered', async () => {
    const { user, contactPhone } = await actorWithContact();
    const legacy = track(await prisma.sosAlert.create({ data: { actorUserId: user.id, actorRole: 'CUSTOMER', status: 'ACTIVE', triggerSource: 'BUTTON' } }));
    expect((await scanSosEscalations(prisma)).liveWithoutRows).toContain(legacy.id);
    const back = await backfillSosEscalations(prisma);
    expect(back.backfilled).toContain(legacy.id);
    expect(await rowsOf(legacy.id)).toHaveLength(4);
    await drainSosEscalations(prisma, io, { alertIds: [legacy.id] });
    expect(smsTo(contactPhone)).toBe(1);
    expect((await scanSosEscalations(prisma)).liveWithoutRows).not.toContain(legacy.id);
  });
  it('the worker kill switch is read from the environment', () => {
    expect(sosEscalationWorkerKilled({})).toBe(false);
    expect(sosEscalationWorkerKilled({ SOS_ESCALATION_WORKER_KILL: '1' })).toBe(true);
  });
});
