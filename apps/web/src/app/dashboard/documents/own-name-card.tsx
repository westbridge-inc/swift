'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { dropStoreOwnName, signStoreOwnName } from '@/lib/store-documents-api';
import { OWN_NAME_DECLARATION_V1, OWN_NAME_HINT, OWN_NAME_TICK, ownNameSigningFor } from '@/lib/store-documents';

/** The server's message for a refused signature, or the phone's retry line. */
const errorWords = (error: unknown, fallback: string) => (error instanceof Error && error.message.trim() ? error.message : fallback);

/**
 * [ROLE-DOCS · owner ruling 21 Oct 2026] The own-name choice on the store's Documents, as the phone's OwnNameCard:
 *  - `sign`: the store trades under its owner's own name and its declaration is missing or was rejected: the words,
 *    the tick and "Sign the declaration"; once signed a person checks it, like any document;
 *  - `offer`: the store is asked for a business registration it does not have yet: offer the own-name route;
 *  - `drop`: the store trades under its owner's own name: "I use a registered business name instead".
 * The server decides everything (the name check, refusals) for the selected store only; this card asks and shows the answer.
 */
export function OwnNameCard({ mode, storeName, onDone }: { mode: 'sign' | 'offer' | 'drop'; storeName: string; onDone: () => void }) {
  const [ticked, setTicked] = useState(false);
  const [open, setOpen] = useState(mode === 'sign');
  const sign = useMutation({ mutationFn: signStoreOwnName, onSuccess: () => onDone() });
  const drop = useMutation({ mutationFn: dropStoreOwnName, onSuccess: () => onDone() });
  const forStore = ownNameSigningFor(storeName);

  if (mode === 'drop') {
    return (
      <div>
        <button type="button" className="sw-chip" disabled={drop.isPending} onClick={() => drop.mutate()}>
          {drop.isPending ? 'Saving…' : 'I use a registered business name instead'}
        </button>
        {drop.isError && <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">{errorWords(drop.error, 'Couldn’t sign the declaration. Try again.')}</p>}
      </div>
    );
  }
  return (
    <div className="sw-card space-y-3 p-5">
      <p className="font-semibold">{mode === 'sign' ? 'Sign: I trade under my own name' : 'No business name? Trade under your own name'}</p>
      <p className="text-sm text-[var(--swift-muted)]">{OWN_NAME_HINT}</p>
      {forStore && <p className="text-sm font-semibold">{forStore}</p>}
      {open ? (
        <>
          <pre className="whitespace-pre-wrap rounded-lg bg-[var(--swift-subtle)] p-3 font-sans text-sm">{OWN_NAME_DECLARATION_V1}</pre>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--swift-red)]" />
            <span>{OWN_NAME_TICK}</span>
          </label>
          <button
            type="button"
            disabled={!ticked || sign.isPending}
            onClick={() => sign.mutate()}
            className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {sign.isPending ? 'Signing…' : 'Sign the declaration'}
          </button>
          {sign.isError && <p role="alert" className="text-sm text-[var(--swift-red)]">{errorWords(sign.error, 'Couldn’t sign the declaration. Try again.')}</p>}
        </>
      ) : (
        <button type="button" className="sw-chip" onClick={() => setOpen(true)}>My store&apos;s name is my own name</button>
      )}
    </div>
  );
}
