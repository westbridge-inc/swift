import type { AuthSessionSnapshot } from '../lib/authSession';
import { riderApi, vendorApi } from '../services/api';
import { requireAuthSessionForPrincipal } from '../stores/authStore';

export interface RiderCashSettlementConfirmation {
  id: string;
  amount: number;
  authSession: AuthSessionSnapshot;
}

export interface VendorCashSettlementConfirmation extends RiderCashSettlementConfirmation {
  storeId: string | null;
}

export function captureRiderCashSettlementConfirmation(
  id: string,
  amount: number,
  authSession: AuthSessionSnapshot,
): RiderCashSettlementConfirmation {
  return { id, amount, authSession };
}

export function captureVendorCashSettlementConfirmation(
  id: string,
  amount: number,
  storeId: string | null,
  authSession: AuthSessionSnapshot,
): VendorCashSettlementConfirmation {
  return { id, amount, storeId, authSession };
}

/** Fail a retained confirmation closed after logout or account replacement.
 * Token rotation inside the same login boundary is allowed and returns the
 * principal's current credentials for the request. */
export function requireCurrentCashSettlementConfirmation(
  confirmation: RiderCashSettlementConfirmation,
): AuthSessionSnapshot {
  return requireAuthSessionForPrincipal(confirmation.authSession);
}

export async function confirmRiderCashSettlement(
  confirmation: RiderCashSettlementConfirmation,
): Promise<unknown> {
  const current = requireCurrentCashSettlementConfirmation(confirmation);
  const response = await riderApi.confirmCashSettlement(
    confirmation.id,
    confirmation.amount,
    current,
  );
  requireCurrentCashSettlementConfirmation(confirmation);
  return response?.data?.data;
}

export async function confirmVendorCashSettlement(
  confirmation: VendorCashSettlementConfirmation,
): Promise<unknown> {
  const current = requireCurrentCashSettlementConfirmation(confirmation);
  const response = await vendorApi.confirmCashSettlement(
    confirmation.id,
    confirmation.amount,
    current,
    confirmation.storeId,
  );
  requireCurrentCashSettlementConfirmation(confirmation);
  return response?.data?.data;
}
