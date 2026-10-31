'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cancelPendingMmgNumber, getProfile, updateProfile } from '@/lib/vendor-api';
import { setDraftDirty, storeKey } from '@/lib/store-scope';
import { isStepUpDismissed, useStepUp } from '@/lib/step-up';
import { maskMmgNumber } from '@/lib/mmg-mask';
import { mmgHoldSentence } from '../../../../../mobile/src/lib/mmgHold';
import { fmtWhen } from '../../../../../mobile/src/lib/stepUp';

/** The phone's own words (MmgNumberCard.tsx and VendorAccountScreen.tsx; the test reads both). */
export const MMG_NUMBER_WORDS = {
  title: 'Your MMG number',
  about: 'Customers who choose MMG see this number on their order after you accept it, and pay you directly. Tap “Paid by MMG” on the order when the money is in your account.',
  ownerOnly: 'Only the store owner can change where the money goes.',
  cashOnly: 'Cash only',
  takesEffect: 'New number takes effect',
  waiting: 'New number is waiting for its cool-off',
  untilKeep: 'Until then, customers keep paying your current number.',
  untilCash: 'Until then, you take cash only.',
  cancel: 'This wasn’t me — cancel and sign out other devices',
  cancelled: 'Change cancelled. Your current number stays. Other devices were signed out.',
  saveFailed: 'That number could not be saved. Check it and try again.',
} as const;

const DRAFT = 'Your MMG number';

type ProfileStores = {
  vendors?: Array<{ id: string; mmgNumber?: string | null; mmgNumberPending?: string | null; mmgNumberApplyAt?: string | null; mmgNumberHoldHours?: number | null }>;
  myRole?: string;
};

/** The API's own refusal, in its words. */
function serverWords(e: unknown, fallback: string): string {
  const message = (e as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

/**
 * [WEB-SETTINGS · owner 31 Oct 2026] The store's own MMG number, where a customer who chose MMG pays the order in MMG's
 * own app (Swift never holds, moves or checks that money): the phone's Account > "Your MMG number" on the website.
 * The same PUT /vendor/profile { mmgNumber }, owner only, behind "Confirm it's you" (lib/step-up); the server stages a
 * new number behind its cool-off with the old one live and texts the owner; "This wasn't me" drops the staged change
 * and signs out every other device (DELETE /vendor/profile/mmg-number/pending). A manager sees it, never changes it.
 * The website shows the number MASKED only (lib/mmg-mask): the box starts empty, so the number is never put back in a
 * field, and it is never put in an address, a log line or the browser's storage.
 */
export function MmgNumberCard({ storeId }: { storeId: string | null }) {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const data = profile.data as ProfileStores | undefined;
  const store = data?.vendors?.find((v) => v.id === storeId) ?? (data?.vendors?.length === 1 ? data.vendors[0] : undefined);
  const owner = data?.myRole === 'OWNER';
  const stepUp = useStepUp();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const typed = input.trim();
  useEffect(() => {
    setDraftDirty(DRAFT, typed.length > 0);
    return () => setDraftDirty(DRAFT, false);
  }, [typed]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'profile') });
  const save = useMutation({
    mutationFn: (mmgNumber: string | null) => stepUp.withStepUp(() => updateProfile({ mmgNumber }))(),
    onMutate: () => { setError(null); setNotice(null); },
    onSuccess: () => { setInput(''); void refresh(); },
    onError: (e) => { if (!isStepUpDismissed(e)) setError(serverWords(e, MMG_NUMBER_WORDS.saveFailed)); },
  });
  const cancel = useMutation({
    mutationFn: cancelPendingMmgNumber,
    onMutate: () => { setError(null); setNotice(null); },
    onSuccess: () => { setNotice(MMG_NUMBER_WORDS.cancelled); void refresh(); },
    onError: (e) => setError(`Could not cancel. ${serverWords(e, 'Try again in a moment.')}`),
  });

  if (!store || (data?.myRole !== 'OWNER' && data?.myRole !== 'MANAGER')) return null;
  const live = maskMmgNumber(store.mmgNumber);
  const pending = maskMmgNumber(store.mmgNumberPending);
  const when = fmtWhen(store.mmgNumberApplyAt);
  const busy = save.isPending || cancel.isPending;

  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">{MMG_NUMBER_WORDS.title}</h2>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        {MMG_NUMBER_WORDS.about}{owner ? ' Remove it to take cash only.' : ''}
      </p>
      <p className="mt-3 text-sm">
        <span className="text-[var(--swift-muted)]">Customers pay: </span>
        <b>{live ?? MMG_NUMBER_WORDS.cashOnly}</b>
      </p>

      {pending && (
        <div className="mt-3 space-y-1 rounded-lg bg-[var(--swift-subtle)] p-3 text-sm">
          <p className="font-semibold">{when ? `${MMG_NUMBER_WORDS.takesEffect} ${when}` : MMG_NUMBER_WORDS.waiting}</p>
          <p className="text-[var(--swift-muted)]">{pending}</p>
          <p className="text-[var(--swift-muted)]">{live ? MMG_NUMBER_WORDS.untilKeep : MMG_NUMBER_WORDS.untilCash}</p>
          {owner && (
            <button
              type="button"
              onClick={() => cancel.mutate()}
              disabled={busy}
              className="mt-2 min-h-11 rounded-lg border border-[var(--swift-red)] px-3 text-sm font-semibold text-[var(--swift-red)] disabled:opacity-50"
            >
              {cancel.isPending ? 'Cancelling…' : MMG_NUMBER_WORDS.cancel}
            </button>
          )}
        </div>
      )}

      {owner ? (
        <>
          <label htmlFor="mmg-number" className="mt-4 block text-sm font-semibold">New MMG number</label>
          <input
            id="mmg-number"
            inputMode="tel"
            autoComplete="off"
            value={input}
            onChange={(e) => { setInput(e.target.value); setError(null); setNotice(null); }}
            placeholder="+592 6xx xxxx"
            className="mt-1 w-full rounded-lg border border-[var(--swift-border)] px-3 py-2 text-sm focus:border-[var(--swift-red)] focus:outline-none"
          />
          {typed && <p className="mt-2 text-xs text-[var(--swift-muted)]">{mmgHoldSentence('number', store.mmgNumberHoldHours, !!store.mmgNumber)}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => save.mutate(typed)}
              disabled={!typed || busy}
              className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {save.isPending && save.variables !== null ? 'Saving…' : 'Save number'}
            </button>
            {store.mmgNumber && (
              <button
                type="button"
                onClick={() => save.mutate(null)}
                disabled={busy}
                className="rounded-lg border border-[var(--swift-border)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                {save.isPending && save.variables === null ? 'Removing…' : 'Remove number'}
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="mt-2 text-xs text-[var(--swift-muted)]">{MMG_NUMBER_WORDS.ownerOnly}</p>
      )}
      {notice && <p role="status" className="mt-2 text-sm font-medium text-green-600">{notice}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">{error}</p>}
      {stepUp.dialog}
    </div>
  );
}
