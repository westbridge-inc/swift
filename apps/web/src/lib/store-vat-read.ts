import { apiFetch } from './auth';

// [STORE-VAT · owner O-5 · perf-budget] The one VAT read the Products page and the settings card share (the writes are in
// store-vat-api.ts, which only the settings card loads).

export type StoreVatStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';
export interface StoreVatView {
  /** False while Swift's STORE_VAT switch is off: nobody can start VAT. */
  available: boolean;
  status: StoreVatStatus;
  mode: 'PRICES_INCLUDE_VAT' | 'ADD_VAT_AT_CHECKOUT' | null;
  /** [owner ruling 31 Oct 2026] An approved store's change of choice, waiting for a person (an older server sends none). */
  modeRequested?: 'PRICES_INCLUDE_VAT' | 'ADD_VAT_AT_CHECKOUT' | null;
  vatRegistrationNumber: string | null;
  /** True while this store's new orders carry VAT. */
  effective: boolean;
  /** [VAT-DOCS] True while Swift adds VAT to the prices this store types (an older server sends none). */
  addsVatToPrices?: boolean;
  approved: { number: string | null; registeredName: string | null; effectiveFrom: string | null; reviewedAt: string | null } | null;
  reviewNote: string | null;
  certificate: { id: string; status: string; state: string; reviewNote: string | null; createdAt: string; reviewedAt: string | null } | null;
  ratePercent: number;
  modesOffered: string[];
  sources: string[];
}
export const getStoreVat = () => apiFetch('/api/v1/vendor/vat').then((r) => r.data as StoreVatView);
/** [SPEED 30 Oct] What the settings page's VAT report link needs from the same read: the store's VAT status ('NONE' when unanswered). */
export const vatStatusOf = (view: StoreVatView | undefined): string => (view as { status?: string } | undefined)?.status ?? 'NONE';
