import { AppError } from '../../utils/errors';
import { isProduction } from '../../utils/runtime-mode';

/**
 * [BUG-HUNT F23 · owner 31 Oct + 2 Nov 2026] "Review now, approve on launch day": partners are approved in a batch on
 * the same day ordering is switched on, and a free trial starts the day a partner is approved. The approval that
 * completes a checklist starts that clock at once, so before ordering day a review could burn a partner's trial.
 *
 * PARTNER_APPROVALS_OPEN is the brake. Only '1' opens it. Unset means closed in production and open everywhere else
 * (staging runs NODE_ENV=development, and a test or a developer has no launch day). Any other value is closed
 * everywhere: a near miss never opens it. pilot-up refuses a near miss before a deploy.
 *
 * While closed: a reviewer checks and approves freely, except the one paper that would complete a partner, which stays
 * in the queue with a marker (approvalHeldAt) so nobody checks it twice. Nothing machine-approves. And no trial row is
 * born by any other door: SubscriptionService.createRow refuses, whatever path reached it.
 */
export function partnerApprovalsOpen(env: Record<string, string | undefined> = process.env): boolean {
  const value = env['PARTNER_APPROVALS_OPEN'];
  if (value === '1') return true;
  if (value !== undefined && value !== '') return false;
  return !isProduction(env);
}

export const PARTNER_APPROVAL_HELD = 'PARTNER_APPROVAL_HELD';

/** The partner the last paper would start: `trial` says whether a free trial is what starts. */
export interface PartnerAtTheLastPaper {
  name: string;
  trial: boolean;
}

/** What the reviewer reads on the approval that would complete a partner. */
export function lastPaperHeld(partner: PartnerAtTheLastPaper): AppError {
  const effect = partner.trial ? 'starts their free trial' : 'puts them live';
  return new AppError(409, PARTNER_APPROVAL_HELD, `This is the last paper for ${partner.name}. Approving it ${effect}. Hold it until ordering day.`);
}

/** The belt under every other door. Either side may read it, so it names nobody. */
export function noTrialBeforeOrderingDay(): AppError {
  return new AppError(409, PARTNER_APPROVAL_HELD, 'Swift approves new partners on launch day, so no free trial can start yet.');
}
