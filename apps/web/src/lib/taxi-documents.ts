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

const TAXI_HINTS: Record<string, string> = {
  drivers_licence: "Your normal driver's licence (plastic card or red book). It does not need to show a hire class.",
  hire_car_driver_licence: "Your own Hire Car Driver's Licence from GRA — a separate licence, not a class on your normal licence. Usually valid 3 years.",
  hire_car_vehicle_licence: "The car's yearly hire licence — the one shown on the car.",
  vehicle_registration: 'Taxi plates start with H — e.g. HC 1234.',
};

export const isTaxiChecklist = (checklist: readonly string[]) => checklist.includes('hire_car_driver_licence');
export const documentLabel = (docType: string) => LABELS[docType] ?? docType.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const taxiDocumentHint = (docType: string, checklist: readonly string[]) => (isTaxiChecklist(checklist) ? TAXI_HINTS[docType] : undefined);
