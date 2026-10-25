import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { nanoid } from 'nanoid';
import * as shared from '@swift/types';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [Owner, admin-staging 25 Oct] Resolving a payment confirmation asks for an
// "evidence reference": what the finance admin checked (a bank or MMG
// reference, a statement line). It refused spaces and brackets
// (^[A-Za-z0-9._:/-]{8,128}$), so a normal reference could not be typed. The
// console and the server now share ONE rule (@swift/types): trimmed, 8-200
// characters of letters, digits, spaces and common punctuation; still no
// control characters (no line breaks) and nothing a reference never needs.
// ---------------------------------------------------------------------------

const problem = (shared as { evidenceReferenceProblem?: (raw: string) => string | null }).evidenceReferenceProblem;

describe('the one evidence-reference rule', () => {
  it('accepts a normal human reference: spaces, brackets, a hash, commas, an apostrophe', () => {
    expect(problem).toBeTypeOf('function');
    for (const ok of ['MMG ref 4417 (statement #3, 24 Oct)', 'review:case-001', 'Bank stmt [GTT] line 12', "Republic Bank's slip 0042/24", '  padded reference 99  ', 'É-transfer réf 2025']) {
      expect(problem!(ok), ok).toBeNull();
    }
  });

  it('refuses too short, too long (after trimming), control characters and characters a reference never needs', () => {
    for (const bad of ['', '       ', 'short', '  seven  ', 'x'.repeat(201), 'line one\nline two', 'tab\there please', '<script>alert(1)</script>', 'ref {"a":1} here', 'back\\slash ref', 'pipe | ref 123']) {
      expect(problem!(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(problem!('y'.repeat(200))).toBeNull();
  });
});

describe('POST /admin/billing/confirmations/:id/resolve reads the reference by the same rule', () => {
  let app: FastifyInstance;
  const userIds: string[] = [];
  let token = '';
  const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:confirmation-evidence-reference');

  beforeAll(async () => {
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    registerEmptyJsonBodyParser(app);
    app.addHook('onRequest', async () => { beginRequestTenantContext(); });
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(authPlugin);
    await app.register(socketPlugin);
    await app.register(adminRoutes, { prefix: '/api/v1/admin' });
    await app.ready();
    const user = await sys(() => app.prisma.user.create({ data: {
      phone: testPhone(), firstName: 'Finance', lastName: `Ref${nanoid(4)}`, roles: ['ADMIN', 'CUSTOMER'], activeRole: 'ADMIN',
      status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
    } }));
    userIds.push(user.id);
    token = app.jwt.sign({ userId: user.id, role: 'ADMIN', jti: nanoid(8) });
    await sys(() => app.prisma.session.create({ data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'evidence-ref', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    } }));
  });

  afterAll(async () => {
    await cleanupSecondApprovers(app);
    await sys(async () => {
      await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } });
      await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:confirmation-evidence-reference').catch(() => 0);
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    });
    await app.close();
  });

  // A confirmation that does not exist: a body the rule accepts reaches the resolver (404); one it refuses never does (400).
  const resolve = (evidenceReference: string) => injectWithApproval(app, {
    method: 'POST', url: `/api/v1/admin/billing/confirmations/no-such-hold-${nanoid(6)}/resolve`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': 'Checked the bank statement for this payment.' },
    payload: { sourceId: 'no-such-source', epoch: 1, clockVersion: 0, decision: 'UNPAID', evidenceReference, reason: 'Checked the bank statement for this payment.' },
  } as InjectOptions);

  it('a human reference passes the server\'s check (the resolver answers: no such confirmation)', async () => {
    const res = await resolve('MMG ref 4417 (statement #3, 24 Oct)');
    expect(res.statusCode, res.body).toBe(404);
  });

  it('a reference with a line break or markup is refused before the resolver runs', async () => {
    for (const bad of ['line one\nline two', '<b>ref 12345</b>']) {
      const res = await resolve(bad);
      expect(res.statusCode, `${JSON.stringify(bad)} ${res.body}`).toBe(400);
    }
  });
});
