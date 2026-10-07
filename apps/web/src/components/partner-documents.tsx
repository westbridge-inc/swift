'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FileUp, ShieldCheck } from 'lucide-react';
import { DataUnavailable } from '@/components/data-unavailable';
import { LEGAL_URL } from '@/lib/api';
import { useWebOrderingOpen } from '@/lib/use-web-ordering';
import { site } from '@/site.config';
import {
  STATE_LABEL, currentDocument, documentLabel, documentState, getDocumentStatus, helpHref, submitDocument, uploadDocumentFile, uploadLabel,
  type ChecklistRole, type DocumentState,
} from '@/lib/partner-documents';

/**
 * [DOCS-1 · owner case] One partner's verification documents — a store owner's
 * or a mover's. Each required document shows where it stands. A document that
 * was turned down shows the reviewer's reason and an upload for that document
 * alone, so fixing one document never means starting the application again.
 * The upload is offered exactly when the server will accept one (see
 * lib/partner-documents uploadLabel).
 */

const TONE: Record<DocumentState, string> = {
  MISSING: 'bg-[var(--swift-sunken)] text-[var(--swift-muted)]',
  IN_REVIEW: 'bg-[var(--swift-sunken)] text-[var(--swift-info)]',
  APPROVED: 'bg-[var(--swift-sunken)] text-[var(--swift-success)]',
  EXPIRING: 'bg-[var(--swift-sunken)] text-[var(--swift-warning)]',
  EXPIRED: 'bg-[var(--swift-red-50)] text-[var(--swift-error)]',
  REJECTED: 'bg-[var(--swift-red-50)] text-[var(--swift-error)]',
};

export function documentsQueryKey(role: ChecklistRole, vehicleType?: string) {
  return ['partner-documents', role, vehicleType ?? null] as const;
}

export function PartnerDocuments({
  role, vehicleType, ready = true, helpTopic,
}: {
  role: ChecklistRole;
  vehicleType?: string;
  /** False while what decides the checklist (a mover's vehicle) is still loading. */
  ready?: boolean;
  helpTopic: 'VENDOR' | 'MOVER';
}) {
  const queryClient = useQueryClient();
  const accountPagesOpen = useWebOrderingOpen();
  const status = useQuery({
    queryKey: documentsQueryKey(role, vehicleType),
    queryFn: () => getDocumentStatus(role, vehicleType),
    enabled: ready,
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: async (input: { docType: string; file: File }) => {
      const { url } = await uploadDocumentFile(input.file);
      return submitDocument(role, input.docType, url);
    },
    onSuccess: (_result, input) => {
      setSent(input.docType);
      setUploadFor(null);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['partner-documents', role] });
    },
    onError: (failure) => setError((failure as Error).message),
  });

  const data = status.data;
  return (
    <div className="space-y-3">
      {data ? (
        <div role="status" className={`flex items-center gap-3 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-4 ${data.roleVerified ? 'text-[var(--swift-success)]' : 'text-[var(--swift-ink)]'}`}>
          {data.roleVerified ? <ShieldCheck className="h-5 w-5 flex-none" aria-hidden /> : <AlertTriangle className="h-5 w-5 flex-none text-[var(--swift-warning)]" aria-hidden />}
          <p className="text-sm font-semibold">
            {data.roleVerified
              ? 'Every document is approved.'
              : `${data.missing.length} document${data.missing.length === 1 ? '' : 's'} still to be approved.`}
          </p>
        </div>
      ) : null}

      {status.isPending && ready ? <p role="status" className="text-sm text-[var(--swift-muted)]">Loading your documents…</p> : null}
      {status.isError ? (
        <DataUnavailable what="your document checklist" error={status.error} onRetry={() => void status.refetch()} />
      ) : null}

      <ul className="space-y-3">
        {(data?.checklist ?? []).map((docType) => {
          const doc = currentDocument(data!.documents, docType);
          const state = documentState(doc);
          const action = uploadLabel(state);
          const name = documentLabel(docType);
          const open = uploadFor === docType;
          return (
            <li key={docType} aria-label={name} className="rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-5">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-semibold">{name}</h2>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${TONE[state]}`}>{STATE_LABEL[state]}</span>
                {doc?.expiresAt && state !== 'REJECTED' ? (
                  <span className="text-xs text-[var(--swift-muted)]">{state === 'EXPIRED' ? 'expired' : 'expires'} {new Date(doc.expiresAt).toLocaleDateString('en-GY', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                ) : null}
                {action ? (
                  <button
                    type="button"
                    aria-label={`${action}: ${name}`}
                    aria-expanded={open}
                    onClick={() => { setUploadFor(open ? null : docType); setConsent(false); setError(null); setSent(null); }}
                    className="ml-auto rounded-lg border border-[var(--swift-border-strong)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--swift-subtle)]"
                  >
                    {action}
                  </button>
                ) : null}
              </div>

              {state === 'REJECTED' ? (
                <div className="mt-3 space-y-1 text-sm">
                  <p className="text-[var(--swift-error)]">
                    {doc?.reviewNote ? <>Why it was turned down: <span className="font-semibold">{doc.reviewNote}</span></> : 'The reviewer gave no reason.'}
                  </p>
                  <p className="text-[var(--swift-muted)]">
                    Upload a new copy of this document only — nothing else needs sending again.{' '}
                    <a href={helpHref(helpTopic, docType, accountPagesOpen, site.supportEmail)} className="font-semibold text-[var(--swift-red)] underline">Think this is wrong? Ask Swift</a>
                  </p>
                </div>
              ) : null}
              {state === 'IN_REVIEW' ? <p className="mt-2 text-sm text-[var(--swift-muted)]">We’re checking it — usually within 24 hours.</p> : null}
              {sent === docType ? <p role="status" className="mt-2 text-sm font-medium text-[var(--swift-success)]">Sent. It is in review now.</p> : null}

              {open ? (
                <div className="mt-3 space-y-3 border-t border-[var(--swift-border)] pt-3">
                  <label className="flex items-start gap-2 text-xs text-[var(--swift-muted)]">
                    <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--swift-red)]" />
                    <span>
                      I consent to Swift processing this document for verification, per the{' '}
                      <a href={LEGAL_URL('privacy')} target="_blank" rel="noreferrer" className="font-semibold text-[var(--swift-red)]">privacy notice</a>.
                      It is stored encrypted and never shared.
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={!consent || submit.isPending}
                    className="flex items-center gap-2 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-[var(--swift-white)] disabled:opacity-50"
                  >
                    <FileUp className="h-4 w-4" aria-hidden /> {submit.isPending ? 'Uploading…' : 'Choose file (JPG, PNG or PDF)'}
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    aria-label={`File for ${name}`}
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file && uploadFor) submit.mutate({ docType: uploadFor, file });
                      event.target.value = '';
                    }}
                  />
                  {error ? <p role="alert" className="text-sm text-[var(--swift-error)]">{error}</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
