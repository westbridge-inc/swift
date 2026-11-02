/**
 * [Owner ruling 11 Oct 2026 — HIRE LICENCE] Taxi drivers upload their normal driver's licence AND the
 * separate GRA Hire Car Driver's Licence (its own document, about 3 years); nobody checks for an "H
 * class" on the plastic licence. Said plainly at sign-up, on the documents page and in the FAQ — the
 * same words as the app (apps/mobile components/onboarding/taxiDocumentCopy.ts). The H-series plate
 * rule stays (owner ruling, same day).
 */
export const TAXI_TWO_LICENCES =
  "For taxi work you upload two licences: your normal driver's licence, and your separate Hire Car Driver's Licence from GRA (it lasts about 3 years). Your normal licence does not need to show a hire class.";

const LABELS: Record<string, string> = {
  drivers_licence: "Driver's licence",
  hire_car_driver_licence: "Hire Car Driver's Licence",
  hire_car_vehicle_licence: "Car's hire licence (yearly)",
  vehicle_registration: 'Certificate of Registration',
  vehicle_exterior_photo: 'Car photo (plate clearly visible)',
  fitness_cert: 'Certificate of fitness',
  national_id: 'National ID or Digital ID card',
};

/**
 * [WEB-ONBOARDING · R13 · owner 15 Oct 2026] Every motor vehicle's insurance must permit use for hire or reward: a person
 * reads the policy's limitations as to use and refuses a private-use policy (apps/api verification.service
 * V_INSURANCE_SCOPE, rejected as INSURANCE_NOT_HIRE). Said where the policy is uploaded, so a rider or driver does not
 * learn it from a rejection; the words follow the server's rejection and the drivers page.
 */
export const TAXI_INSURANCE = 'Your insurance must permit use for hire or reward, covering passengers carried for hire. A private-use policy is not accepted.';
export const DELIVERY_INSURANCE = 'Your insurance must permit use for hire or reward (commercial use). A private-use policy is not accepted.';
/** The law's licence: one for the class of vehicle ridden on a road (apps/api doc-registry drivers_licence basis). */
export const MOTORBIKE_LICENCE = "Your driver's licence must cover motorcycles, the class of vehicle you ride.";

const TAXI_HINTS: Record<string, string> = {
  drivers_licence: "Your normal driver's licence (plastic card or red book). It does not need to show a hire class.",
  hire_car_driver_licence: "Your own Hire Car Driver's Licence from GRA — a separate licence, not a class on your normal licence. Usually valid 3 years.",
  hire_car_vehicle_licence: "The car's yearly hire licence — the one shown on the car.",
  vehicle_registration: 'Taxi plates start with H — e.g. HC 1234.',
  vehicle_insurance: TAXI_INSURANCE,
};

export const isTaxiChecklist = (checklist: readonly string[]) => checklist.includes('hire_car_driver_licence');
export const documentLabel = (docType: string) => LABELS[docType] ?? docType.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const taxiDocumentHint = (docType: string, checklist: readonly string[]) => (isTaxiChecklist(checklist) ? TAXI_HINTS[docType] : undefined);

/** [WEB-ONBOARDING] On a delivery rider's motor-vehicle list (a licence, and not a taxi's): the insurance rule for every
 *  motor vehicle, and for a motorbike the licence class. A bicycle's list (no licence) and a taxi's get none from here. */
export function deliveryDocumentHint(docType: string, checklist: readonly string[], vehicleType?: string): string | undefined {
  if (isTaxiChecklist(checklist) || !checklist.includes('drivers_licence')) return undefined;
  if (docType === 'vehicle_insurance') return DELIVERY_INSURANCE;
  return docType === 'drivers_licence' && vehicleType === 'MOTORCYCLE' ? MOTORBIKE_LICENCE : undefined;
}
