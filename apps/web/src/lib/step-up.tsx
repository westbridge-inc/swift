'use client';

import { Suspense, useCallback, useRef, useState } from 'react';
import { ApiRequestError } from './auth';
import { lazyRetry } from './chunk-retry';

// ---------------------------------------------------------------------------
// [ALG-34 · CHAINS PR2] "Confirm it's you" on the website, as the phone does it (apps/mobile/src/lib/stepUp.ts and
// components/StepUpSheet.tsx). A surface that hands over money or a store (adding a branch, adding a team member)
// answers 403 STEP_UP_REQUIRED until THIS browser session confirms it holds the account's phone now. The page wraps
// its call in `withStepUp`: on that answer the code dialog opens (its code loads only then), and after a verify the
// call runs once more. Closing the dialog is not an error: the action simply did not happen (isStepUpDismissed).
// ---------------------------------------------------------------------------

export const STEP_UP_CODE = 'STEP_UP_REQUIRED';

export function isStepUpRequired(e: unknown): boolean {
  return e instanceof ApiRequestError && e.status === 403 && e.code === STEP_UP_CODE;
}

export class StepUpDismissed extends Error {
  constructor() {
    super('Step-up dismissed');
    this.name = 'StepUpDismissed';
  }
}

export const isStepUpDismissed = (e: unknown): boolean =>
  e instanceof StepUpDismissed || (e as { name?: string } | null | undefined)?.name === 'StepUpDismissed';

const StepUpDialog = lazyRetry(() => import('@/components/step-up-dialog'));

export function useStepUp() {
  const [open, setOpen] = useState(false);
  const waiter = useRef<{ resolve: () => void; reject: (_e: unknown) => void } | null>(null);
  const confirm = useCallback(() => new Promise<void>((resolve, reject) => {
    waiter.current = { resolve, reject };
    setOpen(true);
  }), []);
  const withStepUp = useCallback(<T,>(call: () => Promise<T>) => async (): Promise<T> => {
    try {
      return await call();
    } catch (e) {
      if (!isStepUpRequired(e)) throw e;
      await confirm();
      return call();
    }
  }, [confirm]);
  const finish = (verified: boolean) => {
    const w = waiter.current;
    waiter.current = null;
    setOpen(false);
    if (verified) w?.resolve();
    else w?.reject(new StepUpDismissed());
  };
  const dialog = open ? (
    <Suspense fallback={<p role="status" className="sr-only">Opening the confirmation…</p>}>
      <StepUpDialog onVerified={() => finish(true)} onClose={() => finish(false)} />
    </Suspense>
  ) : null;
  return { withStepUp, dialog };
}
