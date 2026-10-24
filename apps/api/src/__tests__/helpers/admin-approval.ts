import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import { runWithoutTenant } from '../../plugins/prisma';
import { APPROVAL_HEADER, APPROVAL_TTL_MS, approvalSubjectOf, fillRouteTemplate, fingerprintOf } from '../../modules/admin/admin-approval';
import { TEST_ADMIN_REASON } from './admin-reason';
import { testPhone } from './fixture-ids';

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

const seconds = new WeakMap<FastifyInstance, Map<string, Promise<{ userId: string; token: string; at: number }>>>();
/** Every approver user this helper created, noted the moment the row exists:
 *  a setup that fails AFTER the user insert (its session) still leaves a user
 *  that cleanup must remove, and its rejected promise carries no id. */
const createdUsers = new WeakMap<FastifyInstance, Set<string>>();

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
      const phone = testPhone();
      const user = await runWithoutTenant(() => app.prisma.user.create({
        data: {
          phone, firstName: 'Second', lastName: `Approver${nanoid(4)}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
          activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, tenantId,
          admin: { create: { permissions: ['*'] } },
        },
      }), 'test-second-approver');
      let made = createdUsers.get(app);
      if (!made) { made = new Set(); createdUsers.set(app, made); }
      made.add(user.id);
      return { userId: user.id, ...await signSecond(app, user.id) };
    })();
    byTenant.set(tenantId, existing);
  }
  return existing.then(async (second) => {
    // The token lives 15 minutes of real time (plugins/auth.ts); a suite that
    // runs longer (the order random walk under load) renews it first.
    if (Date.now() - second.at <= SECOND_RENEW_MS) return second.token;
    const renewed = { userId: second.userId, ...await signSecond(app, second.userId) };
    byTenant!.set(tenantId, Promise.resolve(renewed));
    return renewed.token;
  });
}

const SECOND_RENEW_MS = 10 * 60_000;

async function signSecond(app: FastifyInstance, userId: string): Promise<{ token: string; at: number }> {
  const token = app.jwt.sign({ userId, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await runWithoutTenant(() => app.prisma.session.create({
    data: {
      userId, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'test-second-approver', deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  }), 'test-second-approver');
  return { token, at: Date.now() };
}

/** Is this the 202 the approval gate returns? */
function approvalId(res: LightMyRequestResponse): string | null {
  if (res.statusCode !== 202) return null;
  try {
    const body = res.json();
    return body?.error?.code === 'APPROVAL_REQUIRED' ? (body.error.details.approvalId as string) : null;
  } catch { return null; }
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'reason').sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([key, v]) => [key, canonical(v)]));
  }
  return value;
};

/**
 * [U06] The gate's 409 for an act whose ask already stands, when the standing
 * ask is THIS caller's and asks for exactly THIS request: the suite asked once
 * itself, then calls here. That ask is the one to approve, as an operator does
 * in Approvals. A standing ask for anything else is a refusal the suite sees.
 */
async function standingSameAsk(app: FastifyInstance, res: LightMyRequestResponse, options: InjectOptions): Promise<{ id: string; approved: boolean } | null> {
  if (res.statusCode !== 409) return null;
  let details: { approvalId?: string; approvalStatus?: string; askedByYou?: boolean } | undefined;
  try {
    const body = res.json();
    if (body?.error?.code !== 'APPROVAL_ALREADY_OPEN') return null;
    details = body.error.details;
  } catch { return null; }
  if (!details?.approvalId || details.askedByYou !== true) return null;
  const row = await runWithoutTenant(
    () => app.prisma.privilegedApproval.findUnique({ where: { id: details!.approvalId! }, select: { action: true, bodySnapshot: true } }),
    'test-approval-standing',
  );
  const subject = row ? approvalSubjectOf(row) : null;
  if (!subject) return null;
  const path = String(options.url ?? '').split('?')[0] ?? '';
  const sameTarget = path.endsWith(fillRouteTemplate(subject.routeUrl, subject.params ?? {}));
  const payload = typeof options.payload === 'string' ? JSON.parse(options.payload) : (options.payload ?? {});
  const sameBody = JSON.stringify(canonical(subject.body ?? {})) === JSON.stringify(canonical(payload));
  return sameTarget && sameBody ? { id: details.approvalId, approved: details.approvalStatus === 'APPROVED' } : null;
}

/**
 * Inject, and if the action needs a second person, get one and re-issue.
 * A suite calls this exactly where it called `app.inject` before.
 */
export async function injectWithApproval(app: FastifyInstance, options: InjectOptions): Promise<LightMyRequestResponse> {
  const first = await app.inject(options);
  const standing = await standingSameAsk(app, first, options);
  if (standing?.approved) return app.inject({ ...options, headers: { ...(options.headers as Record<string, string> | undefined), [APPROVAL_HEADER]: standing.id } });
  const id = standing?.id ?? approvalId(first);
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
  // One tenant's failed setup must not stop the others' clean-up: settle all,
  // and add every user the helper created (a failed session leaves one).
  const settled = await Promise.allSettled([...byTenant.values()]);
  const ids = [...new Set([
    ...(createdUsers.get(app) ?? []),
    ...settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value.userId] : [])),
  ])];
  seconds.delete(app);
  createdUsers.delete(app);
  await runWithoutTenant(async () => {
    if (!ids.length) return;
    await app.prisma.privilegedApproval.deleteMany({ where: { approvedBy: { in: ids } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }, 'test-second-approver-cleanup');
}

/**
 * Ask, and have a second admin approve, WITHOUT executing: returns the
 * approval id for the suite to execute (or race) itself.
 */
export async function askAndApprove(app: FastifyInstance, options: InjectOptions): Promise<string> {
  const asked = await app.inject(options);
  const id = approvalId(asked);
  if (!id) throw new Error(`expected 202 APPROVAL_REQUIRED, got ${asked.statusCode}: ${asked.body}`);
  return approveAsSecondAdmin(app, id);
}

/** The suite's own second admin (never the suite's actors) approves an existing ask. */
export async function approveAsSecondAdmin(app: FastifyInstance, id: string): Promise<string> {
  const row = await runWithoutTenant(
    () => app.prisma.privilegedApproval.findUniqueOrThrow({ where: { id }, select: { tenantId: true } }),
    'test-approval-tenant',
  );
  const token = await secondAdminToken(app, row.tenantId);
  const decided = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/approvals/${id}/decide`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON },
    payload: { approve: true, note: 'Approved by the automated suite' },
  });
  if (decided.statusCode !== 200) throw new Error(`approval ${id} was not approved: ${decided.statusCode} ${decided.body}`);
  return id;
}

/**
 * [U06] A SECOND approved ask for an act that already has one, written as a
 * row. The gate no longer lets the API write it (an ask while an earlier ask
 * for the same act stands is refused 409 APPROVAL_ALREADY_OPEN), but rows from
 * before that rule can exist. Suites that prove an act's OWN guard against two
 * approved requests seed the second one here: a copy of an approved ask (its
 * body changed if `body` is given), fingerprinted by the gate's own function,
 * so executing it is exactly executing an approval the gate once wrote.
 */
export async function seedSecondApproval(
  app: FastifyInstance,
  fromApprovalId: string,
  opts: { body?: (_body: Record<string, unknown>) => Record<string, unknown>; requestedBy?: string; approvedBy?: string } = {},
): Promise<string> {
  return runWithoutTenant(async () => {
    const row = await app.prisma.privilegedApproval.findUniqueOrThrow({ where: { id: fromApprovalId } });
    if (row.status !== 'APPROVED' || !row.approvedBy) throw new Error(`approval ${fromApprovalId} is ${row.status}, not APPROVED`);
    const subject = approvalSubjectOf(row);
    if (!subject) throw new Error(`approval ${fromApprovalId} has no stored request`);
    const body = opts.body ? opts.body({ ...(subject.body as Record<string, unknown>) }) : subject.body;
    const changed = { ...subject, body };
    const now = new Date();
    const created = await app.prisma.privilegedApproval.create({
      data: {
        tenantId: row.tenantId, action: row.action, cls: row.cls, capability: row.capability, entityId: row.entityId,
        fingerprint: fingerprintOf(changed),
        bodySnapshot: { params: changed.params ?? {}, body: body ?? {}, query: changed.query ?? {} } as never,
        status: 'APPROVED', requestedBy: opts.requestedBy ?? row.requestedBy, reason: row.reason,
        approvedBy: opts.approvedBy ?? row.approvedBy, decisionNote: 'Seeded by the suite: a second approval for one act', decidedAt: now,
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
      },
      select: { id: true },
    });
    return created.id;
  }, 'test-second-approval');
}
