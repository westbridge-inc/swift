/** @jsxImportSource react */
import React, { useCallback, useRef, useState } from 'react';
import { StepUpSheet } from '../components/StepUpSheet';
import { isStepUpRequired, StepUpDismissed } from '../lib/stepUp';

/**
 * [ALG-34] Wrap a mutation so a 403 STEP_UP_REQUIRED opens the code sheet
 * and, once the session is verified, runs the SAME call again exactly once
 * with the same arguments. Any other error passes through untouched; a
 * dismissed sheet rejects with StepUpDismissed so the caller shows nothing.
 *
 *   const stepUp = useStepUp();
 *   useMutation({ mutationFn: stepUp.withStepUp((url) => vendorApi.updateProfile({ mmgPayUrl: url })) });
 *   … {stepUp.sheet}
 */
export type MutationGuard = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => (...args: A) => Promise<R>;

type Pending = { retry: () => void; dismiss: () => void };

export function useStepUp(): { withStepUp: MutationGuard; sheet: React.ReactElement; active: boolean } {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const set = (p: Pending | null) => {
    pendingRef.current = p;
    setPending(p);
  };

  const withStepUp = useCallback(<A extends unknown[], R>(fn: (...args: A) => Promise<R>) => {
    return (...args: A): Promise<R> =>
      fn(...args).catch((e: unknown) => {
        if (!isStepUpRequired(e)) throw e;
        return new Promise<R>((resolve, reject) => {
          set({
            // ONE retry, only after the sheet verified this session.
            retry: () => {
              set(null);
              fn(...args).then(resolve, reject);
            },
            dismiss: () => {
              set(null);
              reject(new StepUpDismissed());
            },
          });
        });
      });
  }, []);

  const sheet = (
    <StepUpSheet
      visible={!!pending}
      onVerified={() => pendingRef.current?.retry()}
      onClose={() => pendingRef.current?.dismiss()}
    />
  );

  return { withStepUp, sheet, active: !!pending };
}
