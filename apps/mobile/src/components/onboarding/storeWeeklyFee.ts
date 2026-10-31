// [RETIER PR-A2 · owner 30 Oct 2026] A new store's weekly fee follows its own catalogue when Swift approves it. Above
// the first step, the store goes live only after its owner reads that exact fee and ticks "I understand the weekly
// fee" for it. Everything here is the server's (GET /vendor/onboarding/weekly-fee): the amount, the currency, why, the
// words and their version. The app never supplies a figure or the words itself, so an older server — or a malformed
// answer — shows no card. No React Native imports: the card and its tests share it.

import { feeMoney } from '../../lib/fee-status';
import { moneyIn } from '../../lib/money';

export interface StoreFeeItem { heading: string; text: string }

/** [REVIEW-F S4-1 on #2246] The fee as every phone fee screen names it (GY$45,000); another currency keeps its code. */
export function storeFeeMoney(fee: Pick<StoreFeeToTick, 'amount' | 'currencyCode'>): string {
  return fee.currencyCode === 'GYD' ? feeMoney(fee.amount) : moneyIn(fee.amount, fee.currencyCode);
}

export interface StoreFeeToTick {
  /** The store the fee is for: the tick is sent for this store only. */
  vendorId: string;
  amount: number;
  currencyCode: string;
  version: string;
  why: string | null;
  items: StoreFeeItem[];
  tick: string;
}

/** The fee the owner of `vendorId` still has to read and tick, or null (nothing to tick, already ticked, no words, or an
 *  answer about another store). */
export function storeFeeToTick(view: unknown, vendorId: string | null | undefined): StoreFeeToTick | null {
  const v = view as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== 'object' || v['required'] !== true || v['ticked'] !== false) return null;
  if (!vendorId || v['vendorId'] !== vendorId) return null;
  const fee = v['weeklyFee'] as Record<string, unknown> | null | undefined;
  const terms = v['terms'] as Record<string, unknown> | null | undefined;
  // A weekly fee is a whole number of currency units: the box is ticked to exactly the amount shown.
  if (!fee || typeof fee['amount'] !== 'number' || !Number.isInteger(fee['amount']) || !(fee['amount'] > 0) || typeof fee['currencyCode'] !== 'string' || typeof fee['version'] !== 'string') return null;
  if (!terms || typeof terms['tick'] !== 'string' || !terms['tick'] || terms['version'] !== fee['version'] || !Array.isArray(terms['items'])) return null;
  const items = (terms['items'] as unknown[]).filter((i): i is StoreFeeItem => {
    const r = i as Partial<StoreFeeItem> | null;
    return !!r && typeof r.heading === 'string' && typeof r.text === 'string';
  });
  if (items.length === 0) return null;
  return {
    vendorId, amount: fee['amount'], currencyCode: fee['currencyCode'], version: fee['version'],
    why: typeof v['why'] === 'string' && v['why'] ? v['why'] : null, items, tick: terms['tick'],
  };
}

/** The tick as the server takes it: the store, the words' version and the exact fee the owner saw. */
export function storeFeeAck(fee: StoreFeeToTick): { vendorId: string; weeklyFeeAck: { version: string; amount: number; currencyCode: string } } {
  return { vendorId: fee.vendorId, weeklyFeeAck: { version: fee.version, amount: fee.amount, currencyCode: fee.currencyCode } };
}

/** What a tick is given to: the store, the words' version, the amount and the currency on screen. A ticked box counts
 *  only while the fee on screen is still exactly this (a refetch that brings another amount empties it). */
export function storeFeeKey(fee: Pick<StoreFeeToTick, 'vendorId' | 'version' | 'amount' | 'currencyCode'>): string {
  return `${fee.vendorId}:${fee.version}:${fee.amount}:${fee.currencyCode}`;
}

/** Roles whose checklist is a store's (a Services business included). */
export const STORE_ROLES: ReadonlySet<string> = new Set(['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE']);

/** The card reads anything only for a store role, a named store, and its OWNER (a manager never sees or ticks it). */
export function storeFeeCardEnabled(role: string, scope: { vendorId?: string | null; isOwner?: boolean } | null | undefined): boolean {
  return STORE_ROLES.has(role) && scope?.isOwner === true && typeof scope.vendorId === 'string' && scope.vendorId.length > 0;
}

/** [REVIEW-F #2246 S3-1] What the card shows: nothing (not this person's to tick, still loading, nothing to tick, or
 *  an answer about another store), the fee to tick, or — when the read FAILED, or the server says a tick is needed but
 *  its answer cannot be read — an error with Try again. A failed read is never shown as nothing to do. */
export type StoreFeeCardView = { kind: 'none' } | { kind: 'error' } | { kind: 'tick'; fee: StoreFeeToTick };
export function storeFeeCardView(
  role: string, scope: { vendorId?: string | null; isOwner?: boolean } | null | undefined, read: { data: unknown; isError: boolean },
): StoreFeeCardView {
  if (!storeFeeCardEnabled(role, scope)) return { kind: 'none' };
  if (read.isError) return { kind: 'error' };
  const v = read.data as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== 'object' || v['vendorId'] !== scope!.vendorId) return { kind: 'none' };
  const fee = storeFeeToTick(v, scope!.vendorId);
  if (fee) return { kind: 'tick', fee };
  return v['required'] === true && v['ticked'] === false ? { kind: 'error' } : { kind: 'none' };
}

/** Is the box ticked for the fee on screen now? Only when the tick was given to exactly this store, version, amount and
 *  currency: a fee that changed under it is not ticked. */
export function tickHolds(tickedKey: string | null, fee: StoreFeeToTick | null): boolean {
  return !!fee && tickedKey !== null && tickedKey === storeFeeKey(fee);
}
