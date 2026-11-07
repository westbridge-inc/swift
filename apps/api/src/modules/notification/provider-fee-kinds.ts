import type { NotificationPayload } from './notification.service';
import { log } from '../../utils/logger';

/**
 * [BILL-PRO PR4 · plan G14] A pro's weekly-fee notices carry kinds of their own.
 *
 * Shipped phone builds route every store-or-mover fee kind (billing_*, trial_fee_education, fx_change_notice,
 * billing_rate_change, usd_migration_notice) to the weekly-fee screen of a store or a mover. Neither exists for a pro:
 * build 12 would open the mover screen and show "We couldn't load your weekly fee". So a notice whose audience is
 * 'provider' (subscription-owner.ts payerAudienceOf) is sent under the pro kind below. No shipped build knows these
 * kinds, so a tap opens the app where it was, and the customer inbox of builds 9-12 shows no 'provider' notice.
 * The pro fee screen routes them (the phone update after build 12, BILL-PRO PR5). The words of the notice (push,
 * SMS) are unchanged, and the notice keeps its original kind as `feeKind`. Written as `kind: '...'` so the phone's
 * notification census sees every one of them.
 */
export const PROVIDER_FEE_KINDS: Readonly<Record<string, { kind: string }>> = {
  billing_mmg_checkout: { kind: 'provider_fee_mmg_checkout' },
  billing_mmg_pending: { kind: 'provider_fee_mmg_pending' },
  billing_success: { kind: 'provider_fee_success' },
  billing_failed: { kind: 'provider_fee_failed' },
  billing_final_warning: { kind: 'provider_fee_final_warning' },
  billing_suspended: { kind: 'provider_fee_suspended' },
  billing_suspended_nudge: { kind: 'provider_fee_suspended_nudge' },
  billing_reminder: { kind: 'provider_fee_reminder' },
  billing_banked: { kind: 'provider_fee_banked' },
  billing_churned: { kind: 'provider_fee_churned' },
  billing_topup: { kind: 'provider_fee_topup' },
  billing_card_action_required: { kind: 'provider_fee_card_action_required' },
  trial_fee_education: { kind: 'provider_fee_trial' },
  fx_change_notice: { kind: 'provider_fee_fx_change' },
  billing_rate_change: { kind: 'provider_fee_rate_change' },
  usd_migration_notice: { kind: 'provider_fee_usd_migration' },
};

/** Any other provider-audience notice: still never a store or mover fee kind (logged: map it above). */
export const PROVIDER_FEE_OTHER = { kind: 'provider_fee_notice' } as const;

/** The notice as a pro receives it: a provider-audience notice under its pro kind (see above); anything else as is. */
export function providerFeeNotice(payload: NotificationPayload): NotificationPayload {
  if (payload.audience !== 'provider') return payload;
  const kind = typeof payload.data?.['kind'] === 'string' ? (payload.data['kind'] as string) : null;
  if (kind?.startsWith('provider_fee_')) return payload;
  const mapped = (kind ? PROVIDER_FEE_KINDS[kind] : undefined) ?? PROVIDER_FEE_OTHER;
  if (mapped === PROVIDER_FEE_OTHER) log().error({ kind }, '[BILL-PRO] provider notice kind has no pro kind (notification/provider-fee-kinds.ts)');
  return { ...payload, data: { ...payload.data, kind: mapped.kind, ...(kind ? { feeKind: kind } : {}), feeFamily: 'provider' } };
}
