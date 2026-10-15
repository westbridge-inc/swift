/**
 * [R23 · research C1 · owner retention table] THE OWNER'S RETENTION CLOCKS, ENFORCED.
 *
 *  - Order chat: deleted 1 year after the order (or service job) ended, photos included,
 *    unless the order is linked to a claim (support ticket, safety case, refund, return, …),
 *    the message was reported, or a person in the chat is under a legal hold.
 *  - Support tickets: resolved ones deleted 3 years after resolution; safety tickets follow
 *    the safety clock; open tickets are never deleted.
 *  - Safety records: closed SOS alerts (with their escalation rows and the operations page),
 *    closed incident cases and resolved safety tickets, 7 years after closing; never one with
 *    evidence or a legal hold, and nothing at all while any legal hold is partial.
 *
 * Each clock is a registry row (retention_policies) enforced by the daily sweep, and each run
 * writes its own receipt (retention_sweep_receipts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { RETENTION_DEFAULTS, seedRetentionDefaults, runRetentionSweep } from '../modules/compliance/retention.service';
import { getStorageProvider } from '../providers/storage/storage-provider';
import { uniquePng } from './helpers/real-image';

const DAY = 86_400_000;
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
let app: FastifyInstance;
const users: string[] = [];
const orders: string[] = [];
const rooms: string[] = [];
const alerts: string[] = [];
const cases: string[] = [];
let seq = 0;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'retention-clocks-r23-test');
const ago = (days: number) => new Date(Date.now() - days * DAY);

async function person() {
  seq += 1;
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59278${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Clock', lastName: `R23x${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    isPhoneVerified: true, customer: { create: {} },
  } }));
  users.push(u.id);
  return u.id;
}

/** An order in `status` whose last change was `endedDaysAgo` days ago. */
async function order(customerId: string, status: 'DELIVERED' | 'CANCELLED' | 'PREPARING', endedDaysAgo: number) {
  const o = await system(() => app.prisma.order.create({ data: {
    orderNumber: `R23-${RUN}-${nanoid(6)}`, customerId, orderType: 'TAXI', status,
    pickupLat: 6.8, pickupLng: -58.15, deliveryLat: 6.82, deliveryLng: -58.17, pickupAddress: 'pickup fixture', deliveryAddress: 'destination fixture',
    subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, totalAmount: 1500, deliveryFee: 0, paymentMethod: 'CASH',
  } }));
  orders.push(o.id);
  const ended = ago(endedDaysAgo);
  await system(() => app.prisma.$executeRaw`UPDATE orders SET "updatedAt" = ${ended},
    "deliveredAt" = CASE WHEN status = 'DELIVERED' THEN ${ended} ELSE NULL END,
    "cancelledAt" = CASE WHEN status = 'CANCELLED' THEN ${ended} ELSE NULL END WHERE id = ${o.id}`);
  return o.id;
}

/** A chat on the order with `n` messages written `daysAgo` days ago (the first with a stored photo when asked). */
async function chat(orderId: string, members: string[], daysAgo: number, opts: { photo?: boolean } = {}) {
  const room = await system(() => app.prisma.chatRoom.create({ data: {
    orderId, participants: { create: members.map((userId, i) => ({ userId, role: i === 0 ? 'customer' : 'driver' })) },
  } }));
  rooms.push(room.id);
  let photo: string | null = null;
  if (opts.photo) {
    photo = (await getStorageProvider().upload({ buffer: uniquePng(`r23 ${RUN} ${room.id}`), filename: 'photo.png', mimeType: 'image/png', folder: `chat/${room.id}` })).url;
  }
  const first = await system(() => app.prisma.chatMessage.create({ data: {
    chatRoomId: room.id, senderId: members[0]!, message: 'old chat fixture', messageType: photo ? 'image' : 'text', mediaUrl: photo, createdAt: ago(daysAgo),
  } }));
  const second = await system(() => app.prisma.chatMessage.create({ data: {
    chatRoomId: room.id, senderId: members[members.length - 1]!, message: 'old reply fixture', createdAt: ago(daysAgo),
  } }));
  return { roomId: room.id, messageIds: [first.id, second.id], photo };
}

const messagesIn = (roomId: string) => system(() => app.prisma.chatMessage.count({ where: { chatRoomId: roomId } }));

async function ticket(userId: string, input: { category: 'ORDER_ISSUE' | 'SAFETY'; status: 'OPEN' | 'RESOLVED'; daysAgo: number; orderId?: string }) {
  const t = await system(() => app.prisma.supportTicket.create({ data: {
    userId, orderId: input.orderId ?? null, category: input.category, subject: `r23 ${RUN}`, message: 'ticket fixture', status: input.status,
    ...(input.status === 'RESOLVED' ? { resolution: input.category === 'SAFETY' ? 'NO_RISK_FOUND' : 'ANSWERED' } : {}),
  } }));
  const at = ago(input.daysAgo);
  await system(() => app.prisma.$executeRaw`UPDATE support_tickets SET "updatedAt" = ${at},
    "resolvedAt" = CASE WHEN status = 'RESOLVED' THEN ${at} ELSE NULL END, "createdAt" = ${at} WHERE id = ${t.id}`);
  return t.id;
}
const ticketExists = async (id: string) => (await system(() => app.prisma.supportTicket.findUnique({ where: { id } }))) !== null;

async function sosAlert(userId: string, closedDaysAgo: number) {
  const a = await system(() => app.prisma.sosAlert.create({ data: {
    actorUserId: userId, actorRole: 'CUSTOMER', status: 'RESOLVED', triggeredAt: ago(closedDaysAgo + 1), resolvedAt: ago(closedDaysAgo),
  } }));
  alerts.push(a.id);
  return a.id;
}
const alertExists = async (id: string) => (await system(() => app.prisma.sosAlert.findUnique({ where: { id } }))) !== null;

async function incident(subjectUserId: string, closedDaysAgo: number, extra: { legalHold?: boolean } = {}) {
  const c = await system(() => app.prisma.incidentCase.create({ data: {
    caseNumber: `INC-R23${nanoid(6)}`, severity: 'S3', category: 'OTHER', intake: 'OPS_CREATED', subjectUserId, summary: 'closed case fixture',
    slaAckBy: ago(closedDaysAgo + 2), slaDecideBy: ago(closedDaysAgo + 1), status: 'CLOSED', closedAt: ago(closedDaysAgo), legalHold: extra.legalHold ?? false,
  } }));
  cases.push(c.id);
  return c.id;
}
const caseExists = async (id: string) => (await system(() => app.prisma.incidentCase.findUnique({ where: { id } }))) !== null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();
  await system(() => seedRetentionDefaults(app.prisma));
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.legalHold.deleteMany({ where: { caseId: { in: cases } } });
    await app.prisma.evidenceBundle.deleteMany({ where: { OR: [{ caseId: { in: cases } }, { sosAlertId: { in: alerts } }] } });
    await app.prisma.incidentCase.deleteMany({ where: { id: { in: cases } } });
    await app.prisma.opsAlert.deleteMany({ where: { sosAlertId: { in: alerts } } });
    await app.prisma.sosAlert.deleteMany({ where: { id: { in: alerts } } });
    await app.prisma.contentReport.deleteMany({ where: { reporterId: { in: users } } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: users } } });
    await app.prisma.chatRoom.deleteMany({ where: { id: { in: rooms } } });
    await app.prisma.supportTicket.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orders } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[R23] the owner\'s retention table is in the registry', () => {
  it('chat 1 year, resolved tickets 3 years, safety records 7 years, each enforced with a receipt', async () => {
    const byClass = Object.fromEntries(RETENTION_DEFAULTS.map((d) => [d.dataClass, d.retainDays]));
    expect(byClass).toMatchObject({ 'chat.order_messages': 365, 'support_tickets.resolved': 1095, 'safety.records': 2555 });
    const before = await system(() => app.prisma.retentionSweepReceipt.count({ where: { dataClass: { in: ['chat.order_messages', 'support_tickets.resolved', 'safety.records'] } } }));
    const results = await system(() => runRetentionSweep(app.prisma));
    for (const c of ['chat.order_messages', 'support_tickets.resolved', 'safety.records']) {
      expect(results.find((r) => r.dataClass === c), c).toMatchObject({ dataClass: c });
      expect(results.find((r) => r.dataClass === c)?.skipped, c).toBeUndefined();
    }
    const after = await system(() => app.prisma.retentionSweepReceipt.count({ where: { dataClass: { in: ['chat.order_messages', 'support_tickets.resolved', 'safety.records'] } } }));
    expect(after - before).toBe(3);
  });
});

describe('[R23] order chat: 1 year after the order ended, unless linked to a claim', () => {
  it('deletes the messages and the stored photo of a chat whose order ended over a year ago', async () => {
    const customer = await person(); const driver = await person();
    const old = await chat(await order(customer, 'DELIVERED', 400), [customer, driver], 401, { photo: true });
    const cancelled = await chat(await order(customer, 'CANCELLED', 380), [customer, driver], 381);
    await getStorageProvider().getObject(old.photo!); // the photo is there before the sweep
    const results = await system(() => runRetentionSweep(app.prisma));
    expect(results.find((r) => r.dataClass === 'chat.order_messages')!.deleted).toBeGreaterThanOrEqual(4);
    expect(await messagesIn(old.roomId)).toBe(0);
    expect(await messagesIn(cancelled.roomId)).toBe(0);
    await expect(getStorageProvider().getObject(old.photo!)).rejects.toThrow();
  });

  it('keeps: a recent order, a live order, a chat a support ticket or a safety case points at, a reported message, a person under a legal hold', async () => {
    const customer = await person(); const driver = await person();
    const recent = await chat(await order(customer, 'DELIVERED', 200), [customer, driver], 201);
    const live = await chat(await order(customer, 'PREPARING', 500), [customer, driver], 500);
    const ticketed = await order(customer, 'DELIVERED', 400);
    await ticket(customer, { category: 'ORDER_ISSUE', status: 'RESOLVED', daysAgo: 399, orderId: ticketed });
    const withTicket = await chat(ticketed, [customer, driver], 401);
    const caseOrder = await order(customer, 'DELIVERED', 400);
    const caseId = await incident(driver, 390);
    await system(() => app.prisma.incidentCase.update({ where: { id: caseId }, data: { orderId: caseOrder } }));
    const withCase = await chat(caseOrder, [customer, driver], 401);
    const reported = await chat(await order(customer, 'DELIVERED', 400), [customer, driver], 401);
    await system(() => app.prisma.contentReport.create({ data: { reporterId: driver, targetType: 'CHAT_MESSAGE', targetId: reported.messageIds[0]!, reason: 'HARASSMENT' } }));
    const heldPerson = await person();
    await system(() => app.prisma.docLegalHold.create({ data: {
      subjectUserId: heldPerson, reason: `hold ${RUN}`, ownerId: heldPerson, placedBy: heldPerson, reviewBy: new Date(Date.now() + 30 * DAY),
    } }));
    const held = await chat(await order(customer, 'DELIVERED', 400), [customer, heldPerson], 401);
    // REVIEW-F S3-1: an open money question recorded on the order row itself
    const mmgOrder = await order(customer, 'DELIVERED', 400);
    await system(() => app.prisma.$executeRaw`UPDATE orders SET "mmgClaimMismatchAt" = ${ago(400)} WHERE id = ${mmgOrder}`);
    const mmgDispute = await chat(mmgOrder, [customer, driver], 401);
    const cashOrder = await order(customer, 'DELIVERED', 400);
    await system(() => app.prisma.$executeRaw`UPDATE orders SET "doorCashReturnStatus" = 'HELD', "doorCashReturnAmount" = 1500, "doorCashReturnRecordedAt" = ${ago(400)} WHERE id = ${cashOrder}`);
    const cashHeld = await chat(cashOrder, [customer, driver], 401);

    await system(() => runRetentionSweep(app.prisma));
    expect(await messagesIn(recent.roomId)).toBe(2);
    expect(await messagesIn(live.roomId)).toBe(2);
    expect(await messagesIn(withTicket.roomId)).toBe(2);
    expect(await messagesIn(withCase.roomId)).toBe(2);
    // only the reported message is kept; its unreported neighbour goes
    expect(await system(() => app.prisma.chatMessage.findMany({ where: { chatRoomId: reported.roomId }, select: { id: true } }))).toEqual([{ id: reported.messageIds[0] }]);
    expect(await messagesIn(held.roomId)).toBe(2);
    expect(await messagesIn(mmgDispute.roomId)).toBe(2);
    expect(await messagesIn(cashHeld.roomId)).toBe(2);
  });
});

describe('[R23] support tickets: resolved ones 3 years after resolution', () => {
  it('deletes a resolved ticket past 3 years; keeps a younger one, an open one and a safety ticket', async () => {
    const u = await person();
    const due = await ticket(u, { category: 'ORDER_ISSUE', status: 'RESOLVED', daysAgo: 1200 });
    const young = await ticket(u, { category: 'ORDER_ISSUE', status: 'RESOLVED', daysAgo: 1000 });
    const open = await ticket(u, { category: 'ORDER_ISSUE', status: 'OPEN', daysAgo: 1200 });
    const safety = await ticket(u, { category: 'SAFETY', status: 'RESOLVED', daysAgo: 1200 });
    await system(() => runRetentionSweep(app.prisma));
    expect(await ticketExists(due)).toBe(false);
    expect(await ticketExists(young)).toBe(true);
    expect(await ticketExists(open)).toBe(true);
    expect(await ticketExists(safety)).toBe(true);
  });
});

describe('[R23] safety records: 7 years after closing', () => {
  it('deletes a closed SOS alert with its escalation rows and page, a closed case and a resolved safety ticket past 7 years', async () => {
    const u = await person();
    const alertId = await sosAlert(u, 2600);
    await system(() => app.prisma.sosEscalation.create({ data: { sosAlertId: alertId, channel: 'OPS_PAGE', targetKey: `r23-${RUN}` } }));
    await system(() => app.prisma.opsAlert.create({ data: { kind: 'SOS', sosAlertId: alertId, title: 'SOS fixture', body: 'fixture', ackDeadlineAt: ago(2600) } }));
    await system(() => app.prisma.$executeRaw`UPDATE ops_alerts SET "createdAt" = ${ago(2600)} WHERE "sosAlertId" = ${alertId}`);
    const caseId = await incident(u, 2600);
    const safetyTicket = await ticket(u, { category: 'SAFETY', status: 'RESOLVED', daysAgo: 2600 });
    await system(() => runRetentionSweep(app.prisma));
    expect(await alertExists(alertId)).toBe(false);
    expect(await system(() => app.prisma.sosEscalation.count({ where: { sosAlertId: alertId } }))).toBe(0);
    expect(await system(() => app.prisma.opsAlert.count({ where: { sosAlertId: alertId } }))).toBe(0);
    expect(await caseExists(caseId)).toBe(false);
    expect(await ticketExists(safetyTicket)).toBe(false);
  });

  it('keeps: a younger record, an alert with evidence, a case under a legal hold, an alert a kept case was opened from', async () => {
    const u = await person();
    const young = await sosAlert(u, 2000);
    const withEvidence = await sosAlert(u, 2600);
    await system(() => app.prisma.evidenceBundle.create({ data: { bundleNumber: `EB-R23${nanoid(6)}`, sosAlertId: withEvidence, subjectUserId: u } }));
    const heldCase = await incident(u, 2600, { legalHold: true });
    await system(() => app.prisma.legalHold.create({ data: { caseId: heldCase, placedBy: 'r23-test', reason: `hold ${RUN}` } }));
    const caseAlert = await sosAlert(u, 2600);
    const keptCase = await incident(u, 2000);
    await system(() => app.prisma.incidentCase.update({ where: { id: keptCase }, data: { sosAlertId: caseAlert } }));
    const youngTicket = await ticket(u, { category: 'SAFETY', status: 'RESOLVED', daysAgo: 2000 });
    // REVIEW-F S4-2: a hold on the other party of the alert's order keeps the alert
    const otherParty = await person();
    await system(() => app.prisma.docLegalHold.create({ data: {
      subjectUserId: otherParty, reason: `hold ${RUN}`, ownerId: otherParty, placedBy: otherParty, reviewBy: new Date(Date.now() + 30 * DAY),
    } }));
    const heldOrder = await order(otherParty, 'DELIVERED', 2600);
    const otherPartyAlert = await sosAlert(u, 2600);
    await system(() => app.prisma.sosAlert.update({ where: { id: otherPartyAlert }, data: { orderId: heldOrder } }));
    await system(() => runRetentionSweep(app.prisma));
    for (const id of [young, withEvidence, caseAlert, otherPartyAlert]) expect(await alertExists(id), id).toBe(true);
    expect(await caseExists(heldCase)).toBe(true);
    expect(await caseExists(keptCase)).toBe(true);
    expect(await ticketExists(youngTicket)).toBe(true);
  });

  it('deletes nothing on any clock while a legal hold is partial (the S-09 freeze)', async () => {
    const u = await person(); const other = await person();
    const due = await sosAlert(u, 2600);
    const dueChat = await chat(await order(u, 'DELIVERED', 400), [u, other], 401);
    const dueTicket = await ticket(u, { category: 'ORDER_ISSUE', status: 'RESOLVED', daysAgo: 1200 });
    const partial = await incident(u, 10, { legalHold: true }); // held case with no hold row -> partial
    try {
      const results = await system(() => runRetentionSweep(app.prisma));
      for (const c of ['safety.records', 'chat.order_messages', 'support_tickets.resolved']) {
        expect(results.find((r) => r.dataClass === c)!.deleted, c).toBe(0);
      }
      expect(await alertExists(due)).toBe(true);
      expect(await messagesIn(dueChat.roomId)).toBe(2);
      expect(await ticketExists(dueTicket)).toBe(true);
    } finally {
      await system(() => app.prisma.incidentCase.update({ where: { id: partial }, data: { legalHold: false } }));
    }
    await system(() => runRetentionSweep(app.prisma));
    expect(await alertExists(due)).toBe(false);
    expect(await messagesIn(dueChat.roomId)).toBe(0);
    expect(await ticketExists(dueTicket)).toBe(false);
  });
});
