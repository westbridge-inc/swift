/**
 * [ALG-34] Step-up, client side. A money surface (the MMG pay link, staff
 * grants) answers 403 STEP_UP_REQUIRED until this session confirms it holds
 * the phone NOW. The server's answer names the two routes; the client's only
 * job is to recognise it, run the code sheet, and retry ONCE after a verify.
 */

export const STEP_UP_CODE = 'STEP_UP_REQUIRED';

type ApiLikeError = {
  name?: string;
  response?: { status?: number; data?: { error?: { code?: string; message?: string }; message?: string } };
} | null | undefined;

export function isStepUpRequired(e: unknown): boolean {
  const err = e as ApiLikeError;
  return err?.response?.status === 403 && err?.response?.data?.error?.code === STEP_UP_CODE;
}

/** The server's sentence when it gave one; the caller's fallback otherwise. */
export function serverMessage(e: unknown, fallback: string): string {
  const err = e as ApiLikeError;
  return err?.response?.data?.error?.message ?? err?.response?.data?.message ?? fallback;
}

/** The sheet was closed without a verify: the action simply did not happen. Never an error toast. */
export class StepUpDismissed extends Error {
  constructor() {
    super('Step-up dismissed');
    this.name = 'StepUpDismissed';
  }
}

export const isStepUpDismissed = (e: unknown): boolean =>
  e instanceof StepUpDismissed || (e as { name?: string } | null | undefined)?.name === 'StepUpDismissed';

/** A server-owned moment, rendered for a person. Null when the server sent nothing usable — never invented. */
export function fmtWhen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  } catch {
    return d.toISOString();
  }
}
