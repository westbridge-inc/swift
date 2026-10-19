import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { APPROVAL_HEADER } from '../modules/admin/admin-approval';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [U06] ONE ASK PER TARGET WHILE IT STANDS.
//
// A money or platform action answers 202: a second admin must approve it. The
// console showed that answer as nothing (or as "Send failed — try again"), the
// operator pressed again, and every press wrote ANOTHER pending approval for
// the same act. Two approvers each approving "their" copy would make the act
// happen twice: a payment returned twice, a broadcast sent twice.
//
// The gate now refuses a second ask while an earlier one for the SAME action
// on the SAME target still stands (waiting for a second admin, or approved and
// not yet executed): 409 APPROVAL_ALREADY_OPEN, naming the earlier approval.
// The target is the route's params; a route with no params (a broadcast, a new
// promo) has no target of its own, so the exact request stands in for one.
// Once the earlier ask is rejected, withdrawn, expired or executed, a new ask
// is accepted again. Executing an approved ask is never refused by this rule.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
const REASON = 'Partner paid this week twice, MMG statement line 4471';

async function makeAdmin(): Promise<{ token: string; userId: string }> {
  const user = await app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Dup', lastName: `D${RUN}${userIds.length}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
      activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'admin-approval-duplicate', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { token, userId: user.id };
}

const call = (token: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: method as never, url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

let keySeq = 0;
/** A config key of its own per case, so no case inherits another's open ask. */
const freshKey = () => `U06DUP_${RUN}_${++keySeq}`;
const writeConfig = (token: string, key: string, value: unknown, approvalId?: string) =>
  call(token, 'PUT', `/api/v1/admin/config/${key}`, { value, reason: REASON }, approvalId ? { [APPROVAL_HEADER]: approvalId } : {});
const decide = (token: string, id: string, approve: boolean) =>
  call(token, 'POST', `/api/v1/admin/approvals/${id}/decide`, { approve, reason: REASON });
const broadcast = (token: string, title: string) =>
  call(token, 'POST', '/api/v1/admin/notifications/broadcast', { title, body: 'Service update for Georgetown.', category: 'service', reason: REASON });
const returnPayment = (token: string, checkoutId: string, amount: number) =>
  call(token, 'POST', `/api/v1/admin/billing/mmg-checkouts/${checkoutId}/reverse`, { amount, reason: REASON });
const attachPayment = (token: string, paymentId: string, subscriptionId: string) =>
  call(token, 'POST', `/api/v1/admin/billing/agent-payments/${paymentId}/attach`, { subscriptionId, reason: REASON });

const approvalIdOf = (res: { json: () => any }) => res.json().error.details.approvalId as string;
const openRows = (action: string, entityId: string | null) =>
  app.prisma.privilegedApproval.count({ where: { action, entityId, status: { in: ['PENDING', 'APPROVED'] } } });

let requester: { token: string; userId: string };
let other: { token: string; userId: string };
let approver: { token: string; userId: string };

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  requester = await makeAdmin();
  other = await makeAdmin();
  approver = await makeAdmin();
});
afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.platformConfig.deleteMany({ where: { key: { startsWith: `U06DUP_${RUN}` } } }).catch(() => {});
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-approval-duplicate').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:admin-approval-duplicate');
  await app.close();
});

describe('[U06] a second ask for the same act is refused while the first stands', () => {
  it('pressing again files nothing new: 409 APPROVAL_ALREADY_OPEN names the waiting approval', async () => {
    const key = freshKey();
    const first = await writeConfig(requester.token, key, { rate: 1 });
    expect(first.statusCode, first.body).toBe(202);
    const firstId = approvalIdOf(first);

    const again = await writeConfig(requester.token, key, { rate: 1 });
    expect(again.statusCode, again.body).toBe(409);
    const error = again.json().error;
    expect(error.code).toBe('APPROVAL_ALREADY_OPEN');
    expect(error.details).toEqual({ approvalId: firstId, approvalStatus: 'PENDING' });
    expect(error.message).toMatch(/already waiting for a second admin/i);
    expect(await openRows('PUT /config/:key', key)).toBe(1);
  });

  it('the same target with a different body is refused too: the first ask must be withdrawn before asking differently', async () => {
    const key = freshKey();
    const first = await writeConfig(requester.token, key, { rate: 1 });
    expect(first.statusCode).toBe(202);
    const changed = await writeConfig(requester.token, key, { rate: 2 });
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().error.details.approvalId).toBe(approvalIdOf(first));
    expect(await openRows('PUT /config/:key', key)).toBe(1);
  });

  it('a different admin asking for the same act is refused as well (two copies = done twice)', async () => {
    const key = freshKey();
    expect((await writeConfig(requester.token, key, { rate: 1 })).statusCode).toBe(202);
    const theirs = await writeConfig(other.token, key, { rate: 1 });
    expect(theirs.statusCode, theirs.body).toBe(409);
    expect(theirs.json().error.code).toBe('APPROVAL_ALREADY_OPEN');
  });

  it('a different target is a different act: not refused', async () => {
    const a = await writeConfig(requester.token, freshKey(), { rate: 1 });
    const b = await writeConfig(requester.token, freshKey(), { rate: 1 });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode, b.body).toBe(202);
  });

  it('money: "Return this payment" twice for one MMG payment writes ONE approval', async () => {
    const checkout = `chk_${RUN}_a`;
    const first = await returnPayment(requester.token, checkout, 5000);
    expect(first.statusCode, first.body).toBe(202);
    const again = await returnPayment(requester.token, checkout, 5000);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.details.approvalId).toBe(approvalIdOf(first));
    expect(await app.prisma.privilegedApproval.count({
      where: { action: 'POST /billing/mmg-checkouts/:id/reverse', status: 'PENDING', bodySnapshot: { path: ['params', 'id'], equals: checkout } },
    })).toBe(1);
    // another payment is its own act
    expect((await returnPayment(requester.token, `chk_${RUN}_b`, 5000)).statusCode).toBe(202);
  });

  it('money: Attach on one unmatched payment twice writes ONE approval', async () => {
    const payment = `pay_${RUN}`;
    expect((await attachPayment(requester.token, payment, 'sub_1')).statusCode).toBe(202);
    const again = await attachPayment(requester.token, payment, 'sub_1');
    expect(again.statusCode, again.body).toBe(409);
    expect(await openRows('POST /billing/agent-payments/:id/attach', payment)).toBe(1);
  });

  it('a route with no target (a broadcast): the identical request is refused, a different message is not', async () => {
    const title = `Road closure ${RUN}`;
    const first = await broadcast(requester.token, title);
    expect(first.statusCode, first.body).toBe(202);
    const again = await broadcast(requester.token, title);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.details.approvalId).toBe(approvalIdOf(first));
    const different = await broadcast(requester.token, `${title} (evening)`);
    expect(different.statusCode, different.body).toBe(202);
  });

  it('two asks racing for the same act: exactly one is written', async () => {
    const key = freshKey();
    const answers = await Promise.all([1, 2, 3].map(() => writeConfig(requester.token, key, { rate: 9 })));
    expect(answers.map((r) => r.statusCode).sort()).toEqual([202, 409, 409]);
    expect(await openRows('PUT /config/:key', key)).toBe(1);
  });
});

describe('[U06] once the first ask no longer stands, a new ask is accepted', () => {
  it('approved but not yet executed still stands (409, says so); executing it is never refused', async () => {
    const key = freshKey();
    const asked = await writeConfig(requester.token, key, { rate: 4 });
    const id = approvalIdOf(asked);
    expect((await decide(approver.token, id, true)).statusCode).toBe(200);

    const again = await writeConfig(requester.token, key, { rate: 4 });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.details).toEqual({ approvalId: id, approvalStatus: 'APPROVED' });
    expect(again.json().error.message).toMatch(/approved/i);

    const executed = await writeConfig(requester.token, key, { rate: 4 }, id);
    expect(executed.statusCode, executed.body).toBe(200);
    expect((await app.prisma.platformConfig.findUniqueOrThrow({ where: { key } })).value).toEqual({ rate: 4 });

    // executed: no longer open, so the next change is a new ask
    expect((await writeConfig(requester.token, key, { rate: 5 })).statusCode).toBe(202);
  });

  it('rejected', async () => {
    const key = freshKey();
    const id = approvalIdOf(await writeConfig(requester.token, key, { rate: 1 }));
    expect((await decide(approver.token, id, false)).statusCode).toBe(200);
    expect((await writeConfig(requester.token, key, { rate: 1 })).statusCode).toBe(202);
  });

  it('withdrawn by the admin who asked', async () => {
    const key = freshKey();
    const id = approvalIdOf(await writeConfig(requester.token, key, { rate: 1 }));
    const withdrawn = await call(requester.token, 'POST', `/api/v1/admin/approvals/${id}/cancel`, {});
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect((await writeConfig(requester.token, key, { rate: 1 })).statusCode).toBe(202);
  });

  it('expired (even if nobody marked it EXPIRED yet)', async () => {
    const key = freshKey();
    const id = approvalIdOf(await writeConfig(requester.token, key, { rate: 1 }));
    await app.prisma.privilegedApproval.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await writeConfig(requester.token, key, { rate: 1 })).statusCode).toBe(202);
  });
});
