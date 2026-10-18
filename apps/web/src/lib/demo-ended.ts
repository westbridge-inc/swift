/**
 * [Row 353 · STA-1 DL-9] The store-review demo answers every request with
 * 410 REVIEW_SESSION_CLOSED once its session is over. Only an account in the
 * review fiction can receive it. The website signs that browser out (the
 * server clears the HttpOnly cookies), and the sign-in page says why — never
 * an error page or a blank screen.
 */
export const DEMO_ENDED_NOTICE = 'This demo has ended, so you were signed out. You can sign in with your own phone number.';
export const DEMO_ENDED_LOGIN = '/login?ended=demo';

const KEY = 'swift_demo_ended';

/** A 410 that names REVIEW_SESSION_CLOSED; any other answer is not a closed demo. */
export function isClosedDemoAnswer(status: number, json: unknown): boolean {
  return status === 410 && (json as { error?: { code?: unknown } } | null)?.error?.code === 'REVIEW_SESSION_CLOSED';
}

/** Remembered for this tab until the sign-in page shows it, for a sign-out that did not move the page. */
export function noteDemoEnded(): void {
  try { window.sessionStorage.setItem(KEY, '1'); } catch { /* storage blocked: the ?ended=demo link still says it */ }
}

/** Whether the sign-in page should say the demo ended: its link says so, or this tab just signed one out. Shown once. */
export function takeDemoEndedNotice(ended: string | null): boolean {
  let noted = false;
  try {
    noted = window.sessionStorage.getItem(KEY) === '1';
    window.sessionStorage.removeItem(KEY);
  } catch { /* storage blocked */ }
  return ended === 'demo' || noted;
}
