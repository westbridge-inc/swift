import { ApiRequestError, apiFetch } from './auth';

/**
 * [BILL-PRO PR6 · owner A4/B3] What the website reads and sends about a pro's own weekly fee (GET
 * /api/v1/provider/subscription, POST /api/v1/provider/weekly-fee-ack) and the pro's approval. Kept apart from the
 * words (provider-fee.ts) so the portal's Weekly fee page loads only this up front; the pro's block loads after it.
 */
export type ProFeeWhy = 'AGREEMENT' | 'FEE_TERMS' | 'MISSING' | 'STATUS' | 'GRACE_LAPSED' | 'BILLING_STOPPED' | null;
export type ProFeeStanding = { required: false; operable: true } | { required: true; operable: boolean; why: ProFeeWhy; source: 'OWN' | 'STORE' | null; subscriptionId: string | null };
export interface ProFeeTerms {
  version: string; items: { heading: string; text: string }[]; tick: string; amount: number; currencyCode: string; acknowledged: boolean;
  /** [REVIEW-G #2230 S3-1] The amount the pro's latest tick was given to (older APIs omit it), and whether the fee
   *  changed since: then the pro is asked again, at the new amount. */
  acknowledgedAmount?: number | null; acknowledgedCurrencyCode?: string | null; changed?: boolean;
}
export interface ProFeeView { data: unknown | null; standing?: ProFeeStanding; coveredBy?: 'STORE' | null; feeTerms?: ProFeeTerms }
export type ProFeeAck = { version: string; amount: number; currencyCode: string };

/** The pro's fee view; null when the person has no provider profile. */
export async function getProviderFee(): Promise<ProFeeView | null> {
  try {
    const body = await apiFetch('/api/v1/provider/subscription') as ProFeeView;
    return { data: body.data ?? null, standing: body.standing, coveredBy: body.coveredBy ?? null, feeTerms: body.feeTerms };
  } catch (err) {
    if (err instanceof ApiRequestError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
}

/** The pro's own profile: whether Swift approved their documents (the fee starts only after that). */
export async function getProviderApproval(): Promise<{ isVerified: boolean } | null> {
  try {
    const body = await apiFetch('/api/v1/services/providers/me') as { data?: { isVerified?: boolean } | null };
    return body.data ? { isVerified: body.data.isVerified === true } : null;
  } catch (err) {
    if (err instanceof ApiRequestError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
}

/** "I understand the weekly fee", as a pro: the words' version and the amount on screen. */
export function acknowledgeProviderFee(ack: ProFeeAck) {
  return apiFetch('/api/v1/provider/weekly-fee-ack', { method: 'POST', body: JSON.stringify(ack) });
}
