/**
 * [FLOW-QA F6] Sign-up survives the phone's Back button and a refresh: each step is its own history entry
 * (/signup?step=…), and what was typed that is not a secret (the door, the phone number, the name; never the code)
 * is kept for this tab only (sessionStorage). The server's signup continuation cookie (HttpOnly) still proves the
 * phone at the name step; if it has gone, registration says to ask for a new code, as before.
 */
export const SIGNUP_STEPS = ['role', 'phone', 'code', 'name', 'business', 'vehicle'] as const;
export type SignupStep = (typeof SIGNUP_STEPS)[number];
/** Steps reached once the account exists: Back from one never reopens the steps that made the account. */
export const ACCOUNT_STEPS: readonly SignupStep[] = ['business', 'vehicle'];
export type SignupDraft = { step: SignupStep; role: string; phone: string; first: string; last: string };

const KEY = 'swift_signup_draft';

export function stepOf(search: string): SignupStep | null {
  const step = new URLSearchParams(search).get('step');
  return (SIGNUP_STEPS as readonly string[]).includes(step ?? '') ? (step as SignupStep) : null;
}
export function readDraft(): SignupDraft | null {
  try {
    const d = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as SignupDraft | null;
    return d && (SIGNUP_STEPS as readonly string[]).includes(d.step) ? d : null;
  } catch { return null; }
}
export function saveDraft(draft: SignupDraft): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(draft)); } catch { /* storage unavailable */ }
}
export function clearDraft(): void {
  try { sessionStorage.removeItem(KEY); sessionStorage.removeItem(BUSINESS_KEY); } catch { /* storage unavailable */ }
}

/**
 * [FLOW-QA2 NEW-6] What a store owner typed on the business step (name, type, address, the confirmed pin and the
 * name choice), kept for this tab too, so a refresh there does not empty the form. Never a tick: the own-name
 * declaration, the weekly fee and the agreement are ticked again on screen.
 */
const BUSINESS_KEY = 'swift_signup_business';
export type BusinessDraftKept = {
  biz: { name: string; vendorType: string; addressLine1: string; city: string; region: string };
  nameBasis: 'REGISTERED' | 'OWN_NAME';
  ownNameTick: boolean;
  storePin: { latitude: number; longitude: number; address: string | null } | null;
};
const isText = (v: unknown): v is string => typeof v === 'string';
export function saveBusinessDraft(draft: BusinessDraftKept): void {
  try { sessionStorage.setItem(BUSINESS_KEY, JSON.stringify({ ...draft, ownNameTick: false })); } catch { /* storage unavailable */ }
}
export function readBusinessDraft(): BusinessDraftKept | null {
  try {
    const d = JSON.parse(sessionStorage.getItem(BUSINESS_KEY) ?? 'null') as Partial<BusinessDraftKept> | null;
    const b = d?.biz;
    if (!d || !b || ![b.name, b.vendorType, b.addressLine1, b.city, b.region].every(isText)) return null;
    const p = d.storePin;
    const pin = p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) ? { latitude: p.latitude, longitude: p.longitude, address: isText(p.address) ? p.address : null } : null;
    return { biz: { name: b.name, vendorType: b.vendorType, addressLine1: b.addressLine1, city: b.city, region: b.region }, nameBasis: d.nameBasis === 'OWN_NAME' ? 'OWN_NAME' : 'REGISTERED', ownNameTick: false, storePin: pin };
  } catch { return null; }
}
/** The address of a step: the page's own address with ?step= set, every other parameter kept. */
export function stepUrl(step: SignupStep): string {
  const url = new URL(window.location.href);
  url.searchParams.set('step', step);
  return `${url.pathname}${url.search}${url.hash}`;
}
