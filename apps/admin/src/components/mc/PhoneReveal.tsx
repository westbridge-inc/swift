'use client';

import { useState } from 'react';
import type { ActionDialogRequest, ReasonAnswer } from './ReasonDialog';
import { maskedPhone } from '@/lib/review-center';

// ---------------------------------------------------------------------------
// [FOLLOWUPS · COORD ruling 28 Oct 2026, owner delegated; follows O-1] A phone
// number on a person page, the order desk's way (orders/[id] Party): masked by
// default (the server sends it masked too); "Show number" reads the full one
// through the audited door (a reason, recorded before the number is sent),
// and only for this page view. No click-to-call: calls are not a console
// feature (owner ruling, 6 Oct).
// ---------------------------------------------------------------------------

/** The number as the page shows it: masked, or the revealed one with the note that its read is recorded. */
export function PhoneReveal({ phone, revealed, onReveal }: { phone?: string | null; revealed?: string | undefined; onReveal?: (() => void) | undefined }) {
  if (!phone) return null;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span className="mc-numbers">{revealed ?? maskedPhone(phone)}</span>
      {revealed ? (
        <span className="mc-muted text-[11px]">Read recorded in the audit log</span>
      ) : onReveal ? (
        <button type="button" onClick={onReveal} className="mc-link-button text-xs">
          Show number
        </button>
      ) : null}
    </span>
  );
}

type Run = (_request: ActionDialogRequest<{ data: { phone: string } }> & { submit: (_answer: ReasonAnswer) => Promise<{ data: { phone: string } }> }) => Promise<unknown>;

/**
 * The page view's revealed numbers, and the ask for one: the order desk's panel words (O-1). `run` is the page's own
 * runner (useActionRunner().run, or the page's dialog.run that shows its answer), so a refusal reads like every other.
 */
export function usePhoneReveal(run: Run) {
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  /** `title` names whose number ("Show Alice's full number?"); `shown` is the answer ("Alice's number is shown."). */
  const revealFor = (key: string, title: string, shown: string, read: (_reason: string) => Promise<{ data: { phone: string } }>) => () => void run({
    title,
    body: <p>Your reason and this read are recorded in the audit log before the number is shown.</p>,
    confirmLabel: 'Show number',
    submit: ({ reason }) => read(reason),
    success: (result) => {
      setRevealed((now) => ({ ...now, [key]: result.data.phone }));
      return `${shown} The read is recorded.`;
    },
  });
  return { revealed, revealFor };
}
