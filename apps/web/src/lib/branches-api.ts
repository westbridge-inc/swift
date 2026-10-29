// [CHAINS PR2 · owner 29 Oct 2026] The branch pages' calls, kept out of lib/vendor-api: the dashboard shell imports
// vendor-api on every console page, and these are only for the Branches, Add a branch and Team pages.
import { apiFetch } from './auth';
import { normalizeVendorOrder, type VendorOrder } from './vendor-api';

const V = '/api/v1/vendor';

// ── [CHAINS PR2] Branches: one owner, many stores ───────────────────────────
// The add-a-branch screen reads the terms first (owner only), then sends the same business details sign-up sends,
// with the weekly fee ticked for THIS branch (the server asks this browser to confirm it's you: lib/step-up).
export interface BranchTerms {
  weeklyFee: { amount: number; currencyCode: string; tier?: string | null; version: string };
  terms: { version: string; items: { heading: string; text: string }[]; tick: string } | null;
  sharedTrialEndsAt: string | null;
  stores: number;
  limit: number;
  dealWeeklyRate: number | null;
  dealCurrencyCode: string | null;
  /** [REVIEW-F #2220 S3-1] A restaurant branch's food handlers tick: the server's words and version (null otherwise). */
  foodHandlers?: { version: string; tick: string } | null;
}
export interface BranchBusiness {
  name: string; vendorType: string; phone: string; addressLine1: string; city: string; region?: string;
  latitude: number; longitude: number;
}
export const getBranchTerms = (vendorType: string) =>
  apiFetch(`${V}/stores/branch-terms?vendorType=${encodeURIComponent(vendorType)}`).then((r) => r.data as BranchTerms);
export const addBranch = (body: {
  business: BranchBusiness; weeklyFeeAck: { version: string; amount: number; currencyCode: string };
  /** [REVIEW-F #2220 S3-1] The number customers can call (required), and a restaurant's food handlers tick. */
  publicPhone: string; foodHandlers?: { accept: true; attestationVersion: string };
}) =>
  apiFetch(`${V}/stores`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.data as { id: string; name: string; status: string });

export interface BranchFigures { orders: number; revenue: number }
export interface BranchSummaryRow {
  vendorId: string; name: string; city: string | null;
  today: BranchFigures; week: BranchFigures; month: BranchFigures; pendingOrders: number; queueValue: number;
}
export interface BranchesSummary {
  branches: BranchSummaryRow[];
  total: { today: BranchFigures; week: BranchFigures; month: BranchFigures; pendingOrders: number; queueValue: number };
}
export const getStoresSummary = () => apiFetch(`${V}/stores/summary`).then((r) => r.data as BranchesSummary);

/** Every branch's orders in one list (the server names each order's store: `vendor`). */
/** An order on the all-branches board: the server names its store (`vendor`: id and name). */
export type BranchOrder = Omit<VendorOrder, 'vendor'> & { vendor?: { id: string; name: string } | null };
export const getAllBranchOrders = (limit = 100): Promise<BranchOrder[]> =>
  apiFetch(`${V}/orders?scope=all&page=1&limit=${limit}`).then((r) => {
    const rows: unknown[] = Array.isArray(r.data) ? r.data : [];
    return rows.map((row) => normalizeVendorOrder(row) as BranchOrder);
  });

/** One store's request while another store is selected: the header names that store, the page keeps its own. */
const atStore = (storeId: string) => ({ 'x-vendor-id': storeId });
export const toggleOrdersAt = (storeId: string, acceptingOrders: boolean) =>
  apiFetch(`${V}/vendor/toggle-orders`, { method: 'PUT', body: JSON.stringify({ acceptingOrders }), headers: atStore(storeId) });
export const putHoursAt = (storeId: string, hours: Array<{ dayOfWeek: number; openTime?: string; closeTime?: string; isClosed: boolean }>) =>
  apiFetch(`${V}/hours`, { method: 'PUT', body: JSON.stringify({ hours }), headers: atStore(storeId) });

// ── Team (the selected store; owner only) ────────────────────────────────────
export interface StaffMember {
  id: string; role: 'MANAGER' | 'STAFF'; userId?: string;
  user?: { id?: string; firstName?: string | null; lastName?: string | null; phone?: string | null } | null;
}
export const getStaff = () => apiFetch(`${V}/staff`).then((r) => (Array.isArray(r.data) ? r.data : []) as StaffMember[]);
/** `vendorIds`: the branches this one person joins in the same step (the selected store when absent). */
export const addStaff = (body: { phone: string; role: 'MANAGER' | 'STAFF'; vendorIds?: string[] }) =>
  apiFetch(`${V}/staff`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.data as { message?: string });
export const updateStaffRole = (id: string, role: 'MANAGER' | 'STAFF') =>
  apiFetch(`${V}/staff/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ role }) });
export const removeStaff = (id: string) =>
  apiFetch(`${V}/staff/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ── Menu copy (into the selected, still-empty branch) ────────────────────────
export interface MenuCopyResult {
  fromStoreId: string; categories: number; items: number; options: number; photos: number; photosNotCopied: number;
  waitingForCheck: number; notAllowed: Array<{ name: string }>; replayed: boolean;
}
export const copyMenu = (fromStoreId: string, copyKey: string) =>
  apiFetch(`${V}/menu/copy`, { method: 'POST', body: JSON.stringify({ fromStoreId, copyKey }) }).then((r) => r.data as MenuCopyResult);
