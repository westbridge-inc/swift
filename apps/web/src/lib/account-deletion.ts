'use client';

import { BROWSER_CLIENT, apiFetch, clearSession } from '@/lib/auth';
import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';

// ---------------------------------------------------------------------------
// [WEB-DELETE · owner 1 Nov 2026] The website's calls for deleting an account: the app's own routes
// (apps/mobile services/api.ts customerApi.deleteAccount / requestAccountClosure), with the website's
// cookie session (lib/auth apiFetch: client header, expected account, refresh-and-retry).
// ---------------------------------------------------------------------------

export type DeletionSide = 'CUSTOMER' | 'RIDER' | 'DRIVER' | 'STORE';

/** GET /customer/account/deletion-check: what Delete would meet now, by the deletion's own rules and words. */
export interface DeletionCheck {
  /** REQUEST: a store or advertiser owner's account closes by a request the team completes. */
  closure: 'REQUEST' | 'DELETE';
  /** The person owns a store (what a closure does to it is shown). */
  ownsStore: boolean;
  closureRequest: { ticketId: string; status: string; requestedAt: string } | null;
  openOrders: { count: number; items: Array<{ id: string; orderNumber: string; status: string; orderType: string; createdAt: string; side: DeletionSide; storeName: string | null }> };
  openServiceJobs: { count: number; items: Array<{ id: string; status: string; scheduledFor: string | null; createdAt: string; side: 'CUSTOMER' | 'PROVIDER' }> };
  /** Money that must be settled first, in the deletion's own sentence. */
  settleFirst: { blockers: string[]; message: string } | null;
}

/** What DELETE /customer/account or the closure request answered. */
export interface DeletionReceipt {
  deleted: boolean;
  status?: string;
  message?: string;
  ticketId?: string;
}

const ACCOUNT = '/api/v1/customer/account';

export async function getDeletionCheck(): Promise<DeletionCheck> {
  return (await apiFetch(`${ACCOUNT}/deletion-check`, { cache: 'no-store' })).data as DeletionCheck;
}

/** receipts=v2: the website shows every receipt by its own message (as the app does); a business owner's
 *  account comes back as CLOSURE_REQUESTED, never as a deletion. */
export async function deleteMyAccount(): Promise<DeletionReceipt> {
  return (await apiFetch(`${ACCOUNT}?receipts=v2`, { method: 'DELETE' })).data as DeletionReceipt;
}

export async function requestAccountClosure(): Promise<DeletionReceipt> {
  return (await apiFetch(`${ACCOUNT}/closure-request`, { method: 'POST', body: '{}' })).data as DeletionReceipt;
}

/** Where the "Your account is deleted" page is. Public, and outside the pre-launch front door. */
export const DELETED_PAGE = '/account-deleted';
const RECEIPT_KEY = 'swift_web_deletion_receipt';

/** Hand the server's receipt to the deleted page (this tab only; it holds no personal data). */
export function stashDeletionReceipt(receipt: DeletionReceipt): void {
  try {
    window.sessionStorage.setItem(RECEIPT_KEY, JSON.stringify({ status: receipt.status ?? 'DELETED', message: receipt.message ?? null }));
  } catch {
    // Storage may be off: the page falls back to the status in its address.
  }
}

export function readDeletionReceipt(): { status: string; message: string | null } | null {
  try {
    const raw = window.sessionStorage.getItem(RECEIPT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { status?: unknown; message?: unknown };
    return typeof parsed.status === 'string' ? { status: parsed.status, message: typeof parsed.message === 'string' ? parsed.message : null } : null;
  } catch {
    return null;
  }
}

/**
 * [WEB-DELETE] The account behind this browser was deleted: the server already ended every session on every device,
 * so the cookies this browser still holds name none. Only the server can expire HttpOnly cookies: /auth/logout/refresh
 * needs no live session and clears both, whatever it finds (as lib/auth does for a closed demo). Then the local
 * sign-out. The deleted page calls this only once the server confirms no session is left, so a link to that page can
 * never sign anyone out. (Here, not in lib/auth: every page carries that module.)
 */
export async function endErasedSession(): Promise<void> {
  try {
    await fetch(`${BROWSER_API_ORIGIN}/api/v1/auth/logout/refresh`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Swift-Client': BROWSER_CLIENT }, body: '{}',
    });
  } catch {
    // Offline: the local sign-out still happens; the dead cookies name no session.
  }
  clearSession();
}
