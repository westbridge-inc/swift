// [WEB-ONBOARDING] Kept apart from taxi-documents.ts, which the sign-up page loads up front for one sentence: these
// lines are for the Documents page only, so the sign-up page's first load does not carry them (perf-budget).
import { isTaxiChecklist } from './taxi-documents';

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

/** What the reviewer checks on a mover's insurance (a taxi's or any delivery motor vehicle's) and, for a motorbike, the
 *  licence class. A bicycle's list (no licence) gets none; a taxi's other rows keep taxiDocumentHint. */
export function vehicleDocumentHint(docType: string, checklist: readonly string[], vehicleType?: string): string | undefined {
  if (isTaxiChecklist(checklist)) return docType === 'vehicle_insurance' ? TAXI_INSURANCE : undefined;
  if (!checklist.includes('drivers_licence')) return undefined;
  if (docType === 'vehicle_insurance') return DELIVERY_INSURANCE;
  return docType === 'drivers_licence' && vehicleType === 'MOTORCYCLE' ? MOTORBIKE_LICENCE : undefined;
}
