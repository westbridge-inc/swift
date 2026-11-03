/**
 * [FLOW-QA F6] Sign-up survives the phone's Back button and a refresh: each step is its own history entry
 * (/signup?step=…), and what was typed that is not a secret (the door, the phone number, the name; never the code)
 * is kept for this tab only (sessionStorage). The server's signup continuation cookie (HttpOnly) still proves the
 * phone at the name step; if it has gone, registration says to ask for a new code, as before.
 */
export const SIGNUP_STEPS = ['role', 'phone', 'code', 'name', 'business', 'vehicle'] as const;
export type SignupStep = (typeof SIGNUP_STEPS)[number];
/** Steps reached once the account exists: Back from one never reopens the steps that made the account. */
export const ACCOUNT_STEPS: readonly SignupStep[] = ['business', 'vehicle'];
export type SignupDraft = { step: SignupStep; role: string; phone: string; first: string; last: string };

const KEY = 'swift_signup_draft';

export function stepOf(search: string): SignupStep | null {
  const step = new URLSearchParams(search).get('step');
  return (SIGNUP_STEPS as readonly string[]).includes(step ?? '') ? (step as SignupStep) : null;
}
export function readDraft(): SignupDraft | null {
  try {
    const d = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as SignupDraft | null;
    return d && (SIGNUP_STEPS as readonly string[]).includes(d.step) ? d : null;
  } catch { return null; }
}
export function saveDraft(draft: SignupDraft): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(draft)); } catch { /* storage unavailable */ }
}
export function clearDraft(): void {
  try { sessionStorage.removeItem(KEY); sessionStorage.removeItem(BUSINESS_KEY); } catch { /* storage unavailable */ }
}

/** The address of a step: the page's own address with ?step= set, every other parameter kept. */
export function stepUrl(step: SignupStep): string {
  const url = new URL(window.location.href);
  url.searchParams.set('step', step);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** [FLOW-QA2 NEW-6] What the business step keeps for this tab (app/signup/business-draft.ts, in the steps' own chunk). */
export const BUSINESS_KEY = 'swift_signup_business';
