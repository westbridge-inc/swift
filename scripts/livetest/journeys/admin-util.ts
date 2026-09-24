// Two-person admin actions [TASK-057]. Money- and platform-class admin routes
// (ADM-005) answer 202 APPROVAL_REQUIRED to the first admin; a DIFFERENT admin
// approves; the requester re-sends the identical request with x-swift-approval.
// No HTTP route creates a second admin, so the second person exists only when
// the operator provisioned one (LIVETEST_ADMIN2_PHONE); otherwise the held
// state and the self-approval refusal are proven and the rest is a SKIP.

import { req, type Res } from '../client.js';
import type { Recorder } from '../journey.js';
import type { Ctx } from './context.js';

export interface TwoPerson { first: Res; approvalId?: string; decide?: Res; final?: Res; done: boolean }

/**
 * `finalStatuses`: what the re-sent request may answer once approved (default success);
 * a duplicate settlement, for instance, is expected to be refused at that point.
 */
export async function twoPerson(rec: Recorder, ctx: Ctx, what: string, method: string, path: string, body: unknown, finalStatuses: number[] = [200, 201]): Promise<TwoPerson> {
  const reason = `journey runner ${ctx.runId}: ${what}`.slice(0, 480);
  const call = (token: string, m: string, p: string, b: unknown, extra: Record<string, string> = {}) =>
    req(m, p, { token, body: b ?? {}, headers: { 'x-swift-reason': reason, ...extra } });

  const first = await call(ctx.admin.token, method, path, body);
  const approvalId = first.json?.error?.details?.approvalId as string | undefined;
  if (!(first.status === 202 && first.json?.error?.code === 'APPROVAL_REQUIRED' && approvalId)) {
    rec.expect(`${what}: held for a second admin (202 APPROVAL_REQUIRED)`, first, 202, ['APPROVAL_REQUIRED']);
    return { first, done: false };
  }
  rec.step(`${what}: held for a second admin`, true, `202 APPROVAL_REQUIRED, approval ${approvalId}`);
  const self = await call(ctx.admin.token, 'POST', `/admin/approvals/${approvalId}/decide`, { approve: true, note: 'self' });
  rec.deny(`${what}: the requester cannot approve their own request`, self, [403]);
  const second = ctx.roster.admin2;
  if (!second) {
    rec.skipCase(`${what} — applied`, 'needs a second admin; none is provisioned on this target (LIVETEST_ADMIN2_PHONE unset) and no HTTP route creates one (the seed break-glass ceremony does)');
    return { first, approvalId, done: false };
  }
  const decide = await call(second.token, 'POST', `/admin/approvals/${approvalId}/decide`, { approve: true, note: 'synthetic journey approval' });
  rec.expect(`${what}: a second admin approves`, decide, 200, undefined, `status=${decide.json?.data?.status}`);
  const final = await call(ctx.admin.token, method, path, body, { 'x-swift-approval': approvalId });
  rec.expect(`${what}: ${finalStatuses.every((s) => s < 300) ? 'applied with the approval' : 'answered with the approval'}`, final, finalStatuses);
  return { first, approvalId, decide, final, done: final.ok };
}
