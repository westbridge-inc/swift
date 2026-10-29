// ---------------------------------------------------------------------------
// [CHAINS PR2 · owner 29 Oct 2026] One owner, many branches: the words and the small rules the website's branch
// pages share with the phone (apps/mobile/src/lib/branches.ts says the same things).
//
//  - A branch waiting for Swift's approval says so wherever it is named (the switcher, the branch list).
//  - The add-a-branch terms: a branch shares the owner's running free trial only if Swift approves it before that
//    trial ends (REVIEW-M #2211 S4-2), and the trial belongs to the business: a branch closed during it still uses it
//    up (REVIEW-M #2211 N1). With no running trial, the branch is billed from the day Swift approves it.
//  - Bulk actions (pause or take orders, copy hours) run one store at a time over each store's own route, so every
//    store's own checks apply; the result names each store that refused, with the server's words.
// ---------------------------------------------------------------------------

import { formatAmount } from './money';

export { WAITING_FOR_APPROVAL, branchLabel, isAwaitingApproval } from './branch-label';


const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Guyana' });

/** "29 October 2026", the day in Guyana. */
export function branchDay(iso: string): string {
  return DAY.format(new Date(iso));
}

/** "$15,000/week" (the server's amount; Guyana dollars read "$" as everywhere on the dashboard). */
export function weeklyFeeWords(amount: number, currencyCode: string): string {
  return `${formatAmount(amount, currencyCode === 'GYD' ? '$' : `${currencyCode} `)}/week`;
}

/** The trial line on the add-a-branch terms. */
export function branchTrialLine(sharedTrialEndsAt: string | null, fee: string): string {
  if (!sharedTrialEndsAt) return `Billed from the day Swift approves it: ${fee}.`;
  const day = branchDay(sharedTrialEndsAt);
  return `Free until ${day} if Swift approves it before ${day}. After that, ${fee}.`;
}

export const BRANCH_TRIAL_IS_THE_BUSINESS =
  'The free trial belongs to your business, not to one branch: a branch you close during the free trial still uses it up.';
export const BRANCH_IS_CHECKED =
  'A person at Swift checks every new branch before it goes live. If a branch still needs something from you first, the Branches page says what, with a button to finish it.';


/** "Your agreed rate: $12,000/week (or the branch's own fee, if lower)", or null with no deal. */
export function dealLine(dealWeeklyRate: number | null, dealCurrencyCode: string | null): string | null {
  if (dealWeeklyRate === null || !dealCurrencyCode) return null;
  return `Your agreed rate: ${weeklyFeeWords(dealWeeklyRate, dealCurrencyCode)} (or the branch’s own fee, if lower).`;
}

export interface BranchOutcome { storeId: string; ok: boolean; message?: string }

/** Run `act` for each store, one after another (never two writes at once), and say how each went. */
export async function forEachBranch(storeIds: readonly string[], act: (_storeId: string) => Promise<unknown>): Promise<BranchOutcome[]> {
  const out: BranchOutcome[] = [];
  for (const storeId of storeIds) {
    try {
      await act(storeId);
      out.push({ storeId, ok: true });
    } catch (e) {
      out.push({ storeId, ok: false, message: e instanceof Error && e.message ? e.message : 'That didn’t go through. Try again.' });
    }
  }
  return out;
}

/** "Done for 3 branches." / "Done for 2 of 3 branches. Not done: Camp Street: <the server's words>" */
export function branchOutcomeWords(outcomes: readonly BranchOutcome[], nameOf: (_storeId: string) => string): string {
  const done = outcomes.filter((o) => o.ok).length;
  const plural = (n: number) => `${n} ${n === 1 ? 'branch' : 'branches'}`;
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) return `Done for ${plural(done)}.`;
  const why = failed.map((o) => `${nameOf(o.storeId)}: ${o.message ?? 'not done'}`).join(' · ');
  return `Done for ${done} of ${plural(outcomes.length)}. Not done: ${why}`;
}

/** A key for one menu copy (kept across a retry, so the same copy is never written twice). */
export function newCopyKey(): string {
  const raw = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `copy${raw.replace(/-/g, '')}`.slice(0, 64);
}

/** What a menu copy did, in plain words. */
export function copyResultWords(r: { items: number; categories: number; photos: number; photosNotCopied: number; waitingForCheck: number; notAllowed: Array<{ name: string }> }): string[] {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const lines = [`Copied ${n(r.items, 'item', 'items')} in ${n(r.categories, 'section', 'sections')}, with ${n(r.photos, 'photo', 'photos')}.`];
  if (r.photosNotCopied > 0) lines.push(`${n(r.photosNotCopied, 'photo', 'photos')} could not be copied: add ${r.photosNotCopied === 1 ? 'it' : 'them'} again here.`);
  if (r.waitingForCheck > 0) lines.push(`${n(r.waitingForCheck, 'item waits', 'items wait')} for a quick check by Swift before customers see ${r.waitingForCheck === 1 ? 'it' : 'them'}.`);
  if (r.notAllowed.length > 0) lines.push(`Not copied, Swift doesn’t allow: ${r.notAllowed.map((i) => i.name).join(', ')}.`);
  lines.push('Stock counts are per branch: set this branch’s counts here.');
  return lines;
}

/** The team role as words (never the code). */
export const TEAM_ROLE_WORDS: Readonly<Record<'MANAGER' | 'STAFF', string>> = { MANAGER: 'Manager', STAFF: 'Staff' };
