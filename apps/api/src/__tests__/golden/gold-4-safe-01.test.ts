import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { safetyRoutes } from '../../modules/safety/safety.routes';
import { registerErrorHandler } from '../../middleware/error-handler';
import { drainSosEscalations } from '../../modules/safety/sos-escalation';
import { devChannelLog, getChannels, resetDevChannelLog } from '../../providers/notifications/channels';

// ---------------------------------------------------------------------------
// GOLD-4 · SAFE-01 — the SOS golden journey, through the REAL mounted safety
// routes as real role sessions, asserted on durable rows:
//   · a participant raises an SOS on a service job in tenant B (grace → confirm)
//   · the ops page and the contact fan-out are tenant-scoped: tenant B's admin
//     and platform responders are paged, another tenant's admin is not; only
//     the actor's VERIFIED contacts are texted; the counterparty is never told
//   · tenant ops acknowledges and resolves; another tenant's admin and a
//     non-ops caller are refused; the contact receives the all-clear
//   · a double trigger with one idempotency key is ONE alert, and the same key
//     from another person never suppresses that person's alert
//   · the SMS provider failing mid-escalation retries with backoff to exactly
//     one send, and the alert and its ops page are never dropped
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
const TENANT_B = `gold4-safe01-${nanoid(6)}`;
const createdUserIds: string[] = [];
const createdJobIds: string[] = [];
const alertIds: string[] = [];
let seq = 0;
let contactSeq = 0;
// This file's own ranges — users +59202417nnn, emergency contacts +59202419… —
// audited against every phone literal, purge prefix and random phone range
// under apps/api/src.
const PHONE_PREFIX = '+59202417';
const CONTACT_PREFIX = '+59202419';
// The contact handshake allows one code per phone per minute; a per-run tag
// keeps an immediate local re-run from reusing the last run's numbers.
const CONTACT_RUN_TAG = String(100 + Math.floor(Math.random() * 900));

type Actor = { userId: string; token: string };

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole, tenantId = 'swift-default'): Promise<Actor> {
  seq += 1;
  const user = await runWithoutTenant(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Gol4',
      lastName: `Safe01U${seq}`,
      roles,
      activeRole,
      tenantId,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  // Privileged sessions (ADMIN/SUPER_ADMIN) need OTP assurance or auth refuses
  // them at every route.
  await runWithoutTenant(() => app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: 'gold4-safe01',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
      authMethod: roles.some((r) => r === 'ADMIN' || r === 'SUPER_ADMIN') ? 'OTP' : 'LEGACY',
    },
  }));
  return { userId: user.id, token };
}

function post(url: string, payload?: unknown, token?: string) {
  return app.inject({
    method: 'POST',
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

/** Add an emergency contact through the real route; VERIFY it through the
 *  real handshake unless told not to (the code is read from the dev SMS log). */
async function addContact(actor: Actor, name: string, opts: { verify: boolean } = { verify: true }) {
  contactSeq += 1;
  const phone = `${CONTACT_PREFIX}${CONTACT_RUN_TAG}${String(contactSeq).padStart(2, '0')}`;
  const added = await post('/api/v1/safety/emergency-contacts', { name, phoneE164: phone }, actor.token);
  expect(added.statusCode).toBe(200);
  expect(added.json().data.codeSent).toBe(true);
  const id = added.json().data.id as string;
  if (opts.verify) {
    const sms = [...devChannelLog].reverse().find((e) => e.channel === 'sms' && e.to === phone);
    const code = sms?.body.match(/code (\d{6})/)?.[1];
    expect(code).toBeTruthy();
    const verified = await post(`/api/v1/safety/emergency-contacts/${id}/verify`, { code }, actor.token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json().data.verifiedAt).toBeTruthy();
  }
  return { id, phone };
}

/** Service-job scaffolding in tenant B (the request/quote journey is SERV-02's). */
async function makeJob(customerId: string, providerId: string, description: string) {
  const job = await runWithoutTenant(() => app.prisma.serviceJob.create({
    data: { tenantId: TENANT_B, customerId, providerId, description, status: 'REQUESTED' },
  }));
  createdJobIds.push(job.id);
  return job;
}

/** Drive the mounted trigger (and the owner confirm when a grace window
 *  applies) so the alert is ACTIVE whatever SOS_CANCEL_GRACE_SECONDS says. */
async function raiseAndActivate(token: string, body: Record<string, unknown>): Promise<string> {
  const raised = await post('/api/v1/safety/sos', body, token);
  expect(raised.statusCode).toBe(200);
  const data = raised.json().data as { id: string; status: string; graceEndsAt?: string };
  alertIds.push(data.id);
  if (data.status === 'TRIGGER_PENDING') {
    expect(data.graceEndsAt).toBeTruthy();
    const confirmed = await post(`/api/v1/safety/sos/${data.id}/confirm`, {}, token);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().data.status).toBe('ACTIVE');
  } else {
    expect(data.status).toBe('ACTIVE');
  }
  return data.id;
}

const alertRow = (id: string) => runWithoutTenant(() => app.prisma.sosAlert.findUniqueOrThrow({ where: { id } }));
const escalationsOf = (id: string) => runWithoutTenant(() => app.prisma.sosEscalation.findMany({ where: { sosAlertId: id } }));
const smsTo = (phone: string, contains: string) => devChannelLog.filter((e) => e.channel === 'sms' && e.to === phone && e.body.includes(contains));
/** Inbox rows that reference one alert (ops pages carry data.sosAlertId). */
const notificationsAbout = (sosAlertId: string, userId?: string) => runWithoutTenant(() => app.prisma.notification.findMany({
  where: { ...(userId ? { userId } : {}), data: { path: ['sosAlertId'], equals: sosAlertId } },
}));

async function purgeFixtures() {
  await runWithoutTenant(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const userIds = [...new Set([...createdUserIds, ...users.map((u) => u.id)])];
    const jobs = await app.prisma.serviceJob.findMany({
      where: { OR: [{ customerId: { in: userIds } }, { tenantId: TENANT_B }] },
      select: { id: true },
    });
    const jobIds = [...new Set([...createdJobIds, ...jobs.map((j) => j.id)])];
    const alerts = await app.prisma.sosAlert.findMany({
      where: { OR: [{ actorUserId: { in: userIds } }, { counterpartyUserId: { in: userIds } }, { serviceJobId: { in: jobIds } }] },
      select: { id: true },
    });
    const allAlertIds = [...new Set([...alertIds, ...alerts.map((a) => a.id)])];
    if (allAlertIds.length) {
      // Ops pages also reach platform responders this file did not create
      // (every SUPER_ADMIN is paged for every tenant) — remove exactly the
      // inbox rows that reference this file's alerts.
      await app.prisma.notification.deleteMany({
        where: { OR: allAlertIds.map((id) => ({ data: { path: ['sosAlertId'], equals: id } })) },
      });
      await app.prisma.evidenceBundle.deleteMany({ where: { sosAlertId: { in: allAlertIds } } });
      await app.prisma.opsAlert.deleteMany({ where: { sosAlertId: { in: allAlertIds } } });
      await app.prisma.sosAlert.deleteMany({ where: { id: { in: allAlertIds } } });
    }
    await app.prisma.emergencyContact.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.serviceJob.deleteMany({ where: { id: { in: jobIds } } });
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    createdUserIds.length = 0;
    createdJobIds.length = 0;
    alertIds.length = 0;
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_B } });
  });
}

let customerA: Actor;
let providerP: Actor;
let adminB: Actor;
let defaultAdmin: Actor;
let platform: Actor;
let providerRowId: string;
let jobId: string;
let contact: { id: string; phone: string };
let unverified: { id: string; phone: string };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  // Keep the shared daily SMS budget out of the way — this suite exercises the
  // contact handshake, not the budget ceiling.
  process.env['OTP_PHONE_DAILY_CAP'] = '1000';
  process.env['OTP_GLOBAL_DAILY_CAP'] = '1000000';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  // The production composition root (app.ts) gives every request a fresh
  // tenant store before auth — replicate it.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
  // Every SMS in this file must land in the dev adapter's log, never a real
  // provider: the provider-failure test wraps that one adapter.
  expect(getChannels().sms).toBe(getChannels().sms);

  await purgeFixtures();
  await runWithoutTenant(() => app.prisma.tenant.create({
    data: { id: TENANT_B, name: 'Gold4 Safe01 Tenant', slug: TENANT_B },
  }));

  customerA = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER', TENANT_B);
  providerP = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER', TENANT_B);
  adminB = await makeUserWithSession(['ADMIN'], 'ADMIN', TENANT_B);
  defaultAdmin = await makeUserWithSession(['ADMIN'], 'ADMIN', 'swift-default');
  platform = await makeUserWithSession(['SUPER_ADMIN'], 'SUPER_ADMIN', 'swift-default');

  const providerRow = await runWithoutTenant(() => app.prisma.serviceProvider.create({
    data: { userId: providerP.userId, trade: 'plumber', isVerified: true },
  }));
  providerRowId = providerRow.id;
  jobId = (await makeJob(customerA.userId, providerRowId, 'Fix the burst pipe in the kitchen')).id;
  contact = await addContact(customerA, 'Mother');
  unverified = await addContact(customerA, 'Neighbour', { verify: false });
});

beforeEach(() => resetDevChannelLog());

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('GOLD-4 · SAFE-01 — SOS: trigger, tenant-scoped ops/contact rows, ack/resolve', () => {
  it('a participant raises the SOS; the page and contact fan-out are tenant-scoped; tenant ops acknowledges and resolves', async () => {
    const alertId = await raiseAndActivate(customerA.token, {
      serviceJobId: jobId,
      lat: 6.8011,
      lng: -58.1533,
      accuracyM: 12,
      addressText: '1 Carmichael Street',
      clientIdempotencyKey: `gold4-safe01-cust-${nanoid(8)}`,
    });

    // The alert routes to the JOB's tenant and names the provider as counterparty.
    const alert = await alertRow(alertId);
    expect(alert.status).toBe('ACTIVE');
    expect(alert.tenantId).toBe(TENANT_B);
    expect(alert.actorUserId).toBe(customerA.userId);
    expect(alert.serviceJobId).toBe(jobId);
    expect(alert.counterpartyUserId).toBe(providerP.userId);
    expect(alert.triggerSource).toBe('BUTTON');

    // The delivery policy landed through the durable outbox: one row per
    // required delivery, tenant-stamped, each delivered on its first attempt.
    // Exactly ONE contact row — the unverified contact is not part of it.
    const rows = await escalationsOf(alertId);
    expect(rows.map((r) => `${r.channel}:${r.status}`).sort()).toEqual([
      'CONTACT_SMS:SENT', 'EVIDENCE:SENT', 'OPS_PAGE:SENT', 'WAR_ROOM:SENT',
    ]);
    expect(rows.every((r) => r.tenantId === TENANT_B && r.attempts === 1)).toBe(true);
    const contactRow = rows.find((r) => r.channel === 'CONTACT_SMS')!;
    expect(contactRow.targetKey).toBe(contact.id);
    expect(contactRow.receipt).toMatchObject({ id: contact.id, ok: true });
    expect(await runWithoutTenant(() => app.prisma.evidenceBundle.findUnique({ where: { sosAlertId: alertId } }))).not.toBeNull();

    // The contacts are tenant B's rows; only the VERIFIED one was texted, and
    // the text carries the person's live location.
    const contactRows = await runWithoutTenant(() => app.prisma.emergencyContact.findMany({ where: { userId: customerA.userId } }));
    expect(contactRows.map((c) => c.tenantId)).toEqual([TENANT_B, TENANT_B]);
    expect(smsTo(contact.phone, 'emergency SOS')).toHaveLength(1);
    expect(smsTo(contact.phone, 'emergency SOS')[0]!.body).toContain('q=6.8011,-58.1533');
    expect(devChannelLog.filter((e) => e.to === unverified.phone)).toHaveLength(0);

    // The OPS page is tenant-scoped: tenant B's admin and the platform
    // responder are paged; another tenant's plain admin is not; and EVERY
    // recipient is either an admin of tenant B or a platform SUPER_ADMIN.
    const page = await runWithoutTenant(() => app.prisma.opsAlert.findFirstOrThrow({
      where: { sosAlertId: alertId },
      include: { recipients: true },
    }));
    expect(page.tenantId).toBe(TENANT_B);
    expect(page.kind).toBe('SOS');
    const recipientIds = page.recipients.map((r) => r.userId);
    expect(recipientIds).toContain(adminB.userId);
    expect(recipientIds).toContain(platform.userId);
    expect(recipientIds).not.toContain(defaultAdmin.userId);
    const recipients = await runWithoutTenant(() => app.prisma.user.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true, tenantId: true, roles: true },
    }));
    expect(recipients).toHaveLength(recipientIds.length);
    for (const r of recipients) {
      expect((r.tenantId === TENANT_B && r.roles.includes('ADMIN')) || r.roles.includes('SUPER_ADMIN')).toBe(true);
    }
    // The counterparty is never told (do not tip off a possible attacker).
    expect(await notificationsAbout(alertId, providerP.userId)).toHaveLength(0);

    // The MOUNTED reads agree: tenant B's admin sees the page and the alert;
    // the other tenant's admin sees neither and cannot open it (404, no
    // oracle); the platform responder can — the one sanctioned exception.
    const bOpsList = await get('/api/v1/safety/ops-alerts', adminB.token);
    expect(bOpsList.statusCode).toBe(200);
    expect((bOpsList.json().data as Array<{ id: string }>).some((row) => row.id === page.id)).toBe(true);
    const dOpsList = await get('/api/v1/safety/ops-alerts', defaultAdmin.token);
    expect(dOpsList.statusCode).toBe(200);
    expect((dOpsList.json().data as Array<{ id: string }>).some((row) => row.id === page.id)).toBe(false);
    expect(((await get('/api/v1/safety/sos', adminB.token)).json().data as Array<{ id: string }>).some((row) => row.id === alertId)).toBe(true);
    expect(((await get('/api/v1/safety/sos', defaultAdmin.token)).json().data as Array<{ id: string }>).some((row) => row.id === alertId)).toBe(false);
    expect((await get(`/api/v1/safety/sos/${alertId}`, adminB.token)).statusCode).toBe(200);
    expect((await get(`/api/v1/safety/sos/${alertId}`, defaultAdmin.token)).statusCode).toBe(404);
    expect((await get(`/api/v1/safety/sos/${alertId}`, platform.token)).statusCode).toBe(200);
    expect((await get('/api/v1/safety/ops-alerts', customerA.token)).statusCode).toBe(403);

    // A non-ops caller cannot acknowledge; another tenant's admin can neither
    // acknowledge nor resolve — and the alert is untouched by all three.
    expect((await post(`/api/v1/safety/sos/${alertId}/ack`, {}, customerA.token)).statusCode).toBe(403);
    expect((await post(`/api/v1/safety/sos/${alertId}/ack`, {}, defaultAdmin.token)).statusCode).toBe(404);
    expect((await post(`/api/v1/safety/sos/${alertId}/resolve`, { resolutionCode: 'FALSE_ALARM' }, defaultAdmin.token)).statusCode).toBe(404);
    const untouched = await alertRow(alertId);
    expect(untouched.status).toBe('ACTIVE');
    expect(untouched.acknowledgedBy).toBeNull();
    expect(untouched.resolutionCode).toBeNull();

    // Tenant ops acknowledges — the SOS row AND the durable page obligation.
    const acked = await post(`/api/v1/safety/sos/${alertId}/ack`, {}, adminB.token);
    expect(acked.statusCode).toBe(200);
    expect(acked.json().data.status).toBe('ACKNOWLEDGED');
    const afterAck = await alertRow(alertId);
    expect(afterAck.status).toBe('ACKNOWLEDGED');
    expect(afterAck.acknowledgedBy).toBe(adminB.userId);
    expect(afterAck.acknowledgedAt).toBeInstanceOf(Date);
    const pageAcked = await runWithoutTenant(() => app.prisma.opsAlert.findUniqueOrThrow({ where: { id: page.id }, include: { recipients: true } }));
    expect(pageAcked.acknowledgedBy).toBe(adminB.userId);
    expect(pageAcked.acknowledgedAt).toBeInstanceOf(Date);
    expect(pageAcked.recipients.find((r) => r.userId === adminB.userId)!.ackedAt).toBeInstanceOf(Date);

    // Tenant ops resolves with a code; the loop closes durably and the
    // contact who was alarmed receives the all-clear (the unverified one,
    // who was never alarmed, receives nothing).
    const resolved = await post(`/api/v1/safety/sos/${alertId}/resolve`, {
      resolutionCode: 'SAFE_CONFIRMED',
      notes: 'Called back — everyone is safe',
    }, adminB.token);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().data.status).toBe('RESOLVED');
    const afterResolve = await alertRow(alertId);
    expect(afterResolve.status).toBe('RESOLVED');
    expect(afterResolve.resolutionCode).toBe('SAFE_CONFIRMED');
    expect(afterResolve.resolvedBy).toBe(adminB.userId);
    expect(afterResolve.resolvedAt).toBeInstanceOf(Date);
    expect(smsTo(contact.phone, 'closed by our safety team')).toHaveLength(1);
    expect((afterResolve.deliveryReceipts as { resolvedNotice?: unknown }).resolvedNotice).toEqual([{ id: contact.id, ok: true }]);
    expect(devChannelLog.filter((e) => e.to === unverified.phone)).toHaveLength(0);
  });
});

describe('GOLD-4 · SAFE-01 — a double trigger collapses to one alert', () => {
  it('the same idempotency key replays the SAME alert; the same key from another person is theirs alone; a keyless repeat appends facts and re-pages', async () => {
    const actor = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER', TENANT_B);
    const job = await makeJob(actor.userId, providerRowId, 'Unblock the kitchen drain');
    const key = `gold4-safe01-dedupe-${nanoid(8)}`;
    const press = { serviceJobId: job.id, lat: 6.8, lng: -58.15, clientIdempotencyKey: key };

    const first = await post('/api/v1/safety/sos', press, actor.token);
    expect(first.statusCode).toBe(200);
    const firstId = (first.json().data as { id: string }).id;
    alertIds.push(firstId);
    const rowsAfterFirst = (await escalationsOf(firstId)).length;

    // The DOUBLE TRIGGER — same person, same key, same context.
    const second = await post('/api/v1/safety/sos', press, actor.token);
    expect(second.statusCode).toBe(200);
    expect((second.json().data as { id: string }).id).toBe(firstId);
    expect(await runWithoutTenant(() => app.prisma.sosAlert.count({ where: { actorUserId: actor.userId } }))).toBe(1);
    const replay = await alertRow(firstId);
    expect(replay.clientIdempotencyKey).toBe(`client:${key}`);
    expect(replay.retriggerCount).toBe(0);
    expect(await runWithoutTenant(() => app.prisma.sosRetrigger.count({ where: { sosAlertId: firstId } }))).toBe(0);
    expect(await escalationsOf(firstId)).toHaveLength(rowsAfterFirst);

    // The SAME key from the other participant on the same job is that
    // person's own emergency: a key never collapses into, or suppresses,
    // someone else's alert.
    const other = await post('/api/v1/safety/sos', press, providerP.token);
    expect(other.statusCode).toBe(200);
    const otherId = (other.json().data as { id: string }).id;
    alertIds.push(otherId);
    expect(otherId).not.toBe(firstId);
    expect((await alertRow(otherId)).actorUserId).toBe(providerP.userId);
    expect((await alertRow(firstId)).retriggerCount).toBe(0);

    // Once ACTIVE, a keyless repeat on the SAME live context collapses too:
    // one row, the new position carried forward as a numbered fact, and a
    // fresh re-page staged and delivered.
    if (replay.status === 'TRIGGER_PENDING') {
      const confirmed = await post(`/api/v1/safety/sos/${firstId}/confirm`, {}, actor.token);
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().data.status).toBe('ACTIVE');
    }
    const third = await post('/api/v1/safety/sos', {
      serviceJobId: job.id,
      lat: 6.801,
      lng: -58.151,
      addressText: 'Moved to the back yard',
    }, actor.token);
    expect(third.statusCode).toBe(200);
    expect((third.json().data as { id: string }).id).toBe(firstId);
    expect(await runWithoutTenant(() => app.prisma.sosAlert.count({ where: { actorUserId: actor.userId } }))).toBe(1);

    const merged = await alertRow(firstId);
    expect(merged.retriggerCount).toBe(1);
    expect(merged.triggerLat).toBe(6.801);
    expect(merged.triggerLng).toBe(-58.151);
    const retriggers = await runWithoutTenant(() => app.prisma.sosRetrigger.findMany({ where: { sosAlertId: firstId } }));
    expect(retriggers).toHaveLength(1);
    expect(retriggers[0]).toMatchObject({ seq: 1, tenantId: TENANT_B, lat: 6.801, lng: -58.151, addressText: 'Moved to the back yard' });
    const repages = (await escalationsOf(firstId)).filter((r) => r.targetKey.includes(':repage:'));
    expect(repages.map((r) => `${r.channel}:${r.targetKey}:${r.status}`).sort()).toEqual([
      'OPS_PAGE:ops:repage:1:SENT', 'WAR_ROOM:war-room:repage:1:SENT',
    ]);
  });
});

describe('GOLD-4 · SAFE-01 — provider failure retries without dropping the alert', () => {
  it('the SMS provider fails mid-escalation: the row backs off, the alert and its page stand, and the retry sends exactly once', async () => {
    const actor = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER', TENANT_B);
    const brother = await addContact(actor, 'Brother');
    const job = await makeJob(actor.userId, providerRowId, 'Check the water heater');
    resetDevChannelLog();

    // The SMS provider is down for this contact's FIRST emergency text. The
    // outage is injected at the provider boundary (the adapter every send goes
    // through); the trigger, confirm and escalation are the real paths.
    const sms = getChannels().sms;
    const sendSms = sms.sendSms.bind(sms);
    let outages = 0;
    const outage = vi.spyOn(sms, 'sendSms').mockImplementation(async (to: string, body: string) => {
      if (to === brother.phone && body.includes('emergency SOS') && outages === 0) {
        outages += 1;
        throw new Error('sms gateway 503');
      }
      return sendSms(to, body);
    });
    try {
      const alertId = await raiseAndActivate(actor.token, { serviceJobId: job.id, lat: 6.802, lng: -58.152 });
      expect(outages).toBe(1);

      // The failed delivery keeps its row: PENDING, attempt counted, the error
      // recorded, the next attempt pushed out on the database clock.
      const failedRow = await runWithoutTenant(() => app.prisma.sosEscalation.findFirstOrThrow({
        where: { sosAlertId: alertId, channel: 'CONTACT_SMS', targetKey: brother.id },
      }));
      expect(failedRow.status).toBe('PENDING');
      expect(failedRow.attempts).toBe(1);
      expect(failedRow.lastError).toContain('sms gateway 503');
      expect(failedRow.availableAt.getTime()).toBeGreaterThan(failedRow.updatedAt.getTime());

      // THE ALERT IS NOT DROPPED: still ACTIVE, every other delivery landed,
      // the ops page is open, and nothing reached the contact.
      expect((await alertRow(alertId)).status).toBe('ACTIVE');
      const others = (await escalationsOf(alertId)).filter((r) => r.channel !== 'CONTACT_SMS');
      expect(others.map((r) => `${r.channel}:${r.status}`).sort()).toEqual(['EVIDENCE:SENT', 'OPS_PAGE:SENT', 'WAR_ROOM:SENT']);
      const pageDuring = await runWithoutTenant(() => app.prisma.opsAlert.findFirstOrThrow({ where: { sosAlertId: alertId } }));
      expect(pageDuring.acknowledgedAt).toBeNull();
      expect(pageDuring.closedAt).toBeNull();
      expect(smsTo(brother.phone, 'emergency SOS')).toHaveLength(0);

      // A worker tick inside the backoff window does not hammer the provider.
      const early = await drainSosEscalations(app.prisma, app.io, { alertIds: [alertId] });
      expect(early.delivered + early.failed).toBe(0);
      expect((await runWithoutTenant(() => app.prisma.sosEscalation.findUniqueOrThrow({ where: { id: failedRow.id } }))).attempts).toBe(1);

      // The backoff elapses (moved onto the past rather than slept through)
      // and the next worker tick delivers exactly once.
      await runWithoutTenant(() => app.prisma.sosEscalation.update({ where: { id: failedRow.id }, data: { availableAt: new Date(0) } }));
      const retry = await drainSosEscalations(app.prisma, app.io, { alertIds: [alertId] });
      expect(retry).toMatchObject({ delivered: 1, failed: 0 });
      const doneRow = await runWithoutTenant(() => app.prisma.sosEscalation.findUniqueOrThrow({ where: { id: failedRow.id } }));
      expect(doneRow.status).toBe('SENT');
      expect(doneRow.attempts).toBe(2);
      expect(doneRow.lastError).toBeNull();
      expect(doneRow.receipt).toMatchObject({ id: brother.id, ok: true });
      expect(smsTo(brother.phone, 'emergency SOS')).toHaveLength(1);
      const after = await alertRow(alertId);
      expect(after.status).toBe('ACTIVE');
      expect((after.deliveryReceipts as { contacts?: unknown }).contacts).toEqual([{ id: brother.id, ok: true }]);

      // Nothing is left to deliver: a further tick sends nothing twice.
      const idle = await drainSosEscalations(app.prisma, app.io, { alertIds: [alertId] });
      expect(idle.delivered + idle.failed).toBe(0);
      expect(smsTo(brother.phone, 'emergency SOS')).toHaveLength(1);
    } finally {
      outage.mockRestore();
    }
  });
});
