import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PrismaClient, type SosEscalationChannel } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { SosService } from '../modules/safety/sos.service';
import { NotificationService } from '../modules/notification/notification.service';
import { drainSosEscalations, pageFailedSosEscalations, FAILURE_PAGE_LEASE_SECONDS } from '../modules/safety/sos-escalation';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';
import { log, setAppLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// [AUD-L4-016 · S1] A failed SOS emergency-contact text paged nobody.
//
// The worker retried a failed row for over an hour and the watchdog looked
// only at the ops page: a contact's text that failed — once, or for good —
// was a log line while the person believed their contact had been told.
//
// Asserted, on the real outbox and the real ops-alert path:
//  - ANY failed row of a live SOS (contact text, ops page, war room,
//    evidence) pages on-call operations: every SUPER_ADMIN in-app and every
//    OPS_ONCALL_PHONES number by text, in plain words that name no number;
//  - exactly once per failed row — a second sweep, the row's exhaustion
//    later, and two sweeps at once page nothing more; a page that died after
//    its claim is taken over only once the lease lapses; a page that throws
//    releases its claim and the next sweep pages;
//  - the store-review fiction's SOS is never paged about, and its old failures
//    never fill a sweep and hide a real one; a row that never failed, or
//    failed and then delivered (even between the sweep's read and its claim),
//    or belongs to an emergency that ended, is not;
//  - no phone number reaches a row's error, a log line, a page or a text.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) } as unknown as Server;
const notifications = () => new NotificationService(prisma, io);
const RUN = nanoid(6).toLowerCase();
const TENANT_REAL = `aud-l4-016-real-${RUN}`;
const TENANT_REVIEW = `aud-l4-016-review-${RUN}`;
const ONCALL = `+5926${String(Date.now()).slice(-6)}7`;
let sos: SosService;
let superAdminId = '';
const userIds: string[] = []; const alertIds: string[] = [];
let seq = 0;
const phoneBase = 592_741_000_000 + Math.floor(Math.random() * 50_000_000);
const phone = () => `+${phoneBase + (seq += 1)}`;
const digits = (p: string) => p.replace(/\D/g, '');

// Every log line the code under test writes, as text.
const logged: string[] = [];
const capture = (level: string) => (...args: unknown[]) => { logged.push(`${level} ${JSON.stringify(args, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v))}`); };
let previousLogger: ReturnType<typeof log>;

async function actorWithContact(tenantId?: string) {
  const user = await prisma.user.create({ data: { phone: phone(), firstName: 'Ana', lastName: `F${RUN}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, ...(tenantId ? { tenantId } : {}) } });
  userIds.push(user.id);
  const contactPhone = phone();
  await prisma.emergencyContact.create({ data: { userId: user.id, name: 'Mom', phoneE164: contactPhone, priority: 1, verifiedAt: new Date() } });
  return { user, contactPhone };
}

/** An ACTIVE alert whose rows are staged and not yet delivered (the process died after the commit). */
async function stagedAlert() {
  const { user, contactPhone } = await actorWithContact();
  sos.observer = { afterActive: async () => { throw new Error('process died'); } };
  await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', immediate: true, lat: 6.8, lng: -58.15 }).catch(() => {});
  sos.observer = {};
  const alert = await prisma.sosAlert.findFirstOrThrow({ where: { actorUserId: user.id } });
  alertIds.push(alert.id);
  return { user, contactPhone, alert };
}

/** Deliver everything, but the contact's text fails with a provider error that quotes the number. */
async function drainWithFailedText(alertId: string, contactPhone: string) {
  return drainSosEscalations(prisma, io, {
    alertIds: [alertId],
    observer: { beforeDeliver: async (row) => { if (row.channel === 'CONTACT_SMS') throw new Error(`provider refused the text to ${contactPhone}`); } },
  });
}

/** A failed row on an alert written directly — the shapes the outbox cannot be steered into cheaply. */
async function alertWithFailedRow(opts: { tenantId?: string | null; channel?: SosEscalationChannel; alertStatus?: 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED' | 'CANCELLED'; rowStatus?: 'FAILED' | 'PENDING' | 'SENT'; lastError?: string | null; attempts?: number } = {}) {
  const { user } = await actorWithContact();
  const alert = await prisma.sosAlert.create({ data: { actorUserId: user.id, actorRole: 'CUSTOMER', status: opts.alertStatus ?? 'ACTIVE', triggerSource: 'BUTTON', tenantId: opts.tenantId ?? null } });
  alertIds.push(alert.id);
  const row = await prisma.sosEscalation.create({ data: {
    tenantId: opts.tenantId ?? null, sosAlertId: alert.id, channel: opts.channel ?? 'CONTACT_SMS', targetKey: `target-${nanoid(6)}`,
    status: opts.rowStatus ?? 'FAILED', attempts: opts.attempts ?? 20, lastError: opts.lastError === undefined ? 'gateway down' : opts.lastError,
  } });
  return { alert, row };
}

const failurePages = (sosAlertId: string) => prisma.opsAlert.findMany({ where: { sosAlertId, kind: 'SOS', title: { contains: 'failed' } } });
const oncallFailureTexts = () => devChannelLog.filter((e) => e.channel === 'sms' && (e as { to?: string }).to === ONCALL && /failed/.test(String((e as { body?: string }).body)));
const superAdminNotices = (sosAlertId: string) => prisma.notification.findMany({ where: { userId: superAdminId, data: { path: ['sosAlertId'], equals: sosAlertId } } });
const page = (alertId: string | string[], extra: Partial<Parameters<typeof pageFailedSosEscalations>[2]> = {}) =>
  pageFailedSosEscalations(prisma, notifications(), { alertIds: Array.isArray(alertId) ? alertId : [alertId], ...extra });

beforeAll(async () => {
  await prisma.$connect();
  sos = new SosService(prisma, io);
  delete process.env['SOS_ESCALATION_WORKER_KILL'];
  await prisma.tenant.create({ data: { id: TENANT_REAL, name: 'AUD-L4-016 real tenant', slug: TENANT_REAL, isActive: true } });
  await prisma.tenant.create({ data: { id: TENANT_REVIEW, name: 'AUD-L4-016 review fiction', slug: TENANT_REVIEW, isActive: true, kind: 'REVIEW' } });
  const admin = await prisma.user.create({ data: { phone: phone(), firstName: 'Ops', lastName: `F${RUN}`, roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true } });
  superAdminId = admin.id; userIds.push(admin.id);
  previousLogger = log();
});
beforeEach(() => {
  resetDevChannelLog();
  logged.length = 0;
  process.env['OPS_ONCALL_PHONES'] = ONCALL;
  setAppLogger({ info: capture('info'), warn: capture('warn'), error: capture('error'), debug: () => {} } as never);
});
afterEach(() => { delete process.env['OPS_ONCALL_PHONES']; setAppLogger(previousLogger); });
afterAll(async () => {
  const opsAlerts = await prisma.opsAlert.findMany({ where: { sosAlertId: { in: alertIds } }, select: { id: true } });
  await prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: opsAlerts.map((a) => a.id) } } }).catch(() => {});
  await prisma.opsAlert.deleteMany({ where: { id: { in: opsAlerts.map((a) => a.id) } } }).catch(() => {});
  await prisma.evidenceBundle.deleteMany({ where: { sosAlertId: { in: alertIds } } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: userIds } }, ...alertIds.map((id) => ({ data: { path: ['sosAlertId'], equals: id } }))] } }).catch(() => {});
  await prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } });
  await prisma.emergencyContact.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_REAL, TENANT_REVIEW] } } }).catch(() => {});
  await prisma.$disconnect();
});

describe('a failed emergency-contact text pages on-call operations', () => {
  it('the text fails once (still retrying): SUPER_ADMIN in-app and the on-call phone by text, in plain words with no number', async () => {
    const { user, contactPhone, alert } = await stagedAlert();
    const drained = await drainWithFailedText(alert.id, contactPhone);
    expect(drained.failed).toBe(1);
    const sms = await prisma.sosEscalation.findFirstOrThrow({ where: { sosAlertId: alert.id, channel: 'CONTACT_SMS' } });
    expect(sms).toMatchObject({ status: 'PENDING', attempts: 1 });
    // The row's error and the worker's log say what failed — never the number.
    expect(sms.lastError).toContain('provider refused the text to');
    expect(sms.lastError).not.toContain(digits(contactPhone));
    expect(logged.join('\n')).not.toContain(digits(contactPhone));

    resetDevChannelLog();
    const res = await page(alert.id);
    expect(res.paged).toEqual([sms.id]);

    const [opsAlert, ...more] = await failurePages(alert.id);
    expect(more).toHaveLength(0);
    expect(opsAlert!.title).toBe('URGENT: SOS contact text failed — call the person now');
    expect(opsAlert!.body).toContain(`SOS alert ${alert.id}`);
    expect(opsAlert!.body).toContain('Swift keeps retrying.');
    expect((await prisma.sosEscalation.findUniqueOrThrow({ where: { id: sms.id } })).failurePageOpsAlertId).toBe(opsAlert!.id);
    // SUPER_ADMIN, in-app (and by push through the same notification).
    const notices = (await superAdminNotices(alert.id)).filter((n) => (n.data as { failedDelivery?: string }).failedDelivery === 'CONTACT_SMS');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe(opsAlert!.title);
    // The on-call phone, by text.
    expect(oncallFailureTexts()).toHaveLength(1);
    // Nobody's number anywhere: not the contact's, not the person's.
    const everything = JSON.stringify([opsAlert, notices, oncallFailureTexts(), logged]);
    expect(everything).not.toContain(digits(contactPhone));
    expect(everything).not.toContain(digits(user.phone!));
  });

  it('exactly once: two sweeps that both read the failure, a later sweep, and the row exhausting later page nothing more', async () => {
    const { contactPhone, alert } = await stagedAlert();
    await drainWithFailedText(alert.id, contactPhone);
    // Sweep B reads the failed row, then waits; sweep A pages it in full; B then
    // carries on with what it read. Only the claim can stop a second page.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let bRead!: () => void;
    const bHasRead = new Promise<void>((resolve) => { bRead = resolve; });
    const stale = new Proxy(prisma, {
      get(target, key, receiver) {
        if (key !== 'sosEscalation') return Reflect.get(target, key, receiver);
        return new Proxy(target.sosEscalation, {
          get: (t, k) => (k === 'findMany'
            ? async (args: Parameters<typeof t.findMany>[0]) => { const rows = await t.findMany(args); bRead(); await gate; return rows; }
            : Reflect.get(t, k)),
        });
      },
    }) as PrismaClient;
    const sweepB = pageFailedSosEscalations(stale, notifications(), { alertIds: [alert.id] });
    await bHasRead;
    const sweepA = await page(alert.id);
    release();
    const b = await sweepB;
    expect(sweepA.paged).toHaveLength(1);
    expect(b.paged, 'a sweep that read the failure before it was paged paged it again').toEqual([]);
    expect(await page(alert.id)).toEqual({ paged: [], review: [] });
    // The row runs out of attempts much later: the failure was already paged.
    await prisma.sosEscalation.updateMany({ where: { sosAlertId: alert.id, channel: 'CONTACT_SMS' }, data: { status: 'FAILED', attempts: 20 } });
    expect((await page(alert.id)).paged).toEqual([]);
    expect(await failurePages(alert.id)).toHaveLength(1);
    expect(oncallFailureTexts()).toHaveLength(1);
  });

  it('a row that exhausted its attempts without ever being paged is paged, and says Swift stopped retrying', async () => {
    const { alert, row } = await alertWithFailedRow({ tenantId: TENANT_REAL });
    expect((await page(alert.id)).paged).toEqual([row.id]);
    const [opsAlert] = await failurePages(alert.id);
    expect(opsAlert!.body).toContain('Swift stopped retrying after 20 attempts.');
    expect(opsAlert!.tenantId).toBe(TENANT_REAL);
  });
});

describe('ANY failed row pages, each in its own plain words', () => {
  it.each([
    ['OPS_PAGE', 'URGENT: SOS page failed — open the war room now'],
    ['WAR_ROOM', 'URGENT: SOS live board update failed — open the war room now'],
    ['EVIDENCE', 'SOS evidence record failed — check the alert'],
  ] as const)('%s', async (channel, title) => {
    const { alert, row } = await alertWithFailedRow({ channel, rowStatus: 'PENDING', attempts: 3, lastError: 'boom' });
    expect((await page(alert.id)).paged).toEqual([row.id]);
    expect((await failurePages(alert.id)).map((a) => a.title)).toEqual([title]);
    expect(oncallFailureTexts()).toHaveLength(1);
  });
});

describe('the claim is a lease; a page that throws hands the failure to the next sweep', () => {
  it('a live claim (another sweep is paging) is left alone; a lapsed one is taken over', async () => {
    const { alert, row } = await alertWithFailedRow();
    const now = new Date();
    await prisma.sosEscalation.update({ where: { id: row.id }, data: { failurePageClaimedAt: now } });
    expect((await page(alert.id, { now: new Date(now.getTime() + 5_000) })).paged).toEqual([]);
    expect(await failurePages(alert.id)).toHaveLength(0);
    expect((await page(alert.id, { now: new Date(now.getTime() + (FAILURE_PAGE_LEASE_SECONDS + 1) * 1000) })).paged).toEqual([row.id]);
    expect(await failurePages(alert.id)).toHaveLength(1);
  });

  it('a page that throws releases its claim, logs no number, and the next sweep pages', async () => {
    const { alert, row } = await alertWithFailedRow();
    let broken = true;
    const flaky = new Proxy(prisma, {
      get(target, key, receiver) {
        if (key === 'opsAlert' && broken) {
          return new Proxy(target.opsAlert, { get: (t, k) => (k === 'create' ? async () => { throw new Error('database blip while texting +5926001234'); } : Reflect.get(t, k)) });
        }
        return Reflect.get(target, key, receiver);
      },
    }) as PrismaClient;
    const failed = await pageFailedSosEscalations(flaky, notifications(), { alertIds: [alert.id] });
    expect(failed.paged).toEqual([]);
    expect(await prisma.sosEscalation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ failurePageClaimedAt: null, failurePageOpsAlertId: null });
    expect(logged.some((l) => l.includes('could not page operations about a failed SOS delivery'))).toBe(true);
    expect(logged.join('\n')).not.toContain('5926001234');
    broken = false;
    expect((await page(alert.id)).paged).toEqual([row.id]);
  });
});

describe('who is never paged about', () => {
  it('the store-review fiction’s SOS: no ops alert, no notice, no text — while the same failure on a real tenant pages', async () => {
    const fiction = await alertWithFailedRow({ tenantId: TENANT_REVIEW });
    const real = await alertWithFailedRow({ tenantId: TENANT_REAL });
    const res = await page([fiction.alert.id, real.alert.id]);
    expect(res.review, 'the fiction’s row is dropped by the sweep itself, never even read').toEqual([]);
    expect(res.paged).toEqual([real.row.id]);
    expect(await prisma.opsAlert.count({ where: { sosAlertId: fiction.alert.id } })).toBe(0);
    expect(await superAdminNotices(fiction.alert.id)).toHaveLength(0);
    expect(oncallFailureTexts()).toHaveLength(1); // the real one only
    expect(await prisma.sosEscalation.findUniqueOrThrow({ where: { id: fiction.row.id } })).toMatchObject({ failurePageClaimedAt: null, failurePageOpsAlertId: null });
  });

  it('a row that never failed, or failed and then delivered, or whose emergency has ended', async () => {
    const neverFailed = await alertWithFailedRow({ rowStatus: 'PENDING', attempts: 0, lastError: null });
    const recovered = await alertWithFailedRow({ rowStatus: 'SENT', attempts: 2, lastError: null });
    const resolved = await alertWithFailedRow({ alertStatus: 'RESOLVED' });
    const cancelled = await alertWithFailedRow({ alertStatus: 'CANCELLED' });
    const ids = [neverFailed, recovered, resolved, cancelled].map((x) => x.alert.id);
    expect(await page(ids)).toEqual({ paged: [], review: [] });
    expect(await prisma.opsAlert.count({ where: { sosAlertId: { in: ids } } })).toBe(0);
    expect(oncallFailureTexts()).toHaveLength(0);
  });

  it('an acknowledged emergency is still live: its failed contact text pages', async () => {
    const { alert, row } = await alertWithFailedRow({ alertStatus: 'ACKNOWLEDGED' });
    expect((await page(alert.id)).paged).toEqual([row.id]);
  });
});

describe('old store-review failures never fill a sweep and hide a real one', () => {
  it('the fiction’s rows are dropped before the bound: a real failure behind older fiction failures pages, with a window no wider than they are', async () => {
    const fictions = [];
    for (let i = 0; i < 3; i += 1) fictions.push(await alertWithFailedRow({ tenantId: TENANT_REVIEW }));
    // Older than the real failure, so oldest-first they come first.
    await prisma.sosEscalation.updateMany({ where: { id: { in: fictions.map((f) => f.row.id) } }, data: { createdAt: new Date(Date.now() - 60 * 60_000) } });
    const real = await alertWithFailedRow({ tenantId: TENANT_REAL });
    const res = await page([...fictions.map((f) => f.alert.id), real.alert.id], { limit: fictions.length });
    expect(res.paged, 'old store-review failures filled the sweep and hid a real SOS').toEqual([real.row.id]);
    expect(await prisma.opsAlert.count({ where: { sosAlertId: { in: fictions.map((f) => f.alert.id) } } })).toBe(0);
    expect(oncallFailureTexts()).toHaveLength(1); // the real one only
  });

  it('when the store-review tenants cannot be read, the real failure still pages and the fiction still does not', async () => {
    const fiction = await alertWithFailedRow({ tenantId: TENANT_REVIEW });
    const real = await alertWithFailedRow({ tenantId: TENANT_REAL });
    const blind = new Proxy(prisma, {
      get(target, key, receiver) {
        if (key !== 'tenant') return Reflect.get(target, key, receiver);
        return new Proxy(target.tenant, { get: (t, k) => (k === 'findMany' ? async () => { throw new Error('tenant lookup down'); } : Reflect.get(t, k)) });
      },
    }) as PrismaClient;
    const res = await pageFailedSosEscalations(blind, notifications(), { alertIds: [fiction.alert.id, real.alert.id] });
    expect(res.paged, 'a lookup hiccup left a real SOS failure unpaged').toEqual([real.row.id]);
    expect(res.review).toEqual([fiction.row.id]); // the per-row check caught it
    expect(await prisma.opsAlert.count({ where: { sosAlertId: fiction.alert.id } })).toBe(0);
    expect(oncallFailureTexts()).toHaveLength(1);
    expect(logged.some((l) => l.includes('could not read the store-review tenants'))).toBe(true);
  });
});

describe('the claim re-reads the row and the emergency', () => {
  /** A sweep that read the failure, then — before its claim — something else changed it. */
  const readThen = (meanwhile: () => Promise<unknown>) => new Proxy(prisma, {
    get(target, key, receiver) {
      if (key !== 'sosEscalation') return Reflect.get(target, key, receiver);
      return new Proxy(target.sosEscalation, {
        get: (t, k) => (k === 'findMany'
          ? async (args: Parameters<typeof t.findMany>[0]) => { const rows = await t.findMany(args); await meanwhile(); return rows; }
          : Reflect.get(t, k)),
      });
    },
  }) as PrismaClient;

  it('a row the worker delivered between the read and the claim is not paged', async () => {
    const { alert, row } = await alertWithFailedRow({ rowStatus: 'PENDING', attempts: 2, lastError: 'gateway down' });
    const delivered = readThen(() => prisma.sosEscalation.update({ where: { id: row.id }, data: { status: 'SENT', deliveredAt: new Date() } }));
    expect((await pageFailedSosEscalations(delivered, notifications(), { alertIds: [alert.id] })).paged).toEqual([]);
    expect(await failurePages(alert.id)).toHaveLength(0);
    expect(oncallFailureTexts()).toHaveLength(0);
    expect(await prisma.sosEscalation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ failurePageClaimedAt: null, failurePageOpsAlertId: null });
  });

  it('an emergency that ended between the read and the claim is not paged', async () => {
    const { alert, row } = await alertWithFailedRow();
    const ended = readThen(() => prisma.sosAlert.update({ where: { id: alert.id }, data: { status: 'RESOLVED' } }));
    expect((await pageFailedSosEscalations(ended, notifications(), { alertIds: [alert.id] })).paged).toEqual([]);
    expect(await failurePages(alert.id)).toHaveLength(0);
    expect(oncallFailureTexts()).toHaveLength(0);
    expect(await prisma.sosEscalation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ failurePageClaimedAt: null, failurePageOpsAlertId: null });
  });
});
