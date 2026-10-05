/** @jsxImportSource react */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StepUpSheet } from '../components/StepUpSheet';
import { requireAuthSessionSnapshot, requireAuthSessionForPrincipal, useAuthStore } from '../stores/authStore';
import type { AuthSessionSnapshot } from '../lib/authSession';
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

type Pending = { id: number; session: AuthSessionSnapshot; retry: () => void; dismiss: () => void };

export function useStepUp(): { withStepUp: MutationGuard; sheet: React.ReactElement; active: boolean } {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const sequence = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  const set = (p: Pending | null) => {
    pendingRef.current = p;
    if (mounted.current) setPending(p);
  };

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useAuthStore.subscribe(() => {
      const active = pendingRef.current;
      if (!active) return;
      try { requireAuthSessionForPrincipal(active.session); } catch { active.dismiss(); }
    });
    return () => { unsubscribe(); mounted.current = false; pendingRef.current?.dismiss(); };
  }, []);

  const withStepUp = useCallback(<A extends unknown[], R>(fn: (...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      if (busy.current || !mounted.current) throw new StepUpDismissed();
      const session = requireAuthSessionSnapshot();
      busy.current = true;
      try {
        try { return await fn(...args); } catch (e: unknown) {
          if (!isStepUpRequired(e)) throw e;
          requireAuthSessionForPrincipal(session);
          if (!mounted.current) throw new StepUpDismissed();
          return await new Promise<R>((resolve, reject) => {
            const id = ++sequence.current;
            set({ id, session,
              retry: () => {
                if (pendingRef.current?.id !== id) return;
                set(null);
                try {
                  requireAuthSessionForPrincipal(session);
                  fn(...args).then(resolve, reject);
                } catch (error) { reject(error); }
              },
              dismiss: () => { if (pendingRef.current?.id === id) set(null); reject(new StepUpDismissed()); },
            });
          });
        }
      } finally { busy.current = false; }
    };
  }, []);

  const sheet = (
    <StepUpSheet
      key={pending?.id ?? 'closed'}
      visible={!!pending}
      session={pending?.session}
      onVerified={() => pending?.retry()}
      onClose={() => pending?.dismiss()}
    />
  );

  return { withStepUp, sheet, active: !!pending };
}
