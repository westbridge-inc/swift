/**
 * [R26 · legal research G2] The words of the fresh acceptance tick (phone build 12), the same as the website's
 * (apps/web components/legal-acceptance-gate.tsx acceptLabel): every document the person accepts, by name.
 */
export type AgreementKind = 'driver_agreement' | 'vendor_agreement';
export interface LegalAcceptance {
  currentVersion: string;
  acceptedVersion: string | null;
  needsAcceptance: boolean;
  summary: string[];
  agreements: AgreementKind[];
}

export const AGREEMENT_LABEL: Record<AgreementKind, string> = { driver_agreement: 'Mover Agreement', vendor_agreement: 'Business Agreement' };
export const AGREEMENT_PATH: Record<AgreementKind, string> = { driver_agreement: 'driver-agreement', vendor_agreement: 'vendor-agreement' };

export function acceptLabel(s: Pick<LegalAcceptance, 'agreements' | 'acceptedVersion'>): string {
  const docs = ['Terms of Service', 'Privacy Policy', ...s.agreements.map((a) => AGREEMENT_LABEL[a])];
  const list = docs.length > 2 ? `${docs.slice(0, -1).join(', ')} and ${docs[docs.length - 1]}` : docs.join(' and ');
  return `I agree to the ${s.acceptedVersion ? 'updated ' : ''}${list}.`;
}

export const acceptTitle = (s: Pick<LegalAcceptance, 'acceptedVersion'>) => (s.acceptedVersion ? 'We’ve updated our Terms' : 'Please accept our Terms');
export const DECLINE_LINE = 'If you do not accept, you can stop using Swift and delete your account (Profile › Personal data › Delete my account).';
