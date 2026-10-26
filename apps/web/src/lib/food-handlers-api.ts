// [FOOD-PERMIT · perf] The food handlers tick's two calls live apart from vendor-api.ts, which every dashboard page
// loads: only the settings card uses them (dashboard pages stay inside their first-load ceilings).
import { apiFetch } from './auth';

/** [FOOD-PERMIT · owner 24 Oct 2026] A registered restaurant's food handlers tick: the server's words, their version and
 *  each of the owner's registered restaurants (GET /verification/status?role=RESTAURANT → foodHandlerAttestation). */
export interface FoodHandlerAttestation { version: string; tick: string; stores: Array<{ vendorId: string; name: string; attested: boolean }> }
export const getFoodHandlers = (): Promise<FoodHandlerAttestation | null> =>
  apiFetch('/api/v1/verification/status?role=RESTAURANT').then((r) => (r.data?.foodHandlerAttestation ?? null) as FoodHandlerAttestation | null);
/** The owner ticks for the selected store (the request carries its x-vendor-id), in the server's version of the words. */
export const tickFoodHandlers = (version: string) =>
  apiFetch('/api/v1/vendor/onboarding/food-handlers', { method: 'POST', body: JSON.stringify({ accept: true, attestationVersion: version }) }).then((r) => r.data);
