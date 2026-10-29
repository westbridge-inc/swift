// ---------------------------------------------------------------------------
// [CHAINS PR2 · owner 29 Oct 2026] One owner, many branches: the words and the small rules the branch screens share.
// The server decides everything (the shared trial, the fee, approval); these only say it.
//  - A branch added while the business's free trial runs shares that trial, but only from the day Swift approves it:
//    the date holds only if Swift approves it before then (REVIEW-M #2211 S4-2).
//  - The free trial belongs to the business, not to one branch: closing a branch during it does not give it back
//    (REVIEW-M #2211 N1).
//  - Every new branch waits for a person at Swift before it goes live.
//  - Bulk open/pause and bulk hours are done one branch at a time over each branch's own routes, so every branch's
//    own rules still apply; the result says which branches did not take it, in the server's words.
// ---------------------------------------------------------------------------

import type { FeeTerms, FeeTick } from './partnerPricing';

export const BRANCH_COPY = {
  waiting: 'waiting for Swift’s approval',
  checkFirst: 'Swift checks every new branch before it goes live. Until then you’ll see it as waiting for Swift’s approval.',
  trialBelongsToBusiness: 'The free trial belongs to your business, not to one branch: a branch you close during the free trial still uses it up.',
  ownFee: 'Each branch pays its own weekly fee, with its own checkout.',
} as const;

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Guyana' });

/** "29 October 2026" in Guyana time, or null for a date that does not parse. */
export function branchDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : DATE.format(at);
}

/**
 * The trial line on the add-a-branch screen. With a shared trial running: free until its end IF Swift approves the
 * branch before then; otherwise billed from approval. `fee` is the formatted weekly fee ("G$15,000").
 */
export function branchTrialLine(sharedTrialEndsAt: string | null | undefined, fee: string): string {
  const until = branchDate(sharedTrialEndsAt);
  if (until) return `Free until ${until} if Swift approves it before ${until}. After that, ${fee}/week.`;
  return `Billed from the day Swift approves it: ${fee}/week.`;
}

/** The chain deal line, when Swift agreed one with this business. */
export function branchDealLine(deal: number | null | undefined, fee: (amount: number) => string): string | null {
  if (deal === null || deal === undefined || !(deal > 0)) return null;
  return `Your agreed rate: ${fee(deal)}/week (or the branch’s own fee, if lower).`;
}

type StoreLike = { name?: string | null; status?: string | null; awaitingApproval?: boolean | null; personApprovalRequired?: boolean | null };

/** A store waiting for Swift's approval (a new branch, or a store not yet approved). */
export function awaitingApproval(store: StoreLike | null | undefined): boolean {
  if (!store) return false;
  return store.awaitingApproval === true || store.status === 'PENDING_APPROVAL' || store.personApprovalRequired === true;
}

/** The switcher's label: the store's name, and "waiting for Swift's approval" while it is. */
export function storeLabel(store: StoreLike): string {
  const name = store.name?.trim() || 'Store';
  return awaitingApproval(store) ? `${name} · ${BRANCH_COPY.waiting}` : name;
}

export type BulkOutcome = { done: string[]; failed: Array<{ id: string; message: string }> };

/** The server's sentence for a refused call, or plain words. Never a code. */
export function refusalWords(error: unknown, fallback = 'Couldn’t save. Try again.'): string {
  const body = (error as { response?: { data?: { error?: { message?: unknown } } } } | null)?.response?.data?.error;
  return typeof body?.message === 'string' && body.message.trim() ? body.message : fallback;
}

/** Run one call per branch, one after another (each branch's own route and rules), and say how each went. */
export async function forEachBranch(ids: readonly string[], run: (id: string) => Promise<unknown>): Promise<BulkOutcome> {
  const out: BulkOutcome = { done: [], failed: [] };
  for (const id of [...new Set(ids)]) {
    try {
      await run(id);
      out.done.push(id);
    } catch (error) {
      out.failed.push({ id, message: refusalWords(error) });
    }
  }
  return out;
}

/** "Done for 3 branches." / "Done for 2 branches. Not done for Royal North: <why>." */
export function bulkOutcomeLine(outcome: BulkOutcome, nameOf: (id: string) => string): string {
  const n = outcome.done.length;
  const done = n === 0 ? 'Not done for any branch.' : `Done for ${n} ${n === 1 ? 'branch' : 'branches'}.`;
  const failed = outcome.failed.map((f) => `Not done for ${nameOf(f.id)}: ${f.message}`);
  return [done, ...failed].join(' ');
}

/** A key for one menu copy, sent again on a retry so the server answers the first copy instead of copying twice. */
export function newCopyKey(random: () => number = Math.random): string {
  let key = 'copy';
  for (let i = 0; i < 20; i += 1) key += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)];
  return key;
}

export type MenuCopyResult = {
  categories: number; items: number; options: number; photos: number; photosNotCopied: number;
  waitingForCheck: number; notAllowed: Array<{ name: string }>; replayed?: boolean;
};

/** What a finished copy says. */
export function menuCopyLines(r: MenuCopyResult): string[] {
  const lines = [`Copied ${r.items} ${r.items === 1 ? 'item' : 'items'} in ${r.categories} ${r.categories === 1 ? 'section' : 'sections'}, with ${r.photos} ${r.photos === 1 ? 'photo' : 'photos'}.`];
  if (r.photosNotCopied > 0) lines.push(`${r.photosNotCopied} ${r.photosNotCopied === 1 ? 'photo' : 'photos'} could not be copied: add ${r.photosNotCopied === 1 ? 'it' : 'them'} again here.`);
  if (r.waitingForCheck > 0) lines.push(`${r.waitingForCheck} ${r.waitingForCheck === 1 ? 'item waits' : 'items wait'} for a quick check by Swift before customers see ${r.waitingForCheck === 1 ? 'it' : 'them'}.`);
  if (r.notAllowed.length > 0) lines.push(`Not copied (Swift doesn’t allow ${r.notAllowed.length === 1 ? 'it' : 'them'}): ${r.notAllowed.map((i) => i.name).join(', ')}.`);
  lines.push('Stock counts are not copied: each branch counts its own.');
  return lines;
}

type TermsLike = { weeklyFee?: { amount?: unknown; currencyCode?: unknown; version?: unknown } | null; terms?: unknown } | null | undefined;

const words = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * The weekly-fee tick for a branch, from GET /vendor/stores/branch-terms: the same words and tick as sign-up, given to
 * exactly this branch's amount (a new amount or new words clear it). Words that are not the server's terms refuse.
 */
export function branchFeeTick(t: TermsLike): FeeTick {
  if (!t || !t.weeklyFee) return { kind: 'none' };
  const terms = t.terms as FeeTerms | null;
  const amount = t.weeklyFee.amount;
  const currencyCode = t.weeklyFee.currencyCode;
  const ok = !!terms && words(terms.version) && words(terms.tick) && Array.isArray(terms.items) && terms.items.length > 0
    && terms.items.every((i) => !!i && words(i.heading) && words(i.text))
    && typeof amount === 'number' && Number.isFinite(amount) && amount > 0 && words(currencyCode);
  if (!ok) return { kind: 'invalid' };
  const ack = { version: terms!.version, amount: amount as number, currencyCode: currencyCode as string };
  return { kind: 'tick', terms: terms!, key: `${ack.version}|${ack.currencyCode}|${ack.amount}`, ack };
}
