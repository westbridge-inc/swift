'use client';

// The earner portal is a pure client on the existing rider/driver/verification
// endpoints — account, earnings, history and documents. Live dispatch stays on
// the phone by design (GPS + push belong in the field).
import { ApiRequestError, apiFetch } from './auth';

// [W-10] This used to be `soft()`: `.catch(() => null)` on every read, so a
// 500, an offline phone or a schema change was indistinguishable from "you
// have no debt", "you have no earnings" and "no store owes you anything". A
// mover decides whether to keep working on exactly those figures.
//
// Absence is a fact the SERVER states, and it states it precisely: 404 when the
// profile does not exist, 403 when the account is not a mover at all (see
// `throwForMissingProfile` in the API). Those two are knowledge and become
// `null`. Everything else is ignorance and must reach the page as an error, so
// the page can say so instead of rendering a confident zero.
const ABSENCE_STATUSES = new Set([403, 404]);

const absentOrThrow = <T,>(p: Promise<{ data: T }>): Promise<T | null> =>
  p.then((r) => r.data).catch((err) => {
    if (err instanceof ApiRequestError && ABSENCE_STATUSES.has(err.status)) return null;
    throw err;
  });

// ── Profiles: a mover may be a rider, a driver, or both ─────────────────────
export const getRiderProfile = () => absentOrThrow<Record<string, unknown>>(apiFetch('/api/v1/rider/profile'));
export const getDriverProfile = () => absentOrThrow<Record<string, unknown>>(apiFetch('/api/v1/driver/profile'));

// ── Earnings ────────────────────────────────────────────────────────────────
export const getRiderSummary = () => absentOrThrow<{
  today: { total: number; count: number };
  thisWeek: { total: number; count: number };
  thisMonth: { total: number; count: number };
  allTime: { total: number; count: number };
  pendingPayout: number;
}>(apiFetch('/api/v1/rider/earnings/summary'));

export const getRiderEarnings = (page = 1) =>
  apiFetch(`/api/v1/rider/earnings?page=${page}&limit=25`).then((r) => ({
    rows: r.data as Array<{ id: string; orderNumber: string | null; vendorName: string | null; type: string; amount: number; status: string; createdAt: string }>,
    meta: r.meta,
    totalAmount: r.totalAmount as number,
  }));

export const getDriverEarnings = (page = 1) =>
  apiFetch(`/api/v1/driver/earnings?page=${page}&limit=25`).then((r) => ({
    rows: r.data as Array<{ id: string; type: string; amount: number | string; status: string; createdAt: string }>,
    meta: r.meta,
    totalEarnings: Number(r.totalEarnings ?? 0),
  }));

// ── History ─────────────────────────────────────────────────────────────────
export const getRiderDeliveries = (page = 1) =>
  apiFetch(`/api/v1/rider/orders?page=${page}&limit=25`).then((r) => ({ rows: r.data as Array<Record<string, unknown>>, meta: r.meta }));
export const getDriverRides = (page = 1) =>
  apiFetch(`/api/v1/driver/rides?page=${page}&limit=25`).then((r) => ({ rows: r.data as Array<Record<string, unknown>>, meta: r.meta }));

// ── Money & subscription ────────────────────────────────────────────────────
export const getRiderSubscription = () => absentOrThrow<Record<string, unknown>>(apiFetch('/api/v1/rider/subscription'));
export const getDriverSubscription = () => absentOrThrow<Record<string, unknown>>(apiFetch('/api/v1/driver/subscription'));
export const getRiderCashSettlements = () => absentOrThrow<{
  summary: { owed: number; count: number };
  unsettled: Array<Record<string, unknown>>;
  settled: Array<Record<string, unknown>>;
}>(apiFetch('/api/v1/rider/cash-settlements'));
export const confirmRiderSettlement = (id: string) =>
  apiFetch(`/api/v1/rider/cash-settlements/${id}/confirm`, { method: 'POST', body: '{}' });
export const updateDriverProfile = (body: Record<string, unknown>) =>
  apiFetch('/api/v1/driver/profile', { method: 'PUT', body: JSON.stringify(body) });

// ── Documents (verification) ────────────────────────────────────────────────
export interface DocStatus {
  checklist: string[];
  documents: Array<{ id: string; docType: string; status: string; expiresAt: string | null; reviewNote: string | null; createdAt: string }>;
  missing: string[];
  vehicleType?: string | null;
  roleVerified: boolean;
}
export const getVerificationStatus = (vehicleType?: string) =>
  apiFetch(`/api/v1/verification/status?role=MOVER${vehicleType ? `&vehicleType=${vehicleType}` : ''}`).then(
    (r) => r.data as DocStatus,
  );
export const uploadVerificationFile = (file: File) => {
  const form = new FormData();
  form.append('file', file);
  return apiFetch('/api/v1/verification/upload', { method: 'POST', body: form }).then(
    (r) => r.data as { url: string },
  );
};
export const submitVerificationDocument = (docType: string, fileUrl: string) =>
  apiFetch('/api/v1/verification/documents', {
    method: 'POST',
    // consent: the uploader ticks the privacy-notice box before this fires (DPA §3.5)
    body: JSON.stringify({ role: 'MOVER', docType, fileUrl, consent: true, privacyNoticeVersion: 'web-v1' }),
  });
