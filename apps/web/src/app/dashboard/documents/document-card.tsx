'use client';

import { useId, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ChevronRight, FileUp } from 'lucide-react';
import { submitStoreDocument, uploadStoreDocumentFile, type StoreUploadConsentVia } from '@/lib/store-documents-api';
import {
  DOCUMENT_FILE_TYPES, REPLACE_BODY, REPLACE_TITLE, STILL_UPLOADING, docLabel, documentCardView, uploadErrorWords, type StoreDocumentRow,
} from '@/lib/store-documents';

const BADGE_TONE = {
  success: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
  warning: 'bg-amber-100 text-amber-700',
  brand: 'bg-sky-100 text-sky-700',
} as const;

const CAPTION_TONE = { muted: 'text-[var(--swift-muted)]', error: 'text-[var(--swift-red)]', warning: 'text-amber-700' } as const;

/**
 * [OPEN-EARLY PR-2] One store document, as the phone's DocumentUploadCard: its plain name, where it stands (the
 * phone's words), and one press to send it — the file is uploaded (POST /verification/upload), then filed for the
 * store type with the consent (POST /verification/documents). An approved, current document is locked; one inside its
 * 30-day renewal window opens again; a copy waiting for review can be replaced, asked first in the phone's words.
 * Nothing opens before the consent tick above. A refused upload shows the server's own reason.
 */
export function DocumentCard({ role, docType, doc, isNext, optionalHint, consented, consentVia, onSent }: {
  role: string;
  docType: string;
  doc: StoreDocumentRow | undefined;
  isNext: boolean;
  optionalHint?: string;
  consented: boolean;
  consentVia: StoreUploadConsentVia;
  onSent: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const captionId = useId();
  const [askReplace, setAskReplace] = useState(false);
  const send = useMutation({
    mutationFn: async (file: File) => {
      const { url } = await uploadStoreDocumentFile(file);
      return submitStoreDocument({ role, docType, fileUrl: url, consentVia });
    },
    onSuccess: () => onSent(),
  });
  const view = documentCardView({
    status: doc?.status,
    expiresAt: doc?.expiresAt ?? null,
    submittedAt: doc?.createdAt ?? null,
    reviewNote: doc?.reviewNote ?? null,
    replaced: doc?.replaced === true,
    isNext,
    optional: optionalHint !== undefined,
    consented,
    uploadError: send.isError ? uploadErrorWords(send.error) : null,
  });
  const disabled = view.locked || send.isPending || !consented;
  const choose = () => {
    if (disabled) return;
    if (view.pending) { setAskReplace(true); return; }
    fileRef.current?.click();
  };

  return (
    <div className={`sw-card p-0 ${isNext && !doc ? 'ring-1 ring-[var(--swift-red)]' : ''}`}>
      <button
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
      {askReplace && (
        <div role="alertdialog" aria-labelledby={`${captionId}-replace`} className="space-y-3 border-t border-[var(--swift-border)] px-5 py-4">
          <p id={`${captionId}-replace`} className="font-semibold">{REPLACE_TITLE}</p>
          <p className="text-sm text-[var(--swift-muted)]">{REPLACE_BODY}</p>
          <div className="flex gap-2">
            <button type="button" className="sw-chip" onClick={() => setAskReplace(false)}>Cancel</button>
            <button
              type="button"
              disabled={send.isPending}
              onClick={() => { setAskReplace(false); fileRef.current?.click(); }}
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
        disabled={send.isPending}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file || send.isPending) return;
          send.mutate(file);
        }}
      />
    </div>
  );
}
