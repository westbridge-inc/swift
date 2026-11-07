// ---------------------------------------------------------------------------
// [CHAINS PR2 · owner 29 Oct 2026] One owner, many branches: the words and the small rules the website's branch
// pages share with the phone (apps/mobile/src/lib/branches.ts says the same things).
//
//  - The add-a-branch terms: a branch shares the owner's running free trial only if Swift approves it before that
//    trial ends (REVIEW-M #2211 S4-2), and the trial belongs to the business: a branch closed during it still uses it
//    up (REVIEW-M #2211 N1). With no running trial, the branch is billed from the day Swift approves it.
// ---------------------------------------------------------------------------

import { formatAmount } from './money';

// [CI perf #2220] This module is the add-a-branch terms only. The switcher label is lib/branch-label, the bulk rule
// lib/branch-bulk, the menu-copy words lib/branch-menu-copy-words and the team role words lib/team-roles: a bundler
// keeps every export any page uses, so one shared module put all of them in each branch page's first load.

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
  'A person at Swift checks every new branch before it goes live. If a branch still needs something from you first, the Branches page says what is left and where to do it on this website.';

/** "Your agreed rate: $12,000/week (or the branch's own fee, if lower)", or null with no deal. */
export function dealLine(dealWeeklyRate: number | null, dealCurrencyCode: string | null): string | null {
  if (dealWeeklyRate === null || !dealCurrencyCode) return null;
  return `Your agreed rate: ${weeklyFeeWords(dealWeeklyRate, dealCurrencyCode)} (or the branch’s own fee, if lower).`;
}
