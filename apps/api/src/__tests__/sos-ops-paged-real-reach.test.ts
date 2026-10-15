import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { SosService } from '../modules/safety/sos.service';
import { NotificationService } from '../modules/notification/notification.service';
import { openOpsAlert, escalateOverdueOpsAlerts, type OpsSms } from '../modules/safety/ops-alert';
import { sosReachedAnyone } from '../modules/safety/delivery-proof';
import { guardNonProductionSms } from '../providers/notifications/sms-recipient-allowlist';
import type { NotificationChannels } from '../providers/notifications/channels';

// ---------------------------------------------------------------------------
// [AUD-L8b-008 · AUD-G7-003 · row 204] SOS "ops paged" counted inbox rows.
//
// The ops page wrote one inbox row per responder and counted the ROWS as the
// people paged: a responder with no phone registered, a push the provider
// refused, or a provider that was down all still read as "paged". An on-call
// text the non-production recipient list held back (it resolves without
// sending) read as "texted". The SOS receipt — what the evidence bundle keeps
// and the delivery-proof oracle judges — then said responders were paged when
// nobody had been told, and a page that reached nobody waited out its whole
// acknowledgement deadline before anything escalated.
//
// Asserted, on the real ops-alert path and the real SOS outbox (only the push
// and SMS providers are stand-ins, so each test decides what they accept):
//  - "pushed" = the push provider ACCEPTED the push for the responder;
//    "oncallTexted" = the SMS provider ACCEPTED the text; "reached" = both;
//    inbox rows are counted apart and prove nothing;
//  - a page that reached nobody says 0 and is due for escalation at once: the
//    next sweep escalates it and pages the platform;
//  - the SOS receipt's opsPaged is that real count (opsInbox apart), and an
//    SOS whose page reached nobody is not "reached" by the oracle.
// ---------------------------------------------------------------------------

const ctl = vi.hoisted(() => ({
  /** What the stand-in push provider does with a push. */
  push: 'refuse' as 'accept' | 'refuse',
  /** What the stand-in SMS provider answers per number: a provider ref, or null = it throws. */
  smsRef: (_to: string): string | null => 'SM-provider-accepted',
  smsTo: [] as string[],
}));

vi.mock('../providers/notifications/channels', async (importOriginal) => {
  const real = await importOriginal<typeof import('../providers/notifications/channels')>();
  const channels = {
    push: { sendPush: async (tokens: string[]) => ({ sent: ctl.push === 'accept' ? tokens.length : 0 }) },
    sms: {
      sendSms: async (to: string) => {
        ctl.smsTo.push(to);
        const ref = ctl.smsRef(to);
        if (ref === null) throw new Error('provider refused the text');
        return { ref };
      },
    },
    email: { sendEmail: async () => ({ ref: 'email-stand-in' }) },
  };
  return { ...real, getChannels: () => channels };
});

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) } as unknown as Server;
const notifications = () => new NotificationService(prisma, io);
const RUN = nanoid(6).toLowerCase();
const ONCALL = `+5926${String(Date.now()).slice(-6)}4`;
const ONCALL_2 = `+5926${String(Date.now()).slice(-6)}5`;
const ONCALL_3 = `+5926${String(Date.now()).slice(-6)}6`;
let seq = 0;
const phoneBase = 592_742_000_000 + Math.floor(Math.random() * 50_000_000);
const phone = () => `+${phoneBase + (seq += 1)}`;
const userIds: string[] = []; const sosIds: string[] = []; const opsIds: string[] = [];
let sos: SosService;
let responderId = '';

/** The real SMS seam's answer for an on-call phone the provider accepted. */
const acceptingSms: OpsSms = { sendSms: async (to: string) => { ctl.smsTo.push(to); return { ref: `SM-${nanoid(8)}` }; } };

async function user(roles: Array<'SUPER_ADMIN' | 'CUSTOMER'>, opts: { token?: boolean; pushOff?: boolean } = {}) {
  const u = await prisma.user.create({ data: {
    phone: phone(), firstName: 'Reach', lastName: `R${RUN}`, roles, activeRole: roles[0]!, status: 'ACTIVE', isPhoneVerified: true,
    ...(opts.pushOff ? { notificationPrefs: { push: false } } : {}),
  } });
  userIds.push(u.id);
  if (opts.token) await prisma.deviceToken.create({ data: { userId: u.id, token: `ExponentPushToken[reach-${RUN}-${seq}]`, platform: 'ios' } });
  return u.id;
}

const opsRow = (id: string) => prisma.opsAlert.findUniqueOrThrow({ where: { id } });
const open = async (input: Partial<Parameters<typeof openOpsAlert>[2]> & { recipientIds: string[] }, now = new Date()) => {
  const res = await openOpsAlert(prisma, notifications(), { kind: 'PLATFORM', tenantId: null, title: `Reach page ${RUN} ${nanoid(4)}`, body: 'A synthetic page.', data: { kind: 'reach_test' }, now, ...input });
  opsIds.push(res.opsAlertId);
  return res;
};

beforeAll(async () => {
  await prisma.$connect();
  sos = new SosService(prisma, io);
  delete process.env['SOS_ESCALATION_WORKER_KILL'];
  delete process.env['OPS_ALERT_ESCALATION_KILL'];
  // A SUPER_ADMIN with a registered phone: every platform and SOS page addresses them.
  responderId = await user(['SUPER_ADMIN'], { token: true });
});
beforeEach(() => { ctl.push = 'refuse'; ctl.smsRef = () => 'SM-provider-accepted'; ctl.smsTo.length = 0; delete process.env['OPS_ONCALL_PHONES']; });
afterEach(() => { delete process.env['OPS_ONCALL_PHONES']; });
afterAll(async () => {
  const sosOps = await prisma.opsAlert.findMany({ where: { sosAlertId: { in: sosIds } }, select: { id: true } });
  const all = [...opsIds.filter(Boolean), ...sosOps.map((a) => a.id)];
  await prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: all } } }).catch(() => {});
  await prisma.opsAlert.deleteMany({ where: { id: { in: all } } }).catch(() => {});
  await prisma.evidenceBundle.deleteMany({ where: { sosAlertId: { in: sosIds } } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: userIds } }, ...sosIds.map((id) => ({ data: { path: ['sosAlertId'], equals: id } })), ...all.map((id) => ({ data: { path: ['opsAlertId'], equals: id } }))] } }).catch(() => {});
  await prisma.sosAlert.deleteMany({ where: { id: { in: sosIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('a send reports whether a push actually went out', () => {
  const stub = (sendPush: NotificationChannels['push']['sendPush']) => ({ push: { sendPush }, sms: acceptingSms, email: { sendEmail: async () => ({ ref: 'e' }) } }) as unknown as NotificationChannels;
  const payload = (userId: string) => ({ userId, type: 'SYSTEM_ANNOUNCEMENT' as const, title: `Reach ${RUN}`, body: 'b', data: { kind: 'reach_test' } });

  it('pushed only when the provider accepted a push for one of the person’s phones — never for an inbox row alone', async () => {
    const withPhone = await user(['CUSTOMER'], { token: true });
    const noPhone = await user(['CUSTOMER']);
    const pushOff = await user(['CUSTOMER'], { token: true, pushOff: true });
    const accept = new NotificationService(prisma, io, stub(async (tokens) => ({ sent: tokens.length })));
    const refuse = new NotificationService(prisma, io, stub(async () => ({ sent: 0 })));
    const down = new NotificationService(prisma, io, stub(async () => { throw new Error('push provider down'); }));
    const yes = await accept.sendReach(payload(withPhone));
    expect(yes.id).toBeTruthy();
    expect(yes.pushed).toBe(true);
    for (const [svc, who] of [[refuse, withPhone], [down, withPhone], [accept, noPhone], [accept, pushOff]] as const) {
      const r = await svc.sendReach(payload(who));
      expect(r.id, 'the inbox row is still written').toBeTruthy();
      expect(r.pushed, 'an inbox row is not a person told').toBe(false);
    }
    // send() is unchanged: it returns the row id
    expect(typeof await accept.send(payload(withPhone))).toBe('string');
  });

  it('a dedupe hit re-sends nothing, so it reached nobody new', async () => {
    const withPhone = await user(['CUSTOMER'], { token: true });
    const accept = new NotificationService(prisma, io, stub(async (tokens) => ({ sent: tokens.length })));
    const first = await accept.sendReach({ ...payload(withPhone), dedupeKey: `reach-${RUN}` });
    const again = await accept.sendReach({ ...payload(withPhone), dedupeKey: `reach-${RUN}` });
    expect(first.pushed).toBe(true);
    expect(again).toEqual({ id: first.id, pushed: false });
  });
});

describe('an ops page counts the people it reached, not the inbox rows it wrote', () => {
  it('a page whose push the provider refused and whose on-call text was held back reached NOBODY: it says 0 and is due for escalation at once', async () => {
    const now = new Date();
    // The non-production recipient list holds the text back: the send RESOLVES, nothing leaves.
    const inner = { sendSms: vi.fn(async () => ({ ref: 'SM-should-not-be-called' })) };
    const held = guardNonProductionSms(inner, { NODE_ENV: 'test', SMS_RECIPIENT_ALLOWLIST: '' });
    const res = await open({ recipientIds: [responderId], sms: held, oncallPhones: [ONCALL] }, now);
    expect(inner.sendSms).not.toHaveBeenCalled();
    expect(res).toMatchObject({ recipients: 1, inboxed: 1, pushed: 0, oncallTexted: 0, reached: 0 });
    const row = await opsRow(res.opsAlertId);
    expect(row.ackDeadlineAt.getTime(), 'due now, not after a deadline nobody knows about').toBeLessThanOrEqual(now.getTime() + 1_000);
    const esc = await escalateOverdueOpsAlerts(prisma, notifications(), acceptingSms, { now: new Date(now.getTime() + 1_000), limit: 1_000 });
    expect(esc.escalated).toContain(res.opsAlertId);
    expect(esc.platformPage).toContain(res.opsAlertId);
  });

  it('a push the provider accepted is a responder reached; the page keeps its acknowledgement deadline', async () => {
    ctl.push = 'accept';
    const now = new Date();
    const res = await open({ recipientIds: [responderId], sms: acceptingSms, oncallPhones: [] }, now);
    expect(res).toMatchObject({ recipients: 1, inboxed: 1, pushed: 1, oncallTexted: 0, reached: 1 });
    expect((await opsRow(res.opsAlertId)).ackDeadlineAt.getTime()).toBeGreaterThan(now.getTime() + 60_000);
  });

  it('an on-call text counts only when the provider accepted it — a refused text and a held one do not', async () => {
    const sms: OpsSms = {
      sendSms: async (to: string) => {
        if (to === ONCALL) return { ref: 'SM-accepted' };
        if (to === ONCALL_2) throw new Error('provider refused the text');
        return { ref: 'not-allowlisted' };
      },
    };
    const res = await open({ recipientIds: [responderId], sms, oncallPhones: [ONCALL, ONCALL_2, ONCALL_3] });
    expect(res).toMatchObject({ inboxed: 1, pushed: 0, oncallTexted: 1, reached: 1 });
  });
});

describe('the SOS receipt says who was actually paged', () => {
  async function raise() {
    const actor = await user(['CUSTOMER']);
    const alert = await sos.create({ actorUserId: actor, actorRole: 'CUSTOMER', immediate: true, lat: 6.8, lng: -58.15 });
    sosIds.push(alert.id);
    const opsPage = await prisma.sosEscalation.findFirstOrThrow({ where: { sosAlertId: alert.id, channel: 'OPS_PAGE' } });
    const fresh = await prisma.sosAlert.findUniqueOrThrow({ where: { id: alert.id } });
    const page = await prisma.opsAlert.findFirstOrThrow({ where: { sosAlertId: alert.id, kind: 'SOS' } });
    return { alert, opsPage, receipts: fresh.deliveryReceipts as Record<string, unknown>, page };
  }

  it('an SOS whose page reached nobody records opsPaged 0 (inbox rows apart), is not "reached", and escalates on the next sweep', async () => {
    const now = Date.now();
    const { opsPage, receipts, page } = await raise();
    expect(opsPage.status).toBe('SENT');
    const r = opsPage.receipt as Record<string, number>;
    expect(r['opsPaged'], 'nobody was reached: no push and no text was accepted').toBe(0);
    expect(r).toMatchObject({ opsPushed: 0, oncallTexted: 0 });
    expect(r['opsInbox'], 'the inbox rows were written (the SUPER_ADMIN is addressed)').toBeGreaterThanOrEqual(1);
    expect(receipts['opsPaged']).toBe(0);
    expect(receipts['opsInbox']).toBe(r['opsInbox']);
    expect(sosReachedAnyone(receipts, 0), 'inbox rows and an unwatched room are not a person told').toBe(false);
    expect(page.ackDeadlineAt.getTime()).toBeLessThanOrEqual(now + 5_000);
    const esc = await escalateOverdueOpsAlerts(prisma, notifications(), acceptingSms, { now: new Date(Date.now() + 1_000), limit: 1_000 });
    expect(esc.escalated).toContain(page.id);
    expect(esc.platformPage).toContain(page.id);
  });

  it('an SOS whose push and on-call text were accepted counts exactly those, and keeps its deadline', async () => {
    ctl.push = 'accept';
    process.env['OPS_ONCALL_PHONES'] = ONCALL;
    const now = Date.now();
    const { opsPage, receipts, page } = await raise();
    const r = opsPage.receipt as Record<string, number>;
    expect(r['opsPushed'], 'the SUPER_ADMIN with a phone was pushed').toBeGreaterThanOrEqual(1);
    expect(r['oncallTexted']).toBe(1);
    expect(ctl.smsTo).toContain(ONCALL);
    expect(r['opsPaged']).toBe(r['opsPushed']! + r['oncallTexted']!);
    expect(receipts['opsPaged']).toBe(r['opsPaged']);
    expect(sosReachedAnyone(receipts, 0)).toBe(true);
    expect(page.ackDeadlineAt.getTime()).toBeGreaterThan(now + 60_000);
  });
});
