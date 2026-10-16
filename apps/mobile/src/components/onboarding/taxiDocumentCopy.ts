/**
 * [Owner ruling 11 Oct 2026 — HIRE LICENCE] Taxi drivers upload their normal driver's licence AND the
 * separate GRA Hire Car Driver's Licence (its own document, about 3 years). Nobody checks for an "H class"
 * on the plastic licence any more (many real licences do not show one). Said plainly wherever a taxi
 * driver meets the documents: sign-up, the checklist and help. (Supersedes the 8 Oct "licence must
 * include the hire-car class" wording.) The H-series plate rule stays (owner ruling, same day).
 */
export const TAXI_TWO_LICENCES =
  "For taxi work you upload two licences: your normal driver's licence, and your separate Hire Car Driver's Licence from GRA (it lasts about 3 years). Your normal licence does not need to show a hire class.";

/** One line under a document on a TAXI checklist (the list that asks for the Hire Car Driver's Licence). */
const TAXI_DOC_HINTS: Record<string, string> = {
  drivers_licence: "Your normal driver's licence (plastic card or red book). It does not need to show a hire class.",
  hire_car_driver_licence: "Your own Hire Car Driver's Licence from GRA — a separate licence, not a class on your normal licence. Usually valid 3 years.",
  hire_car_vehicle_licence: "The car's yearly hire licence — the one shown on the car.",
  vehicle_registration: 'Your Certificate of Registration. Taxi plates start with H — e.g. HC 1234.',
};

/** The checklist is a taxi's when it asks for the Hire Car Driver's Licence. */
export function isTaxiChecklist(checklist: readonly string[]): boolean {
  return checklist.includes('hire_car_driver_licence');
}

export function taxiDocumentHint(docType: string, checklist: readonly string[]): string | undefined {
  return isTaxiChecklist(checklist) ? TAXI_DOC_HINTS[docType] : undefined;
}

/** The FAQ answer: what a taxi driver needs, in plain words. */
export const TAXI_DOCUMENTS_FAQ = {
  q: 'What documents does a taxi driver need?',
  a: "Seven: your normal driver's licence; your separate Hire Car Driver's Licence from GRA (your normal licence does not need to show a hire class); your car's Certificate of Registration with an H plate (e.g. HC 1234); the car's yearly hire licence; its certificate of fitness; insurance that covers carrying passengers for hire; and one photo of the car with the plate clearly visible. A police clearance is optional.",
};
