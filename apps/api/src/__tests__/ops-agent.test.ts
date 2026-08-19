import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { AgentService, agentEnabled, agentMode, type OpsDecision } from '../modules/agent/agent.service';

// ---------------------------------------------------------------------------
// Ops agent (spec Part B §9): detection is deterministic, the model only
// classifies, the gate decides autonomy, money waits for a human. The model
// here is INJECTED — no network, no key.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_500_000_000 + Math.floor(Math.random() * 400_000_000);

async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Agent', lastName: `C${seq}`,
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeStuckOrder(opts: { status: string; minutesAgo: number; orderType?: string }) {
  const customer = await makeCustomer();
  const when = new Date(Date.now() - opts.minutesAgo * 60_000);
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `AGNT-${nanoid(8)}`,
      orderType: (opts.orderType ?? 'FOOD_DELIVERY') as any,
      customerId: customer.id,
      status: opts.status as any,
      fulfillment: 'DELIVERY',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300,
      paymentMethod: 'CASH',
      placedAt: when,
      statusHistory: { create: { status: opts.status as any, changedBy: customer.id, note: 'test' } },
    },
  });
  // updatedAt is @updatedAt — backdate it directly for staleness thresholds.
  await app.prisma.$executeRaw`UPDATE orders SET "updatedAt" = ${when} WHERE id = ${order.id}`;
  return order;
}

function makeAgent(decision: OpsDecision | null, enqueued: string[] = []) {
  return new AgentService(
    app.prisma,
    app.io,
    async (orderId) => {
      enqueued.push(orderId);
    },
    async () => decision,
  );
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
});

beforeEach(() => {
  process.env['AGENT_ENABLED'] = '1';
  process.env['ANTHROPIC_API_KEY'] = 'test-key-never-used'; // model is injected
  process.env['AGENT_MODE'] = 'assist';
});

afterAll(async () => {
  delete process.env['AGENT_ENABLED'];
  delete process.env['AGENT_MODE'];
  await app.prisma.agentAuditEvent.deleteMany({});
  await app.prisma.agentActionRequest.deleteMany({});
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('flag plumbing', () => {
  it('the agent is ON by default when a key is present; AGENT_ENABLED=0 disables it (a hard no-op scan)', async () => {
    // New default (founder 2026-07-25): unset + key present → ON.
    delete process.env['AGENT_ENABLED'];
    expect(agentEnabled()).toBe(true);

    // The explicit off switch still works and the disabled scan does nothing.
    process.env['AGENT_ENABLED'] = '0';
    expect(agentEnabled()).toBe(false);
    const agent = makeAgent({ likelyCause: 'x', recommendedAction: 'ops_alert', urgency: 'high', rationale: 'x' });
    const result = await agent.runOpsScan();
    expect(result).toEqual({ scanned: 0, executed: 0, queued: 0, suggested: 0, errors: 0 });

    // No key means off regardless — dev/test/CI never fire it by accident.
    process.env['AGENT_ENABLED'] = '1';
    delete process.env['ANTHROPIC_API_KEY'];
    expect(agentEnabled()).toBe(false);
  });

  it('mode defaults to assist and never to auto', () => {
    delete process.env['AGENT_MODE'];
    expect(agentMode()).toBe('assist');
    process.env['AGENT_MODE'] = 'garbage';
    expect(agentMode()).toBe('assist');
  });
});

describe('deterministic detection', () => {
  it('finds the stuck shapes and ignores healthy orders', async () => {
    const stuckPending = await makeStuckOrder({ status: 'PENDING', minutesAgo: 30 });
    const stuckUnassigned = await makeStuckOrder({ status: 'READY_FOR_PICKUP', minutesAgo: 40 });
    const healthy = await makeStuckOrder({ status: 'PENDING', minutesAgo: 2 });

    const agent = makeAgent(null);
    const problems = await agent.findProblems();
    const ids = problems.map((p) => p.orderId);
    expect(ids).toContain(stuckPending.id);
    expect(ids).toContain(stuckUnassigned.id);
    expect(ids).not.toContain(healthy.id);

    // Snapshots carry NO free text — ids, enums and minutes only (hard rule 3)
    const snap = problems.find((p) => p.orderId === stuckPending.id)!;
    expect(Object.values(snap).every((v) => typeof v !== 'object' || v === null || Array.isArray(v))).toBe(true);
    expect(JSON.stringify(snap)).not.toContain('+592'); // no phone leaked
  });
});

describe('the gate (assist mode)', () => {
  it('a SAFE action executes and is audited', async () => {
    const order = await makeStuckOrder({ status: 'READY_FOR_PICKUP', minutesAgo: 45 });
    const enqueued: string[] = [];
    const agent = makeAgent(
      { likelyCause: 'dispatch stalled', recommendedAction: 'requeue_dispatch', urgency: 'high', rationale: 'no rider bound' },
      enqueued,
    );

    const result = await agent.runOpsScan();
    expect(result.executed).toBeGreaterThanOrEqual(1);
    expect(enqueued).toContain(order.id);

    const audit = await app.prisma.agentAuditEvent.findFirst({ where: { subjectId: order.id, action: 'requeue_dispatch' } });
    expect(audit?.outcome).toBe('executed');
  });

  it('a SENSITIVE action lands in the approval queue with reasoning — and is not executed', async () => {
    const order = await makeStuckOrder({ status: 'PENDING', minutesAgo: 90 });
    const agent = makeAgent({ likelyCause: 'vendor unreachable, order dead', recommendedAction: 'request_cancel', urgency: 'high', rationale: 'nothing moved in 90 min' });

    const result = await agent.runOpsScan();
    expect(result.queued).toBeGreaterThanOrEqual(1);

    const request = await app.prisma.agentActionRequest.findFirst({ where: { orderId: order.id } });
    expect(request?.status).toBe('PENDING');
    expect(request?.reasoning).toContain('vendor unreachable');

    const untouched = await app.prisma.order.findUnique({ where: { id: order.id } });
    expect(untouched?.status).toBe('PENDING'); // nothing happened without a human
  });

  it('suggest mode only logs — nothing executes, nothing queues', async () => {
    process.env['AGENT_MODE'] = 'suggest';
    const order = await makeStuckOrder({ status: 'READY_FOR_PICKUP', minutesAgo: 45 });
    const enqueued: string[] = [];
    const agent = makeAgent({ likelyCause: 'stalled', recommendedAction: 'requeue_dispatch', urgency: 'medium', rationale: 'r' }, enqueued);

    const result = await agent.runOpsScan();
    expect(result.suggested).toBeGreaterThanOrEqual(1);
    expect(enqueued).not.toContain(order.id);
  });

  it('a model failure leaves the order untouched and is audited as error', async () => {
    const order = await makeStuckOrder({ status: 'PENDING', minutesAgo: 30 });
    const agent = makeAgent(null); // model returns nothing (timeout/bad key)

    const result = await agent.runOpsScan();
    expect(result.errors).toBeGreaterThanOrEqual(1);
    const untouched = await app.prisma.order.findUnique({ where: { id: order.id } });
    expect(untouched?.status).toBe('PENDING');
  });

  it('does not re-file while a request is already pending', async () => {
    const order = await makeStuckOrder({ status: 'PENDING', minutesAgo: 60 });
    const agent = makeAgent({ likelyCause: 'dead', recommendedAction: 'request_cancel', urgency: 'high', rationale: 'r' });
    await agent.runOpsScan();
    await agent.runOpsScan(); // second scan, same problem
    const requests = await app.prisma.agentActionRequest.findMany({ where: { orderId: order.id } });
    expect(requests).toHaveLength(1);
  });
});

describe('approvals', () => {
  it('approve executes the deterministic path and marks EXECUTED; reject executes nothing', async () => {
    const orderA = await makeStuckOrder({ status: 'PENDING', minutesAgo: 70 });
    const orderB = await makeStuckOrder({ status: 'PENDING', minutesAgo: 70 });
    const agent = makeAgent({ likelyCause: 'dead order', recommendedAction: 'request_cancel', urgency: 'high', rationale: 'r' });
    await agent.runOpsScan();

    const reqA = await app.prisma.agentActionRequest.findFirstOrThrow({ where: { orderId: orderA.id } });
    const reqB = await app.prisma.agentActionRequest.findFirstOrThrow({ where: { orderId: orderB.id } });

    const approved = await agent.decideRequest(reqA.id, 'admin-user', true);
    expect(approved.status).toBe('EXECUTED');
    const cancelled = await app.prisma.order.findUnique({ where: { id: orderA.id } });
    expect(cancelled?.status).toBe('CANCELLED'); // via the state machine, not raw SQL

    const rejected = await agent.decideRequest(reqB.id, 'admin-user', false);
    expect(rejected.status).toBe('REJECTED');
    const untouched = await app.prisma.order.findUnique({ where: { id: orderB.id } });
    expect(untouched?.status).toBe('PENDING');

    // Deciding twice is refused
    await expect(agent.decideRequest(reqA.id, 'admin-user', true)).rejects.toThrow();
  });

  it('an approved cancel on an unattested-MMG order notifies BOTH parties through the one seam [REPORT-012 F-012-04]', async () => {
    // The store notice needs a real vendor+owner behind the order.
    seq += 1;
    const ownerUser = await app.prisma.user.create({
      data: {
        phone: `+${phoneBase + seq}`, firstName: 'Agent', lastName: `V${seq}`,
        roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
      },
    });
    userIds.push(ownerUser.id);
    const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: 'Agent Seam Store', slug: `agnt-${nanoid(6).toLowerCase()}`,
        vendorType: 'RESTAURANT', phone: `+${phoneBase + seq}9`, addressLine1: 'x',
        city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
        status: 'ACTIVE',
      },
    });
    const order = await makeStuckOrder({ status: 'PENDING', minutesAgo: 70 });
    await app.prisma.order.update({
      where: { id: order.id },
      data: { vendorId: vendor.id, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' },
    });
    const agent = makeAgent({ likelyCause: 'vendor dark', recommendedAction: 'request_cancel', urgency: 'high', rationale: 'r' });
    await agent.runOpsScan();
    const req = await app.prisma.agentActionRequest.findFirstOrThrow({ where: { orderId: order.id } });
    await agent.decideRequest(req.id, 'admin-user', true);

    // The CUSTOMER learns the direct-refund rail…
    const customerNote = await app.prisma.notification.findFirst({
      where: { userId: order.customerId, body: { contains: 'the store refunds you directly' } },
    });
    expect(customerNote).not.toBeNull();
    // …and the STORE gets the durable liability notice. Before F-012-04 the
    // agent path told only the customer; the store — the party possibly
    // holding the money — learned nothing.
    const storeNote = await app.prisma.notification.findFirst({
      where: {
        userId: ownerUser.id,
        title: 'Cancelled order may hold an MMG payment',
        body: { contains: order.orderNumber },
      },
    });
    expect(storeNote).not.toBeNull();

    await app.prisma.order.update({ where: { id: order.id }, data: { vendorId: null } });
    await app.prisma.vendor.delete({ where: { id: vendor.id } });
    await app.prisma.vendorOwner.delete({ where: { id: vo.id } });
  });
});
