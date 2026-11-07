// ---------------------------------------------------------------------------
// [CHAINS PR2 · owner 29 Oct 2026] One owner, many branches: the words and the small rules the branch screens share.
// The server decides everything (the shared trial, the fee, approval); these only say it.
//  - A branch added while the business's free trial runs shares that trial, but only from the day Swift approves it:
//    the date holds only if Swift approves it before then (REVIEW-M #2211 S4-2).
//  - The free trial belongs to the business, not to one branch: closing a branch during it does not give it back
//    (REVIEW-M #2211 N1).
//  - Every new branch waits for a person at Swift before it goes live — but [REVIEW-F #2220 S3-1] a store is called
//    "waiting for Swift's approval" ONLY when the server says nothing is owed by its owner (`goLive.waitingFor`
//    'SWIFT'). Otherwise it is "not live yet: finish setting it up", with the owner's steps and a way to them.
//  - Bulk open/pause and bulk hours are done one branch at a time over each branch's own routes, so every branch's
//    own rules still apply; the result says which branches did not take it, in the server's words.
// ---------------------------------------------------------------------------

import type { FeeTerms, FeeTick } from './partnerPricing';

export const BRANCH_COPY = {
  waiting: 'waiting for Swift’s approval',
  finishSetup: 'not live yet: finish setting it up',
  notLive: 'not live yet',
  checkFirst: 'A person at Swift checks every new branch before it goes live. If a branch still needs something from you first, your list of branches says what, with a button to finish it.',
  swiftChecks: 'Everything Swift needs from you is in. A person at Swift checks this branch before it goes live.',
  finishButton: 'Finish setting it up',
  finishHere: 'Before Swift can check it, finish what this screen still asks for.',
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

/** An owner's step before a store can go live (the server's `goLive.steps`). */
export type GoLiveStep = 'DOCUMENTS' | 'PUBLISHED_PHONE' | 'FOOD_HANDLERS' | 'WEEKLY_FEE';
/** The server's word on a store not live yet: whose turn it is, and the owner's steps still to do. */
export type StoreGoLive = { waitingFor: 'OWNER' | 'SWIFT'; steps: GoLiveStep[] };

/** Each step, as the owner reads it. Every one is done on the store's own screen (switch to it). */
export const GO_LIVE_STEP_WORDS: Readonly<Record<GoLiveStep, string>> = {
  DOCUMENTS: 'Add the documents it still needs',
  PUBLISHED_PHONE: 'Add the number customers can call',
  FOOD_HANDLERS: 'Confirm your food handlers',
  // [RETIER PR-A2] the store's fee follows its catalogue above the first step: its owner reads and ticks it
  WEEKLY_FEE: 'Read and tick its weekly fee',
};

type StoreLike = {
  name?: string | null; status?: string | null; awaitingApproval?: boolean | null; personApprovalRequired?: boolean | null; goLive?: unknown;
};

/** A store not live yet: a new branch, or a store not yet approved (whoever's turn it is). */
export function awaitingApproval(store: StoreLike | null | undefined): boolean {
  if (!store) return false;
  return store.awaitingApproval === true || store.status === 'PENDING_APPROVAL' || store.personApprovalRequired === true;
}

/** The server's `goLive`, read strictly: an unknown shape is no word at all; unknown steps are dropped. */
export function goLiveOf(store: StoreLike | null | undefined): StoreGoLive | null {
  const g = store?.goLive as { waitingFor?: unknown; steps?: unknown } | null | undefined;
  if (!g || (g.waitingFor !== 'OWNER' && g.waitingFor !== 'SWIFT')) return null;
  const steps = (Array.isArray(g.steps) ? g.steps : []).filter((x): x is GoLiveStep => typeof x === 'string' && x in GO_LIVE_STEP_WORDS);
  return { waitingFor: g.waitingFor, steps };
}

/** The owner's steps for a store not live yet, in words (none when it is Swift's turn). Only the steps this app knows:
 *  with none known, no line at all, so the Finish setting it up button is never named twice (REVIEW-F #2220 N3). */
export function ownerStepWords(store: StoreLike | null | undefined): string[] {
  const g = goLiveOf(store);
  if (!g || g.waitingFor !== 'OWNER' || !awaitingApproval(store)) return [];
  return g.steps.map((x) => GO_LIVE_STEP_WORDS[x]);
}

/**
 * The switcher's label: the store's name, then while it is not live: "waiting for Swift's approval" ONLY on Swift's
 * turn; "not live yet: finish setting it up" on the owner's; plain "not live yet" when the server gave no word.
 */
export function storeLabel(store: StoreLike): string {
  const name = store.name?.trim() || 'Store';
  if (!awaitingApproval(store)) return name;
  const g = goLiveOf(store);
  const why = !g ? BRANCH_COPY.notLive : g.waitingFor === 'SWIFT' ? BRANCH_COPY.waiting : BRANCH_COPY.finishSetup;
  return `${name} · ${why}`;
}

/** The waiting store's own screen: what is left before it goes live, and who does it. Null with no word. */
export function goLiveLine(store: StoreLike | null | undefined): string | null {
  const g = goLiveOf(store);
  if (!g || !awaitingApproval(store)) return null;
  if (g.waitingFor === 'SWIFT') return BRANCH_COPY.swiftChecks;
  const steps = ownerStepWords(store);
  return steps.length > 0 ? `Before Swift can check it: ${steps.join('; ')}.` : BRANCH_COPY.finishHere;
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
