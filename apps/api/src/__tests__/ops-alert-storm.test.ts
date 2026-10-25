import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Server } from 'socket.io';
import type { OpsAlertKind, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { beginRequestTenantContext, runWithoutTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { NotificationService } from '../modules/notification/notification.service';
import { openOpsAlert, escalateOverdueOpsAlerts, acknowledgeOpsAlert, scanOpsAlerts, runOpsAlertDrillIfDue, DRILL_FAILED_REASON, guyanaTime } from '../modules/safety/ops-alert';
import { devChannelLog, getChannels, resetDevChannelLog } from '../providers/notifications/channels';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [DRILL-STORM · GUARDRAILS §3] An unacknowledged ops alert re-paged forever.
//
// Seen on the owner's phone (staging, 25 Oct 2026): "UNACKNOWLEDGED (4976×):
// Ops alert drill …" — one weekly drill, re-pushed to every responder and
// texted to every on-call phone every five minutes for seventeen days, the
// 15 Oct (2998×) and 22 Oct (1020×) drills beside it, and an "OVERDUE" platform
// page for each every fifteen minutes. A page storm drowns a real SOS and
// burns the on-call phone. Asserted:
//  1. a DRILL nobody acknowledges within its window is closed as a FAILED
//     drill: recorded, one summary notice to platform operators, never paged
//     again, and it stays visible (the list of failed drills, the gauge); a
//     late acknowledgement does not turn it into a passed drill;
//  2. a REAL alert keeps escalating until a human acknowledges it, with a
//     backoff between escalations (capped), at most N re-pages an hour to a
//     person, the platform paged once; it never stops;
//  3. many old open alerts never produce a burst: one sweep re-pages a person
//     ONCE (every owed alert in one push that replaces the last one on the
//     phone) and texts the on-call list once, and an hour of sweeps stays
//     inside the per-person cap.
// Each scenario runs on its own clock far in the future and sweeps only its
// own alerts (alertIds), so no other suite's alerts are touched.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
const alertIds: string[] = [];
const ONCALL = testPhone();
const io = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) } as unknown as Server;
const notifications = () => new NotificationService(app.prisma, io);
const DAY = 86_400_000;
let epochDays = 400;
/** A clock of the scenario's own, far past anything another suite sweeps. */
const epoch = () => new Date(Date.now() + (epochDays += 40) * DAY);
const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

interface Person { userId: string; token: string; device: string }
let seq = 0;
async function person(roles: UserRole[] = ['SUPER_ADMIN']): Promise<Person> {
  seq += 1;
  const user = await runWithoutTenant(() => app.prisma.user.create({
    data: { phone: testPhone(), firstName: 'Storm', lastName: `S${RUN}${seq}`, roles, activeRole: roles[0]!, status: 'ACTIVE', isPhoneVerified: true },
  }), 'test-fixture:drill-storm');
  userIds.push(user.id);
  const device = `ExponentPushToken[storm-${RUN}-${seq}]`;
  await runWithoutTenant(() => app.prisma.deviceToken.create({ data: { userId: user.id, token: device, platform: 'ios' } }), 'test-fixture:drill-storm');
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await runWithoutTenant(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'storm', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + DAY) } }), 'test-fixture:drill-storm');
  return { userId: user.id, token, device };
}

/** Open a page the way production does (initial push + on-call text). */
async function open(mine: string[], kind: OpsAlertKind, now: Date, recipients: Person[], title = `Storm ${kind} ${RUN} ${nanoid(4)}`) {
  const res = await runWithoutTenant(() => openOpsAlert(app.prisma, notifications(), { kind, tenantId: null, title, body: 'A synthetic page.', data: { kind: 'storm_test' }, now, recipientIds: recipients.map((p) => p.userId) }), 'test-fixture:drill-storm');
  alertIds.push(res.opsAlertId); mine.push(res.opsAlertId);
  return res.opsAlertId;
}

/** An alert as the old ladder left it: `level` escalations done, every one already re-paged and texted. */
async function legacy(mine: string[], kind: OpsAlertKind, opts: { createdAt: Date; level: number; lastEscalatedAt: Date | null; pagedAt?: Date; recipients: Person[] }) {
  const a = await runWithoutTenant(() => app.prisma.opsAlert.create({
    data: {
      tenantId: null, kind, title: `Storm legacy ${kind} ${RUN} ${nanoid(4)}`, body: 'A page left open by the old ladder.',
      createdAt: opts.createdAt, ackDeadlineAt: at(opts.createdAt, 120),
      escalationLevel: opts.level, lastEscalatedAt: opts.lastEscalatedAt, oncallTextedLevel: opts.level, oncallTextedAt: opts.lastEscalatedAt,
      recipients: { create: opts.recipients.map((p) => ({ tenantId: null, userId: p.userId, deliveredAt: opts.createdAt, pagedLevel: opts.level, lastPagedAt: opts.pagedAt ?? opts.lastEscalatedAt })) },
    },
  }), 'test-fixture:drill-storm');
  alertIds.push(a.id); mine.push(a.id);
  return a.id;
}

const sweep = (now: Date, ids: string[]) =>
  runWithoutTenant(() => escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now, limit: 1_000, alertIds: ids }), 'test:drill-storm');
const pushesTo = (p: Person) => devChannelLog.filter((e) => e.channel === 'push' && e.to === p.device);
const repagesTo = (p: Person) => pushesTo(p).filter((e) => e.data?.['kind'] === 'ops_alert_escalated');
const textsToOncall = () => devChannelLog.filter((e) => e.channel === 'sms' && e.to === ONCALL);
const alertRow = (id: string) => runWithoutTenant(() => app.prisma.opsAlert.findUniqueOrThrow({ where: { id }, include: { recipients: true } }), 'test-read:drill-storm');
const inbox = (p: Person, kind: string) => runWithoutTenant(() => app.prisma.notification.findMany({ where: { userId: p.userId, data: { path: ['kind'], equals: kind } } }), 'test-read:drill-storm');
/** The most events any rolling hour of `times` (seconds) holds. */
const maxPerHour = (times: number[]) => Math.max(0, ...times.map((t) => times.filter((u) => u >= t && u < t + 3_600).length));
/** Sweep the scenario's alerts every `step` seconds and note WHEN (scenario time) each re-page and on-call text went out. */
async function series(t0: Date, ids: string[], who: Person, from: number, to: number, step: number) {
  const repages: number[] = []; const texts: number[] = []; const escalated = new Map<string, number[]>(); const platform = new Map<string, number[]>();
  for (let s = from; s <= to; s += step) {
    const p0 = repagesTo(who).length; const x0 = textsToOncall().length;
    const res = await sweep(at(t0, s), ids);
    for (let i = p0; i < repagesTo(who).length; i += 1) repages.push(s);
    for (let i = x0; i < textsToOncall().length; i += 1) texts.push(s);
    for (const id of res.escalated) escalated.set(id, [...(escalated.get(id) ?? []), s]);
    for (const id of res.platformPage) platform.set(id, [...(platform.get(id) ?? []), s]);
  }
  return { repages, texts, escalated, platform };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

beforeEach(() => { resetDevChannelLog(); process.env['OPS_ONCALL_PHONES'] = ONCALL; delete process.env['OPS_ALERT_ESCALATION_KILL']; delete process.env['OPS_ALERT_REPAGE_MAX_PER_HOUR']; });
afterEach(() => { delete process.env['OPS_ONCALL_PHONES']; delete process.env['OPS_ALERT_REPAGE_MAX_PER_HOUR']; });

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: alertIds } } }).catch(() => {});
    await app.prisma.opsAlert.deleteMany({ where: { OR: [{ id: { in: alertIds } }, { title: { contains: RUN } }] } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.deviceToken.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:drill-storm');
  await app.close();
});

describe('[DRILL-STORM 1] a drill nobody acknowledges is a FAILED drill, closed and never paged again', () => {
  it('escalates inside its window like a real page, then is closed FAILED with one summary notice, and pages nobody after its window', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    const drill = await open(mine, 'DRILL', t0, [responder]);
    expect(pushesTo(responder)).toHaveLength(1);
    expect(textsToOncall()).toHaveLength(1);
    // [console] the FIRST page already says where it is acknowledged (push and on-call text)
    expect(pushesTo(responder)[0]!.body).toContain('Acknowledge it in Mission Control > Ops alerts.');
    expect(textsToOncall()[0]!.body).toContain('Acknowledge it in Mission Control > Ops alerts.');

    // Inside the 15-minute window it exercises the escalation path, exactly like a real page.
    const inWindow = await series(t0, mine, responder, 10, 890, 10);
    expect(inWindow.escalated.get(drill)).toEqual([120, 420]);
    expect(inWindow.repages).toEqual([120, 420]);
    expect(inWindow.texts).toEqual([120, 420]);
    expect((await alertRow(drill)).closedAt).toBeNull();

    // The window ends: closed as a FAILED drill, said once.
    const closing = await sweep(at(t0, 900), mine);
    expect(closing.closed).toContain(drill);
    expect(closing.drillsFailed).toEqual([drill]);
    expect(closing.escalated).toEqual([]);
    const row = await alertRow(drill);
    expect(row).toMatchObject({ acknowledgedAt: null, closeReason: DRILL_FAILED_REASON, escalationLevel: 2 });
    expect(row.closedAt?.toISOString()).toBe(at(t0, 900).toISOString());
    const summary = await inbox(responder, 'ops_alert_drill_failed');
    expect(summary).toHaveLength(1);
    expect(summary[0]!.title).toBe('Drill FAILED: nobody acknowledged the SOS paging drill');
    expect(summary[0]!.body).toBe(`The ops alert drill opened at ${guyanaTime(t0)} was not acknowledged within 15 minutes. It is closed as a FAILED drill and will not page again. Check that on-call staff get Swift pages, then run a drill from Mission Control > Ops alerts.`);
    expect((summary[0]!.data as Record<string, unknown>)['opsAlertId']).toBe(drill);

    // Six hours of sweeps after the window: nobody is paged, nothing is texted, nothing is said twice.
    const pushes = pushesTo(responder).length;
    const after = await series(t0, mine, responder, 930, 6 * 3600, 30);
    expect(after.escalated.size).toBe(0);
    expect(after.repages).toEqual([]);
    expect(after.texts).toEqual([]);
    expect(pushesTo(responder)).toHaveLength(pushes);
    expect((await alertRow(drill)).escalationLevel).toBe(2);
    expect(await inbox(responder, 'ops_alert_drill_failed')).toHaveLength(1);
  }, 120_000);

  it('a failed drill stays visible: listed for platform operators, counted by the gauge, and a late acknowledgement does not pass it', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    const tenantAdmin = await person(['ADMIN']);
    const drill = await open(mine, 'DRILL', t0, [responder]);
    await sweep(at(t0, 900), mine);
    expect((await alertRow(drill)).closeReason).toBe(DRILL_FAILED_REASON);

    // A late acknowledgement is refused quietly: the drill stays FAILED, never "acknowledged".
    const late = await runWithoutTenant(() => acknowledgeOpsAlert(app.prisma, { opsAlertId: drill, userId: responder.userId, now: at(t0, 1_000) }), 'test:drill-storm');
    expect(late.acknowledged).toEqual([]);
    expect(await alertRow(drill)).toMatchObject({ acknowledgedAt: null, acknowledgedBy: null, closeReason: DRILL_FAILED_REASON });
    const viaRoute = await app.inject({ method: 'POST', url: `/api/v1/safety/ops-alerts/${drill}/ack`, headers: { authorization: `Bearer ${responder.token}`, 'content-type': 'application/json' }, payload: {} });
    expect(viaRoute.statusCode).toBe(200);
    expect(viaRoute.json().data.acknowledged).toBe(false);
    expect((await alertRow(drill)).acknowledgedAt).toBeNull();
    expect((await alertRow(drill)).recipients.every((r) => r.ackedAt === null)).toBe(true);

    // The list of failed drills: platform operators only.
    const list = await app.inject({ method: 'GET', url: '/api/v1/safety/ops-alerts/failed-drills', headers: { authorization: `Bearer ${responder.token}` } });
    expect(list.statusCode).toBe(200);
    const listed = (list.json().data as Array<{ id: string; closeReason: string }>).find((r) => r.id === drill);
    expect(listed).toMatchObject({ id: drill, closeReason: DRILL_FAILED_REASON });
    const refused = await app.inject({ method: 'GET', url: '/api/v1/safety/ops-alerts/failed-drills', headers: { authorization: `Bearer ${tenantAdmin.token}` } });
    expect(refused.statusCode).toBe(403);

    // The gauge counts it.
    const scan = await runWithoutTenant(() => scanOpsAlerts(app.prisma, at(t0, 1_000)), 'test:drill-storm');
    expect(scan.drillsFailed30d).toBeGreaterThanOrEqual(1);
  });

  it('the scheduled drill tells the responder how long they have, and that it closes as a FAILED drill', async () => {
    const t0 = epoch();
    const res = await runWithoutTenant(() => runOpsAlertDrillIfDue(app.prisma, notifications(), t0), 'test:drill-storm');
    expect(res.opened).toBeTruthy(); alertIds.push(res.opened!);
    expect((await alertRow(res.opened!)).body).toBe('This is a scheduled drill of the SOS paging path. Acknowledge it in Mission Control > Ops alerts within 2 minutes. If nobody does, it escalates like a real SOS for 15 minutes, then closes as a FAILED drill and stops paging.');
  });
});

describe('[DRILL-STORM 2] a real alert keeps escalating until acknowledged — backed off, capped per person, never stopped', () => {
  it('a platform page escalates on a widening backoff to a ceiling, pages the platform once, and is still paging six hours later', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    const page = await open(mine, 'PLATFORM', t0, [responder]);
    const run = await series(t0, mine, responder, 30, 6 * 3600, 30);
    const escalations = run.escalated.get(page)!;
    // backoff: 5, 10, 20 minutes, then every 30 minutes (the ceiling)
    expect(escalations.slice(0, 6)).toEqual([120, 420, 1020, 2220, 4020, 5820]);
    const gaps = escalations.slice(1).map((s, i) => s - escalations[i]!);
    expect(Math.max(...gaps)).toBe(1800);
    // the platform is paged once, at the first escalation
    expect(run.platform.get(page)).toEqual([120]);
    // each escalation re-paged the person once, and the re-page replaces the last one on the phone
    expect(run.repages).toEqual(escalations);
    expect(repagesTo(responder).every((e) => e.options?.collapseId === 'ops-alert-unacked' && e.options?.tag === 'ops-alert-unacked')).toBe(true);
    expect(maxPerHour(run.repages)).toBeLessThanOrEqual(12);
    // never stops: the sixth hour still re-pages, and the alert is open
    expect(escalations.filter((s) => s > 5 * 3600).length).toBeGreaterThanOrEqual(2);
    expect(await alertRow(page)).toMatchObject({ acknowledgedAt: null, closedAt: null, escalationLevel: escalations.length });
    // the inbox keeps ONE escalation notice for the person, holding the latest level
    const notice = await inbox(responder, 'ops_alert_escalated');
    expect(notice).toHaveLength(1);
    expect(notice[0]!.title).toBe(`UNACKNOWLEDGED (${escalations.length}×): ${(await alertRow(page)).title}`);
    expect(notice[0]!.isRead).toBe(false);
    // [console] every re-page and on-call text says where a page is acknowledged
    expect(notice[0]!.body).toContain('Acknowledge it now in Mission Control > Ops alerts.');
    expect(textsToOncall().at(-1)!.body).toContain('Acknowledge it in Mission Control > Ops alerts.');
  }, 120_000);

  it('an SOS page backs off to a 15-minute ceiling: four re-pages every hour, for as long as nobody acknowledges', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    const page = await open(mine, 'SOS', t0, [responder]);
    const run = await series(t0, mine, responder, 30, 4 * 3600, 30);
    const escalations = run.escalated.get(page)!;
    expect(escalations.slice(0, 5)).toEqual([120, 420, 1020, 1920, 2820]);
    const gaps = escalations.slice(1).map((s, i) => s - escalations[i]!);
    expect(Math.max(...gaps)).toBe(900);
    expect(escalations.filter((s) => s > 3 * 3600).length).toBeGreaterThanOrEqual(4);
    expect(run.repages).toEqual(escalations);
  }, 120_000);

  it('at most N re-pages an hour reach a person however many real alerts are open, and every one of them keeps being paged', async () => {
    process.env['OPS_ALERT_REPAGE_MAX_PER_HOUR'] = '4';
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    // five real pages opened a few minutes apart: left alone, they escalate out of step
    const pages: string[] = [];
    for (let i = 0; i < 5; i += 1) pages.push(await open(mine, 'PLATFORM', at(t0, i * 170), [responder]));
    resetDevChannelLog();
    const run = await series(t0, mine, responder, 700, 3 * 3600 + 700, 10);
    expect(maxPerHour(run.repages)).toBeLessThanOrEqual(4);
    expect(run.repages.length).toBeGreaterThanOrEqual(10);
    expect(maxPerHour(run.texts)).toBeLessThanOrEqual(4);
    expect(run.texts.length).toBeGreaterThanOrEqual(10);
    // nobody was dropped: every page's escalations kept reaching the person, in a collapsed push
    for (const id of pages) {
      expect(run.escalated.get(id)!.length).toBeGreaterThanOrEqual(6);
      const covering = repagesTo(responder).filter((e) => (e.data!['opsAlertIds'] as string[]).includes(id));
      expect(covering.length, id).toBeGreaterThanOrEqual(5);
    }
  }, 120_000);

  it('the first escalation of an SOS is never held back by the per-person spacing', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    await open(mine, 'PLATFORM', t0, [responder]);
    await sweep(at(t0, 130), mine); // the platform page re-pages the person at +130 s
    expect(repagesTo(responder)).toHaveLength(1);
    const sos = await open(mine, 'SOS', at(t0, 140), [responder]);
    const res = await sweep(at(t0, 270), mine); // 140 s after the last re-page: inside the spacing
    expect(res.escalated).toEqual([sos]);
    expect(repagesTo(responder)).toHaveLength(2);
    expect(repagesTo(responder).at(-1)!.data!['opsAlertId']).toBe(sos);
    // a second-level re-page of the same SOS waits its turn like any other
    const later = await sweep(at(t0, 570), mine);
    expect(later.escalated).toContain(sos);
    expect(repagesTo(responder)).toHaveLength(3);
  });
});

describe('[DRILL-STORM 3] many old open alerts never produce a burst', () => {
  it('a backlog of old open alerts never starves a new one: the sweep takes never-escalated alerts first', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    // ten old pages, escalated a minute ago (not due again), older deadlines than the new page
    for (let i = 0; i < 10; i += 1) await legacy(mine, 'PLATFORM', { createdAt: at(t0, -86_400 - i * 60), level: 3, lastEscalatedAt: at(t0, -60), recipients: [responder] });
    const fresh = await open(mine, 'SOS', at(t0, -200), [responder]);
    const res = await runWithoutTenant(() => escalateOverdueOpsAlerts(app.prisma, notifications(), getChannels().sms, { now: t0, limit: 5, alertIds: mine }), 'test:drill-storm');
    expect(res.escalated).toEqual([fresh]);
  });


  it('the first sweep re-pages each person ONCE and texts on-call ONCE, closes the old drills with ONE summary, and an hour of sweeps stays inside the cap', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    // as staging was found: weekly drills open for weeks, at thousands of escalations
    const drills = [
      await legacy(mine, 'DRILL', { createdAt: at(t0, -31 * 86_400), level: 8932, lastEscalatedAt: at(t0, -400), recipients: [responder] }),
      await legacy(mine, 'DRILL', { createdAt: at(t0, -17 * 86_400), level: 4976, lastEscalatedAt: at(t0, -250), recipients: [responder] }),
      await legacy(mine, 'DRILL', { createdAt: at(t0, -3 * 86_400), level: 1020, lastEscalatedAt: at(t0, -100), recipients: [responder] }),
    ];
    // twenty pages nobody ever escalated (all due now), and forty out of step at the 30-minute ceiling
    const fresh: string[] = []; const stepped: string[] = [];
    for (let i = 0; i < 20; i += 1) fresh.push(await legacy(mine, i === 0 ? 'SOS' : 'PLATFORM', { createdAt: at(t0, -3_600 - i * 60), level: 0, lastEscalatedAt: null, recipients: [responder] }));
    for (let i = 0; i < 40; i += 1) stepped.push(await legacy(mine, 'PLATFORM', { createdAt: at(t0, -86_400), level: 6, lastEscalatedAt: at(t0, -1_740 + 45 * i), pagedAt: at(t0, -7_200), recipients: [responder] }));

    const p0 = repagesTo(responder).length; const x0 = textsToOncall().length;
    const first = await sweep(t0, mine);
    expect([...first.drillsFailed].sort()).toEqual([...drills].sort());
    expect([...first.escalated].sort()).toEqual([...fresh].sort());
    // ONE re-page for twenty owed alerts, replacing the last one on the phone
    expect(repagesTo(responder).length - p0).toBe(1);
    const push = repagesTo(responder).at(-1)!;
    expect(push.title).toBe('UNACKNOWLEDGED: 20 ops alerts, including an SOS');
    expect(push.body).toContain(`Nobody has acknowledged 20 ops alerts; the oldest has waited since ${guyanaTime(at(t0, -3_600 - 19 * 60))}.`);
    expect(push.options?.collapseId).toBe('ops-alert-unacked');
    expect(push.data!['opsAlertId']).toBe(fresh[0]);
    expect(push.data!['count']).toBe(20);
    expect(textsToOncall().length - x0).toBe(1);
    expect(textsToOncall().at(-1)!.body).toContain('Swift ops: 20 ops alerts are UNACKNOWLEDGED, including an SOS.');
    expect(textsToOncall().at(-1)!.body).toContain('Acknowledge them in Mission Control > Ops alerts.');
    expect(push.body).toContain('Acknowledge them now in Mission Control > Ops alerts.');
    // ONE summary for three failed drills
    const summaries = await inbox(responder, 'ops_alert_drill_failed');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.body).toContain('3 ops alert drills were not acknowledged within 15 minutes');
    // levels the old ladder already paged are not paged again, and pay no "OVERDUE" platform page
    expect(first.platformPage.filter((id) => stepped.includes(id) || drills.includes(id))).toEqual([]);

    // an hour of sweeps every 10 s: the forty out-of-step pages would each re-page the person
    const run = await series(t0, mine, responder, 10, 3_600, 10);
    expect(run.escalated.size).toBeGreaterThanOrEqual(60);
    expect(maxPerHour([0, ...run.repages])).toBeLessThanOrEqual(12);
    expect(run.repages.length).toBeGreaterThanOrEqual(6);
    expect(maxPerHour([0, ...run.texts])).toBeLessThanOrEqual(12);
    // the inbox holds ONE escalation notice for the person, updated in place, and one drill summary
    expect(await inbox(responder, 'ops_alert_escalated')).toHaveLength(1);
    expect(await inbox(responder, 'ops_alert_drill_failed')).toHaveLength(1);
  }, 120_000);
});

describe('[DRILL-STORM · console] an acknowledgement is audited', () => {
  it('the acknowledgement writes who acknowledged which page to the append-only audit log, in the same transaction as the receipt', async () => {
    const t0 = epoch(); const mine: string[] = [];
    const responder = await person();
    const page = await open(mine, 'PLATFORM', t0, [responder]);
    const res = await app.inject({ method: 'POST', url: `/api/v1/safety/ops-alerts/${page}/ack`, headers: { authorization: `Bearer ${responder.token}`, 'content-type': 'application/json' }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.acknowledged).toBe(true);
    const audit = await runWithoutTenant(() => app.prisma.auditLog.findMany({ where: { entity: 'OpsAlert', entityId: page } }), 'test-read:drill-storm');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: responder.userId, action: 'OPS_ALERT_ACKNOWLEDGED' });
    expect(audit[0]!.changes).toMatchObject({ kind: 'PLATFORM', sosAlertId: null, tenantId: null });
    // a second acknowledgement acknowledges nothing and audits nothing
    const again = await app.inject({ method: 'POST', url: `/api/v1/safety/ops-alerts/${page}/ack`, headers: { authorization: `Bearer ${responder.token}`, 'content-type': 'application/json' }, payload: {} });
    expect(again.json().data.acknowledged).toBe(false);
    expect(await runWithoutTenant(() => app.prisma.auditLog.count({ where: { entity: 'OpsAlert', entityId: page } }), 'test-read:drill-storm')).toBe(1);
  });
});

describe('[DRILL-STORM · console] times read in Guyana time, never raw UTC', () => {
  it('a moment is written as the responder reads it, in plain ASCII', () => {
    expect(guyanaTime(new Date('2026-10-25T16:35:30.000Z'))).toBe('25 Oct, 12:35 pm Guyana time');
    expect(guyanaTime(new Date('2026-10-25T04:05:00.000Z'))).toBe('25 Oct, 12:05 am Guyana time');
    expect(guyanaTime(new Date('2026-10-25T03:59:00.000Z'))).toBe('24 Oct, 11:59 pm Guyana time');
    expect(/^[\x20-\x7e]+$/.test(guyanaTime(new Date()))).toBe(true);
  });
});
