'use client';

import { useState } from 'react';
import type { Outcome } from '@/lib/outcome';
import { ActionResult } from './ActionResult';
import { useActionDialog, type ActionDialogRequest, type ReasonAnswer } from './ReasonDialog';

/**
 * [MISSION CONTROL · PR-3b] One line for a page that runs actions through the
 * in-page reason panel and keeps the server's answer on screen.
 *
 *   const actions = useActionRunner(refresh);
 *   … onClick={() => void actions.run({ title, confirmLabel, submit, success })}
 *   … {actions.banner}
 *
 * `run` opens the panel (reason, optional amount/reference/text fields), runs
 * the action, keeps a refusal inside the panel, and puts the final answer —
 * success, "sent for a second admin", or the refusal the operator closed — in
 * the banner. `onDone` runs only when the action went through (done, or sent
 * for a second admin's approval) — to re-read what changed or close a form. A
 * refusal changed nothing, so a half-filled form stays as the operator left it.
 */
export function useActionRunner(onDone?: (_outcome: Outcome) => void) {
  const dialog = useActionDialog();
  const [result, setResult] = useState<Outcome | null>(null);
  const run = async <T,>(request: ActionDialogRequest<T> & { submit: (_answer: ReasonAnswer) => Promise<T> }) => {
    const outcome = await dialog.run(request);
    if (outcome) {
      setResult(outcome);
      if (outcome.tone === 'success' || outcome.tone === 'queued') onDone?.(outcome);
    }
    return outcome;
  };
  const banner = <ActionResult outcome={result} onDismiss={() => setResult(null)} className="mb-4" />;
  /** Shows an answer reached without the panel (an operational action that needs no reason). */
  const show = (outcome: Outcome | null) => setResult(outcome);
  return { run, result, show, clear: () => setResult(null), banner };
}
