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
