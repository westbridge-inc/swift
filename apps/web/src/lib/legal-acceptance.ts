import { apiFetch } from './auth';
import { LEGAL_URL } from './legal-url';

/**
 * [Legal research G2 · R26] The fresh acceptance tick: GET /auth/legal-acceptance says whether the signed-in
 * person must accept the served legal texts again (a material change since they last accepted, or never), and
 * what changed in short; POST records the tick in the consent ledger.
 */
export interface LegalAcceptance {
  currentVersion: string;
  acceptedVersion: string | null;
  needsAcceptance: boolean;
  summary: string[];
  agreements: Array<'driver_agreement' | 'vendor_agreement'>;
}

export async function getLegalAcceptance(): Promise<LegalAcceptance> {
  const json = await apiFetch('/api/v1/auth/legal-acceptance', undefined, { redirectOnExpired: false });
  return json.data as LegalAcceptance;
}

export async function acceptLegal(version: string): Promise<LegalAcceptance> {
  const json = await apiFetch('/api/v1/auth/legal-acceptance', { method: 'POST', body: JSON.stringify({ version, accept: true }) }, { redirectOnExpired: false });
  return json.data as LegalAcceptance;
}

export const AGREEMENT_LINKS: Record<LegalAcceptance['agreements'][number], { label: string; href: string }> = {
  driver_agreement: { label: 'Mover Agreement', href: LEGAL_URL('driver-agreement') },
  vendor_agreement: { label: 'Business Agreement', href: LEGAL_URL('vendor-agreement') },
};

/** [BILL-PRO PR6 · REVIEW-F #2231 S4] A page asks the site's legal-acceptance gate to read the server again (the pro fee
 *  page's "Review the agreement"), and the gate says when a tick was recorded, so a page that depends on it (the pro's
 *  standing and fee) reads its own data again (REVIEW-F #2231 S3-4). */
export const LEGAL_RECHECK_EVENT = 'swift:legal-acceptance-recheck';
export const LEGAL_ACCEPTED_EVENT = 'swift:legal-accepted';
export function askLegalAcceptanceAgain(): void {
  window.dispatchEvent(new Event(LEGAL_RECHECK_EVENT));
}
