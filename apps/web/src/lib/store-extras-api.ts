import { apiFetch } from './auth';

// ---------------------------------------------------------------------------
// [WEB-SETTINGS PR-B · owner 31 Oct 2026] The rest of the phone's store Account on the website: promotions (the
// phone's PromosSection) and "Review your categories" (VendorCategoryReviewScreen). [CHECKLIST-LEGAL · owner 1 Nov 2026
// (a)] No seller status any more: the self-declared tier and its limits are removed.
// The same routes the phone calls (apps/mobile/src/services/api.ts), all manager and owner on the server. Kept out of
// lib/vendor-api so only these pages load them.
// ---------------------------------------------------------------------------

const V = '/api/v1/vendor';

export type Promo = {
  id: string;
  code: string;
  description?: string | null;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discountValue: number | string;
  minOrderAmount?: number | string | null;
  validUntil: string;
  isActive: boolean;
  currentUses: number;
};
export type NewPromo = {
  code: string;
  description: string;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discountValue: number;
  minOrderAmount?: number;
  validUntil: string;
};

export const getPromos = () => apiFetch(`${V}/promos`).then((r) => (Array.isArray(r.data) ? r.data : []) as Promo[]);
export const createPromo = (body: NewPromo) => apiFetch(`${V}/promos`, { method: 'POST', body: JSON.stringify(body) });
export const setPromoActive = (id: string, isActive: boolean) =>
  apiFetch(`${V}/promos/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ isActive }) });
export const deletePromo = (id: string) => apiFetch(`${V}/promos/${encodeURIComponent(id)}`, { method: 'DELETE' });


export type CategoryGroup = {
  itemId: string;
  itemName: string;
  imageUrl: string | null;
  suggestions: Array<{ id: string; slug: string; name: string; confidence: number; stage: string }>;
};
export const getCategorySuggestions = () =>
  apiFetch(`${V}/category-suggestions`).then((r) => (Array.isArray(r.data) ? r.data : []) as CategoryGroup[]);
export const resolveCategorySuggestion = (id: string, action: 'accept' | 'dismiss') =>
  apiFetch(`${V}/category-suggestions/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
