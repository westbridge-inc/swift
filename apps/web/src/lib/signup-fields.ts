/**
 * [WEB-ONBOARDING · owner 1 Nov 2026: "before they type, an example has to be in the box, and if not they don't know
 * what to do; when they type it disappears"] The partner sign-up's boxes.
 *
 * - EXAMPLE: a greyed example in every box, gone once the person types (a placeholder). The app's own where it has
 *   one (apps/mobile MoverOnboardingScreen "Make (e.g. Toyota)", "Model (e.g. Allion)"); the taxi plate is the
 *   server's own H-series example (apps/api verification/hire-plate.ts). Made up, never a real person's details.
 * - LIMIT: the server's longest value for each box (apps/api partner/business-input.ts businessSchema,
 *   partner/partner.routes.ts vehicleSchema, auth/auth.routes.ts register), so nothing typed is refused afterwards.
 * - The asks: while the button waits, one line names the first thing missing, in the app's words (apps/mobile
 *   lib/storePin.ts businessSetupBlocker), held to the server's shortest values: a 1-letter business name used to
 *   reach the server and come back as "Invalid request data".
 * signup-fields.test.tsx holds the limits to the server's schemas and the words to the app's.
 */
export const EXAMPLE = {
  first: 'e.g. Asha',
  last: 'e.g. Persaud',
  business: 'e.g. Corner Basket',
  /** A store under its owner's own name is just the surname, with or without first names or initials (BNA s.3). */
  ownName: 'e.g. R. Persaud',
  street: 'e.g. 12 Regent Street',
  city: 'e.g. Georgetown',
  region: 'e.g. Demerara-Mahaica',
  make: 'e.g. Toyota',
  model: 'e.g. Allion',
  year: 'e.g. 2016',
  color: 'e.g. Silver',
  plate: 'e.g. HC 1234',
} as const;

export const LIMIT = { name: 50, business: 120, street: 200, city: 80, region: 80, make: 60, model: 60, year: 4, color: 40, plate: 20 } as const;

/** Under a partner's name: a person compares each document's name with the account's (NAME_MISMATCH). */
export const NAME_AS_ON_ID = 'Use your name as it is on your ID. A person checks your documents against it.';

/** The partner agreements by the documents' own titles (apps/api legal.routes.ts; the app and lib/legal-acceptance say the same). */
export const AGREEMENT = { business: 'Business Agreement', mover: 'Mover Agreement' } as const;
export const agreementAsk = (name: string) => `Tick the ${name} to continue`;

/** A store's first missing detail, in the order the form asks for them (the pin after the address its map starts from). */
export function businessAsk(b: { name: string; addressLine1: string; city: string }, pinned: boolean): string | null {
  if (b.name.trim().length < 2) return 'Name your business';
  if (b.addressLine1.trim().length < 3) return 'Add the street address';
  if (b.city.trim().length < 2) return 'Add the city or town';
  return pinned ? null : 'Place your store on the map';
}

/** A taxi's first missing detail. A non-H plate says why under the plate box itself (TAXI_PLATE_ERROR). */
export function taxiAsk(v: { make: string; model: string; color: string; licensePlate: string }, yearAccepted: boolean): string | null {
  if (!v.make.trim()) return 'Add the make';
  if (!v.model.trim()) return 'Add the model';
  if (!yearAccepted) return `Add the year the car was made: 1980 to ${new Date().getFullYear() + 1}`;
  if (!v.color.trim()) return 'Add the colour';
  return v.licensePlate.trim() ? null : 'Add the licence plate';
}
