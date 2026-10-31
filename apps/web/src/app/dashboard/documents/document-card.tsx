'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ChevronRight, FileUp } from 'lucide-react';
import {
  submitPoliceClearance, submitStoreDocument, uploadStoreDocumentFile, withdrawPoliceClearance, type StoreUploadConsentVia,
} from '@/lib/store-documents-api';
import {
  DOCUMENT_FILE_TYPES, POLICE_WITHDRAW_FAILED, POLICE_WITHDRAW_LINK, POLICE_WITHDRAW_TITLE, REPLACE_BODY, REPLACE_TITLE, STILL_UPLOADING,
  docLabel, documentCardView, policeWithdrawOutcome, uploadErrorWords, type PoliceClearanceWords, type StoreDocumentRow,
} from '@/lib/store-documents';

const BADGE_TONE = {
  success: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
  warning: 'bg-amber-100 text-amber-700',
  brand: 'bg-sky-100 text-sky-700',
} as const;

const CAPTION_TONE = { muted: 'text-[var(--swift-muted)]', error: 'text-[var(--swift-red)]', warning: 'text-amber-700' } as const;

/** [DOC-CONSENT S4 · REVIEW-F] A consent the API refused (withdrawn meanwhile, or words that changed): the list is read again. */
const CONSENT_REFUSALS: ReadonlySet<string> = new Set(['CONSENT_NOT_ON_RECORD', 'CONSENT_WORDS_CHANGED']);
const codeOf = (error: unknown) => (error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined);

/**
 * [OPEN-EARLY PR-2] One document, as the phone's DocumentUploadCard: its plain name, where it stands (the phone's
 * words), and one press to send it — the file is uploaded (POST /verification/upload), then filed for the checklist
 * (POST /verification/documents). An approved, current document is locked; one inside its 30-day renewal window opens
 * again; a copy waiting for review can be replaced, asked first in the phone's words. Nothing opens before the consent
 * tick above. A refused upload shows the server's own reason, and is announced.
 *
 * [POLICE-CLEARANCE CONSENT] With `policeConsent` (a police clearance, in the API's words) the card has its OWN box
 * below it, as the phone's: the list's tick above never opens it; the box is unticked for everyone, empties after each
 * upload and when the words change; the filing sends the clearance's tick and the words' version; and a clearance on
 * file can be withdrawn at any time, asked first in the API's words, then told what happened in the phone's.
 */
export function DocumentCard({ role, docType, doc, isNext, optionalHint, hint, consented, consentVia, policeConsent = null, onSent }: {
  role: string;
  docType: string;
  doc: StoreDocumentRow | undefined;
  isNext: boolean;
  optionalHint?: string;
  /** What this document is, or what waits for it, in plain words (never a gate). */
  hint?: string;
  consented: boolean;
  consentVia: StoreUploadConsentVia;
  policeConsent?: PoliceClearanceWords | null;
  onSent: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLButtonElement>(null);
  const replaceCancelRef = useRef<HTMLButtonElement>(null);
  const withdrawLinkRef = useRef<HTMLButtonElement>(null);
  const withdrawCancelRef = useRef<HTMLButtonElement>(null);
  const captionId = useId();
  const [askReplace, setAskReplace] = useState(false);
  const [askWithdraw, setAskWithdraw] = useState(false);
  const [withdrawn, setWithdrawn] = useState<{ title: string; message: string } | null>(null);
  // [POLICE-CLEARANCE CONSENT] The card's own box: never ticked for anyone, emptied after each upload.
  const [policeTicked, setPoliceTicked] = useState(false);
  const ownTick = policeConsent !== null;
  // A tick belongs to the words it was given to: new words (the API changed them) start empty.
  const wordsVersion = policeConsent?.version ?? null;
  useEffect(() => { setPoliceTicked(false); }, [wordsVersion]);
  const canUpload = ownTick ? policeTicked : consented;

  const send = useMutation({
    mutationFn: async (file: File) => {
      // The consent as it stands when the file is chosen: the clearance's own words, or the list's tick.
      const words = policeConsent;
      const { url } = await uploadStoreDocumentFile(file);
      if (words) {
        if (role !== 'SERVICE' && role !== 'MOVER') throw new Error(`No police clearance on the ${role} checklist.`);
        return submitPoliceClearance({ role, fileUrl: url, consent: { tick: words.tick, version: words.version } });
      }
      return submitStoreDocument({ role, docType, fileUrl: url, consentVia });
    },
    onSuccess: () => { setPoliceTicked(false); onSent(); },
    onError: (error) => { if (CONSENT_REFUSALS.has(String(codeOf(error)))) onSent(); },
  });
  const withdraw = useMutation({
    mutationFn: () => withdrawPoliceClearance(role === 'MOVER' ? 'MOVER' : 'SERVICE'),
    onSuccess: (answer) => { setWithdrawn(policeWithdrawOutcome(answer)); onSent(); },
  });
  const uploadError = send.isError ? uploadErrorWords(send.error) : null;
  // The server's reason for a refused withdrawal, else the phone's line.
  const withdrawError = withdraw.isError ? ((withdraw.error instanceof Error && withdraw.error.message.trim()) || POLICE_WITHDRAW_FAILED) : null;
  const view = documentCardView({
    status: doc?.status,
    expiresAt: doc?.expiresAt ?? null,
    submittedAt: doc?.createdAt ?? null,
    reviewNote: doc?.reviewNote ?? null,
    replaced: doc?.replaced === true,
    isNext,
    optional: optionalHint !== undefined,
    consented: canUpload,
    ownTick,
    uploadError,
  });
  const disabled = view.locked || send.isPending || !canUpload;

  // [#2275 S4-2] The replace ask takes the focus when it opens (its safe answer, Cancel); closing it gives the focus
  // back to the card, so a keyboard or screen-reader user is never dropped at the top of the page.
  useEffect(() => { if (askReplace) replaceCancelRef.current?.focus(); }, [askReplace]);
  useEffect(() => { if (askWithdraw) withdrawCancelRef.current?.focus(); }, [askWithdraw]);
  const closeReplace = () => { setAskReplace(false); cardRef.current?.focus(); };
  const closeWithdraw = () => { setAskWithdraw(false); withdrawLinkRef.current?.focus(); };
  const escapeCloses = (close: () => void) => (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  const choose = () => {
    if (disabled) return;
    if (view.pending) { setAskReplace(true); return; }
    fileRef.current?.click();
  };

  return (
    <div className={`sw-card p-0 ${isNext && !doc ? 'ring-1 ring-[var(--swift-red)]' : ''}`}>
      <button
        ref={cardRef}
        type="button"
        onClick={choose}
        disabled={disabled}
        aria-describedby={captionId}
        className="flex w-full items-center gap-4 p-5 text-left disabled:cursor-default"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--swift-subtle)]">
          <FileUp className="h-5 w-5 text-[var(--swift-red)]" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span id={captionId} className={`block text-xs ${CAPTION_TONE[view.captionTone]}`}>{send.isPending ? STILL_UPLOADING : view.caption}</span>
          <span className="block font-semibold">{docLabel(docType)}</span>
          {hint && <span className="mt-0.5 block text-xs text-[var(--swift-muted)]">{hint}</span>}
          {optionalHint && <span className="mt-0.5 block text-xs text-[var(--swift-muted)]">{optionalHint}</span>}
        </span>
        {send.isPending ? (
          <span role="status" className="text-xs font-semibold text-[var(--swift-muted)]">Uploading…</span>
        ) : view.badge ? (
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${BADGE_TONE[view.badge.tone]}`}>{view.badge.label}</span>
        ) : (
          <ChevronRight className="h-5 w-5 text-[var(--swift-muted)]" aria-hidden="true" />
        )}
      </button>
      {/* [#2275 S4-2] A refused upload is announced, not only written into the card's description. */}
      {uploadError && <p role="alert" className="sr-only">{`${docLabel(docType)}: ${uploadError}`}</p>}
      {/* [POLICE-CLEARANCE CONSENT] The clearance's own box, in the API's words, for each upload. */}
      {policeConsent && !view.locked && (
        <label className="flex items-start gap-3 border-t border-[var(--swift-border)] px-5 py-4 text-xs text-[var(--swift-muted)]">
          <input
            type="checkbox"
            checked={policeTicked}
            onChange={() => setPoliceTicked((t) => !t)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--swift-red)]"
            data-testid="police-clearance-consent-tick"
          />
          <span>{policeConsent.text}</span>
        </label>
      )}
      {/* [POLICE-CLEARANCE CONSENT] Withdraw at any time: the API's own words first. */}
      {policeConsent && doc && (
        <div className="flex justify-end px-5 pb-3">
          <button ref={withdrawLinkRef} type="button" onClick={() => setAskWithdraw(true)} className="text-xs font-semibold text-[var(--swift-muted)] underline">
            {POLICE_WITHDRAW_LINK}
          </button>
        </div>
      )}
      {askWithdraw && policeConsent && (
        <div role="alertdialog" aria-labelledby={`${captionId}-withdraw`} aria-describedby={`${captionId}-withdraw-body`} onKeyDown={escapeCloses(closeWithdraw)} className="space-y-3 border-t border-[var(--swift-border)] px-5 py-4">
          <p id={`${captionId}-withdraw`} className="font-semibold">{POLICE_WITHDRAW_TITLE}</p>
          <p id={`${captionId}-withdraw-body`} className="text-sm text-[var(--swift-muted)]">{policeConsent.withdrawConfirm}</p>
          <div className="flex gap-2">
            <button ref={withdrawCancelRef} type="button" className="sw-chip" onClick={closeWithdraw}>Cancel</button>
            <button
              type="button"
              disabled={withdraw.isPending}
              onClick={() => { setAskWithdraw(false); setWithdrawn(null); withdraw.mutate(); }}
              className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Withdraw
            </button>
          </div>
        </div>
      )}
      {withdrawError && <p role="alert" className="px-5 pb-3 text-xs text-[var(--swift-red)]">{withdrawError}</p>}
      {withdrawn && (
        <div role="status" className="border-t border-[var(--swift-border)] px-5 py-3 text-sm">
          <p className="font-semibold">{withdrawn.title}</p>
          <p className="text-[var(--swift-muted)]">{withdrawn.message}</p>
        </div>
      )}
      {askReplace && (
        <div role="alertdialog" aria-labelledby={`${captionId}-replace`} aria-describedby={`${captionId}-replace-body`} onKeyDown={escapeCloses(closeReplace)} className="space-y-3 border-t border-[var(--swift-border)] px-5 py-4">
          <p id={`${captionId}-replace`} className="font-semibold">{REPLACE_TITLE}</p>
          <p id={`${captionId}-replace-body`} className="text-sm text-[var(--swift-muted)]">{REPLACE_BODY}</p>
          <div className="flex gap-2">
            <button ref={replaceCancelRef} type="button" className="sw-chip" onClick={closeReplace}>Cancel</button>
            <button
              type="button"
              disabled={send.isPending}
              onClick={() => { closeReplace(); fileRef.current?.click(); }}
              className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Replace
            </button>
          </div>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept={DOCUMENT_FILE_TYPES}
        className="hidden"
        aria-label={`Choose a file for ${docLabel(docType)}`}
        disabled={send.isPending || !canUpload}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file || send.isPending || !canUpload) return;
          send.mutate(file);
        }}
      />
    </div>
  );
}
