import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Server } from 'socket.io';
import type { OpsAlertKind } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { runWithoutTenant } from '../plugins/tenant-context';
import { NotificationService } from '../modules/notification/notification.service';
import { openOpsAlert, escalateOverdueOpsAlerts, smsDayKey, smsReminderSeconds, OPS_SMS_DAY_STORE_WAIT_MS, type OpsSms, type OpsSmsDayStore } from '../modules/safety/ops-alert';
import { devChannelLog, getChannels, resetDevChannelLog } from '../providers/notifications/channels';
import { gsm7Parts, isGsm7Message } from '../utils/sms-text';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [SMS-COST · owner ruling 2 Nov 2026 · GUARDRAILS §3] On-call TEXTS are capped;
// pushes, the inbox and SOS are not.
//
// One platform alert nobody acknowledged texted the on-call phone at every
// escalation, every half hour, all day. The ruling: the FIRST page texts; after
// it, at most ONE reminder text every 2 hours and at most 6 texts per alert per
// UTC day. Pushes and the admin inbox re-page exactly as before; an SOS is
// texted exactly as before. Asserted:
//  1. a platform page texts at its first page, then not again inside 2 hours
//     while every escalation still re-pushes the person (the old schedule);
//     the reminders that follow are at least 2 hours apart;
//  2. the 7th text of a UTC day is held, the push still goes, and the next
//     UTC day texts again (bounded, never silenced);
//  3. an SOS is texted at every escalation, as before, past 2 hours and past
//     6 a day;
//  4. a held reminder is not dropped: it goes in the next text it is allowed;
//     a first page no provider accepted texts at the first escalation;
//     a failing day counter never stops a text (the spacing still bounds it);
//  5. the worker hands the ladder its Redis.
// Each scenario runs on its own far-future clock and sweeps only its own alerts.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
const alertIds: string[] = [];
const ONCALL = testPhone();
const io = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) } as unknown as Server;
const notifications = () => new NotificationService(app.prisma, io);
const DAY = 86_400_000;
let epochDays = 900;
/** The start of a UTC day of the scenario's own, plus `offsetSeconds`, far past anything another suite sweeps. */
const epoch = (offsetSeconds = 60) => { const d = new Date(Date.now() + (epochDays += 40) * DAY); d.setUTCHours(0, 0, 0, 0); return new Date(d.getTime() + offsetSeconds * 1000); };
const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

interface Person { userId: string; device: string }
let seq = 0;
async function person(): Promise<Person> {
  seq += 1;
  const user = await runWithoutTenant(() => app.prisma.user.create({
    data: { phone: testPhone(), firstName: 'Cap', lastName: `C${RUN}${seq}`, roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true },
  }), 'test-fixture:sms-cap');
  userIds.push(user.id);
  const device = `ExponentPushToken[smscap-${RUN}-${seq}]`;
  await runWithoutTenant(() => app.prisma.deviceToken.create({ data: { userId: user.id, token: device, platform: 'ios' } }), 'test-fixture:sms-cap');
  return { userId: user.id, device };
}

const BODY = 'A long synthetic body the push carries in full and the text never repeats: it would cost paid parts for words nobody needs on a phone.';
async function open(mine: string[], kind: OpsAlertKind, now: Date, recipients: Person[], sms?: OpsSms) {
  const res = await runWithoutTenant(() => openOpsAlert(app.prisma, notifications(), {
    kind, tenantId: null, title: `Cap ${kind} ${RUN} ${nanoid(4)}`, body: BODY, data: { kind: 'sms_cap_test' }, now, recipientIds: recipients.map((p) => p.userId), ...(sms ? { sms } : {}),
  }), 'test-fixture:sms-cap');
  alertIds.push(res.opsAlertId); mine.push(res.opsAlertId);
  return res.opsAlertId;
}
const redisDay = (): OpsSmsDayStore => app.redis;
const sweep = (now: Date, ids: string[], smsDay: OpsSmsDayStore | null = redisDay(), sms: OpsSms = getChannels().sms) =>
  runWithoutTenant(() => escalateOverdueOpsAlerts(app.prisma, notifications(), sms, { now, limit: 1_000, alertIds: ids, smsDay }), 'test:sms-cap');
const repagesTo = (p: Person) => devChannelLog.filter((e) => e.channel === 'push' && e.to === p.device && e.data?.['kind'] === 'ops_alert_escalated');
const textsToOncall = () => devChannelLog.filter((e) => e.channel === 'sms' && e.to === ONCALL);
const alertRow = (id: string) => runWithoutTenant(() => app.prisma.opsAlert.findUniqueOrThrow({ where: { id } }), 'test-read:sms-cap');
const inbox = (p: Person) => runWithoutTenant(() => app.prisma.notification.findMany({ where: { userId: p.userId, data: { path: ['kind'], equals: 'ops_alert_escalated' } } }), 'test-read:sms-cap');

/** Sweep every `step` seconds from `from` to `to`; note WHEN (scenario seconds) each escalation, re-page and on-call text went out. */
async function series(t0: Date, ids: string[], who: Person, from: number, to: number, step: number, smsDay: OpsSmsDayStore | null = redisDay()) {
  const repages: number[] = []; const texts: number[] = []; const escalated = new Map<string, number[]>();
  for (let s = from; s <= to; s += step) {
    const p0 = repagesTo(who).length; const x0 = textsToOncall().length;
    const res = await sweep(at(t0, s), ids, smsDay);
    for (let i = p0; i < repagesTo(who).length; i += 1) repages.push(s);
    for (let i = x0; i < textsToOncall().length; i += 1) texts.push(s);
    for (const id of res.escalated) escalated.set(id, [...(escalated.get(id) ?? []), s]);
  }
  return { repages, texts, escalated };
}
const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]!);
const TWO_HOURS = 7_200;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.ready();
});

beforeEach(() => {
  resetDevChannelLog(); process.env['OPS_ONCALL_PHONES'] = ONCALL;
  for (const k of ['OPS_ALERT_ESCALATION_KILL', 'OPS_ALERT_REPAGE_MAX_PER_HOUR', 'OPS_ALERT_SMS_REMINDER_SECONDS', 'OPS_ALERT_SMS_MAX_PER_DAY']) delete process.env[k];
});
afterEach(() => { delete process.env['OPS_ONCALL_PHONES']; });

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: alertIds } } }).catch(() => {});
    await app.prisma.opsAlert.deleteMany({ where: { OR: [{ id: { in: alertIds } }, { title: { contains: RUN } }] } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.deviceToken.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:sms-cap');
  await app.close();
});

describe('[SMS-COST 1] a platform page texts at its first page, then at most once every 2 hours; pushes keep the old schedule', () => {
  it('first page texts; every escalation inside 2 hours is push-only; reminders after that are 2 hours apart', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    const page = await open(mine, 'PLATFORM', t0, [responder]);
    expect(textsToOncall()).toHaveLength(1);
    expect((await alertRow(page)).oncallTextedAt?.toISOString()).toBe(t0.toISOString());

    const run = await series(t0, mine, responder, 30, 8 * 3600, 30);
    const escalations = run.escalated.get(page)!;
    // the ladder itself is unchanged: 5, 10, 20 minutes, then every 30
    expect(escalations.slice(0, 6)).toEqual([120, 420, 1020, 2220, 4020, 5820]);
    // PUSH: every escalation re-pushed the person, exactly as before
    expect(run.repages).toEqual(escalations);
    // TEXT: nothing inside the first 2 hours; then the first escalation at/after 2 h, and 2 h apart after that
    expect(run.texts.filter((s) => s < TWO_HOURS)).toEqual([]);
    // (an alert owed since its first escalation is texted at the first sweep 2 h after its last text)
    expect(run.texts).toEqual([7200, 14400, 21600, 28800]);
    expect(Math.min(...gaps([0, ...run.texts]))).toBeGreaterThanOrEqual(TWO_HOURS);
    // the inbox keeps ONE escalation notice, at the latest level, with the full words
    const notice = await inbox(responder);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.title).toBe(`UNACKNOWLEDGED (${escalations.length}x): ${(await alertRow(page)).title}`);
    expect(notice[0]!.body).toContain(BODY);
    // the text: GSM-7, one part, the count and where to acknowledge it, never the body
    const text = textsToOncall().at(-1)!.body;
    expect(isGsm7Message(text)).toBe(true);
    expect(gsm7Parts(text)).toBe(1);
    expect(text).toMatch(/^Swift ops: UNACKNOWLEDGED \(\d+x\): Cap PLATFORM /);
    expect(text).toContain('Acknowledge it in Mission Control > Ops alerts.');
    expect(text).not.toContain('synthetic body');
    expect(textsToOncall()[0]!.body).not.toContain('synthetic body');
  }, 180_000);

  it('a drill texts at its first page only: its 15-minute window is push-only', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    const drill = await open(mine, 'DRILL', t0, [responder]);
    expect(textsToOncall()).toHaveLength(1);
    const run = await series(t0, mine, responder, 10, 890, 10);
    expect(run.escalated.get(drill)).toEqual([120, 420]);
    expect(run.repages).toEqual([120, 420]);
    expect(run.texts).toEqual([]);
  });
});

describe('[SMS-COST 2] at most 6 texts per alert per UTC day: the 7th is held, the push is not, the next day texts again', () => {
  it('six texts in the UTC day (the first page included), the seventh suppressed, then texted again after UTC midnight', async () => {
    const t0 = epoch(60); const mine: string[] = [];
    const responder = await person();
    const page = await open(mine, 'PLATFORM', t0, [responder]);
    const dayEnd = 86_400 - 60; // seconds from t0 to the next UTC midnight
    const run = await series(t0, mine, responder, 60, dayEnd + 3600, 60);
    const today = run.texts.filter((s) => s < dayEnd);
    // the first page + five reminders = six; reminders every 2 h would have made 11 more by midnight
    expect(1 + today.length).toBe(6);
    expect(today).toEqual([7200, 14400, 21600, 28800, 36000]);
    // the seventh was due 2 h on (43 200 s) and at every escalation after it: held, while pushes go on
    const escalations = run.escalated.get(page)!;
    expect(escalations.filter((s) => s >= 43_200 && s < dayEnd).length).toBeGreaterThan(10);
    expect(run.repages).toEqual(escalations);
    // never silenced: the first escalation after UTC midnight texts again
    const tomorrow = run.texts.filter((s) => s >= dayEnd);
    expect(tomorrow).toHaveLength(1);
    expect(tomorrow[0]).toBe(Math.ceil(dayEnd / 60) * 60); // the first sweep of the new UTC day
    const row = await alertRow(page);
    expect(row.acknowledgedAt).toBeNull();
    expect(row.closedAt).toBeNull();
  }, 300_000);
});

describe('[SMS-COST 2b · REVIEW-G4 S4-1 · REVIEW-M3 S4-2] the day count is per alert and per UTC day, and expires', () => {
  it('two alerts opened together: each has its own six a day; the next UTC day starts fresh for both; each key expires within two days', async () => {
    const t0 = epoch(60); const mine: string[] = [];
    const responder = await person();
    const a = await open(mine, 'PLATFORM', t0, [responder]);
    const b = await open(mine, 'PLATFORM', t0, [responder]);
    expect(textsToOncall()).toHaveLength(2); // two first pages
    const dayEnd = 86_400 - 60;
    const run = await series(t0, mine, responder, 60, dayEnd + TWO_HOURS, 60);
    // day 1: one collapsed reminder text names both alerts, five times (with a shared counter the pair would stop after three)
    const today = run.texts.filter((x) => x < dayEnd);
    expect(today).toEqual([7200, 14400, 21600, 28800, 36000]);
    expect(textsToOncall().filter((e) => e.body.startsWith('Swift ops: 2 ops alerts are UNACKNOWLEDGED'))).toHaveLength(5 + 2);
    // day 2: a fresh count (a key without the day would stop at one text): two texts 2 hours apart
    expect(run.texts.filter((x) => x >= dayEnd)).toEqual([86_340, 86_340 + TWO_HOURS]);
    const day1 = at(t0, 3_600); const day2 = at(t0, dayEnd + 60);
    for (const id of [a, b]) {
      expect(await app.redis.get(smsDayKey(id, day1))).toBe('5');
      expect(await app.redis.get(smsDayKey(id, day2))).toBe('2');
      const ttl = await app.redis.ttl(smsDayKey(id, day1));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(172_800);
    }
  }, 300_000);

  it('a reminder no provider took is not counted against the day; the next one that goes is', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    const page = await open(mine, 'PLATFORM', t0, [responder]);
    const refused: OpsSms = { sendSms: async () => ({ ref: 'not-allowlisted' }) };
    await sweep(at(t0, 120), mine);
    await sweep(at(t0, TWO_HOURS), mine, redisDay(), refused);
    expect(await app.redis.get(smsDayKey(page, at(t0, TWO_HOURS)))).toBeNull();
    resetDevChannelLog();
    await sweep(at(t0, 2 * TWO_HOURS), mine);
    expect(textsToOncall()).toHaveLength(1);
    expect(await app.redis.get(smsDayKey(page, at(t0, 2 * TWO_HOURS)))).toBe('1');
  });

  it('a day counter that never answers holds no text back: the sweep texts within its bound', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    await open(mine, 'PLATFORM', t0, [responder]);
    const sos = await open(mine, 'SOS', at(t0, 60), [responder]);
    await sweep(at(t0, 120), mine);
    const hung: OpsSmsDayStore = { get: () => new Promise(() => {}), incr: () => new Promise(() => {}), expire: () => new Promise(() => {}) };
    resetDevChannelLog();
    const started = Date.now();
    const res = await sweep(at(t0, TWO_HOURS), mine, hung);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.escalated).toContain(sos);
    expect(textsToOncall()).toHaveLength(1);
    expect(textsToOncall()[0]!.body).toMatch(/^Swift ops: 2 ops alerts are UNACKNOWLEDGED, including an SOS\./);
  });

  it('a count that lands after the bound still gets its expiry: no day key outlives its day', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    await open(mine, 'PLATFORM', t0, [responder]);
    await sweep(at(t0, 120), mine);
    const expired: number[] = [];
    const late: OpsSmsDayStore = {
      get: async () => null,
      incr: () => new Promise((resolve) => { setTimeout(() => resolve(1), OPS_SMS_DAY_STORE_WAIT_MS + 200); }),
      expire: async (_key, seconds) => { expired.push(seconds); return 1; },
    };
    resetDevChannelLog();
    await sweep(at(t0, TWO_HOURS), mine, late);
    expect(textsToOncall()).toHaveLength(1);
    await vi.waitFor(() => expect(expired).toEqual([172_800]), { timeout: 3_000 });
  });

  it('[REVIEW-M3 S4-6] a last text dated after the sweep (a skewed clock) never holds a reminder back', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    const page = await open(mine, 'PLATFORM', t0, [responder]);
    await runWithoutTenant(() => app.prisma.opsAlert.update({ where: { id: page }, data: { oncallTextedAt: at(t0, 3_600) } }), 'test-fixture:sms-cap');
    resetDevChannelLog();
    await sweep(at(t0, 120), mine);
    expect(textsToOncall()).toHaveLength(1);
  });

  it('[REVIEW-M3 S4-4] the reminder spacing setting is clamped: a typo never stops reminders', () => {
    process.env['OPS_ALERT_SMS_REMINDER_SECONDS'] = '7200000';
    expect(smsReminderSeconds()).toBe(21_600);
    process.env['OPS_ALERT_SMS_REMINDER_SECONDS'] = '1';
    expect(smsReminderSeconds()).toBe(300);
    delete process.env['OPS_ALERT_SMS_REMINDER_SECONDS'];
    expect(smsReminderSeconds()).toBe(TWO_HOURS);
  });
});

describe('[SMS-COST 3] an SOS is texted exactly as before', () => {
  it('an SOS texts at every escalation, past 2 hours and past six a day', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    const sos = await open(mine, 'SOS', t0, [responder]);
    expect(textsToOncall()).toHaveLength(1);
    const run = await series(t0, mine, responder, 30, 4 * 3600, 30);
    const escalations = run.escalated.get(sos)!;
    expect(escalations.slice(0, 5)).toEqual([120, 420, 1020, 1920, 2820]);
    expect(run.texts).toEqual(escalations);
    expect(run.repages).toEqual(escalations);
    expect(1 + run.texts.length).toBeGreaterThan(12);
    expect(await app.redis.get(smsDayKey(sos, t0))).toBeNull(); // an SOS never counts against a day
    // the text keeps an SOS's own short line
    expect(textsToOncall().at(-1)!.body).toContain('synthetic body');
    expect(isGsm7Message(textsToOncall().at(-1)!.body)).toBe(true);
    expect(gsm7Parts(textsToOncall().at(-1)!.body)).toBeLessThanOrEqual(2);
    // and the SOS row's reminder clock is never started at its first page
    expect((await alertRow(sos)).oncallTextedLevel).toBe(escalations.length);
  }, 180_000);

  it('a held platform reminder never holds an SOS text back, and is not dropped', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    const page = await open(mine, 'PLATFORM', t0, [responder]);
    const sos = await open(mine, 'SOS', at(t0, 600), [responder]);
    resetDevChannelLog();
    const res = await sweep(at(t0, 900), mine); // both escalate; the platform page is inside its 2 hours
    expect([...res.escalated].sort()).toEqual([page, sos].sort());
    expect(textsToOncall()).toHaveLength(1);
    expect(textsToOncall()[0]!.body).toContain(`UNACKNOWLEDGED (1x): ${(await alertRow(sos)).title}`);
    expect((await alertRow(page)).oncallTextedLevel).toBe(0); // still owed
    expect((await alertRow(sos)).oncallTextedLevel).toBe(1);
    // 2 hours after its first page, the platform alert's reminder goes (owed since level 1), in ONE text with the SOS
    resetDevChannelLog();
    await series(t0, mine, responder, 930, TWO_HOURS + 600, 30);
    const row = await alertRow(page);
    expect(row.oncallTextedLevel).toBeGreaterThan(1);
    expect(row.oncallTextedAt?.toISOString()).toBe(at(t0, TWO_HOURS).toISOString());
    expect(textsToOncall().at(-1)!.body).toBe(`Swift ops: 2 ops alerts are UNACKNOWLEDGED, including an SOS. First: ${(await alertRow(sos)).title}. Acknowledge them in Mission Control > Ops alerts.`);
  }, 180_000);
});

describe('[SMS-COST 4] bounded, never silenced', () => {
  it('a first page whose text no provider accepted texts at the first escalation', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    const refused: OpsSms = { sendSms: async () => ({ ref: 'not-allowlisted' }) };
    const page = await open(mine, 'PLATFORM', t0, [responder], refused);
    expect((await alertRow(page)).oncallTextedAt).toBeNull();
    expect(textsToOncall()).toHaveLength(0);
    const res = await sweep(at(t0, 120), mine);
    expect(res.escalated).toEqual([page]);
    expect(textsToOncall()).toHaveLength(1);
  });

  it('a day counter that fails is no reason to stop a text: the 2-hour spacing still bounds it', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    await open(mine, 'PLATFORM', t0, [responder]);
    const broken: OpsSmsDayStore = { get: async () => { throw new Error('redis down'); }, incr: async () => { throw new Error('redis down'); }, expire: async () => 0 };
    const run = await series(t0, mine, responder, 60, 5 * 3600, 60, broken);
    expect(run.texts).toEqual([7200, 14400]);
  }, 120_000);

  it('the worker hands the ladder its Redis, so the day cap is enforced in production', () => {
    const queue = readFileSync(join(process.cwd(), 'src/jobs/queue.ts'), 'utf8');
    expect(queue).toContain('escalateOverdueOpsAlerts(ctx.prisma, opsNotifications, getChannels().sms, { smsDay: ctx.redis })');
  });
});
