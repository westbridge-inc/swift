import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import { runWithoutTenant } from '../../plugins/prisma';
import { APPROVAL_HEADER } from '../../modules/admin/admin-approval';
import { TEST_ADMIN_REASON } from './admin-reason';

/**
 * [ADM-005] A money or platform action takes two people.
 *
 * That law is graded by `admin-approval.test.ts`. Every OTHER suite is testing
 * what its route does, so it gets its second person the way the real console
 * will: the request comes back 202 with an approval id, someone who is not the
 * requester approves it, and the request is re-issued carrying it.
 *
 * The suites therefore exercise the REAL dual-control path on every money
 * action rather than bypassing it, which is the point — a helper that skipped
 * the gate would leave the gate untested everywhere it matters.
 */

const seconds = new WeakMap<FastifyInstance, Map<string, Promise<string>>>();

/**
 * A second capable admin for this app instance, IN THE APPROVAL'S OWN TENANT,
 * made once per tenant and reused. An approval belongs to the market it was
 * raised in, so a default-tenant approver cannot decide another market's — the
 * suites that cross that boundary are testing exactly that, and a helper that
 * papered over it would hide the isolation it depends on.
 */
function secondAdminToken(app: FastifyInstance, tenantId: string): Promise<string> {
  let byTenant = seconds.get(app);
  if (!byTenant) { byTenant = new Map(); seconds.set(app, byTenant); }
  let existing = byTenant.get(tenantId);
  if (!existing) {
    existing = (async () => {
      const phone = `+59273${String(Math.floor(Math.random() * 90000) + 10000)}`;
      const user = await runWithoutTenant(() => app.prisma.user.create({
        data: {
          phone, firstName: 'Second', lastName: `Approver${nanoid(4)}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
          activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, tenantId,
          admin: { create: { permissions: ['*'] } },
        },
      }), 'test-second-approver');
      const token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
      await runWithoutTenant(() => app.prisma.session.create({
        data: {
          userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
          deviceId: 'test-second-approver', deviceType: 'test',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      }), 'test-second-approver');
      return token;
    })();
    byTenant.set(tenantId, existing);
  }
  return existing;
}

/** Is this the 202 the approval gate returns? */
function approvalId(res: LightMyRequestResponse): string | null {
  if (res.statusCode !== 202) return null;
  try {
    const body = res.json();
    return body?.error?.code === 'APPROVAL_REQUIRED' ? (body.error.details.approvalId as string) : null;
  } catch { return null; }
}

/**
 * Inject, and if the action needs a second person, get one and re-issue.
 * A suite calls this exactly where it called `app.inject` before.
 */
export async function injectWithApproval(app: FastifyInstance, options: InjectOptions): Promise<LightMyRequestResponse> {
  const first = await app.inject(options);
  const id = approvalId(first);
  if (!id) return first;

  // the approval's own market decides it
  const row = await runWithoutTenant(
    () => app.prisma.privilegedApproval.findUnique({ where: { id }, select: { tenantId: true } }),
    'test-approval-tenant',
  );
  if (!row) return first;
  const token = await secondAdminToken(app, row.tenantId);
  const decided = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/approvals/${id}/decide`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON },
    payload: { approve: true, note: 'Approved by the automated suite' },
  });
  if (decided.statusCode !== 200) return first;

  const headers = { ...(options.headers as Record<string, string> | undefined), [APPROVAL_HEADER]: id };
  return app.inject({ ...options, headers });
}

/**
 * Remove the approvers this helper made for one app instance.
 *
 * A suite that deletes the TENANTS it created must call this first: the second
 * approver lives in the tenant whose approval it decided, and a tenant cannot
 * be deleted while one of its users is still there.
 */
export async function cleanupSecondApprovers(app: FastifyInstance): Promise<void> {
  const byTenant = seconds.get(app);
  if (!byTenant) return;
  const tokens = await Promise.all([...byTenant.values()]);
  seconds.delete(app);
  await runWithoutTenant(async () => {
    const sessions = await app.prisma.session.findMany({ where: { token: { in: tokens } }, select: { userId: true } });
    const ids = sessions.map((row) => row.userId);
    if (!ids.length) return;
    await app.prisma.privilegedApproval.deleteMany({ where: { approvedBy: { in: ids } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }, 'test-second-approver-cleanup');
}
