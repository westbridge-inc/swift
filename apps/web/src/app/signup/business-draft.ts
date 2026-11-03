import { BUSINESS_KEY } from '@/lib/signup-draft';

/**
 * [FLOW-QA2 NEW-6] What a store owner typed on the business step (name, type, address, the confirmed pin and the
 * name choice), kept for this tab too, so a refresh there does not empty the form. Never a tick: the own-name
 * declaration, the weekly fee and the agreement are ticked again on screen.
 */
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
