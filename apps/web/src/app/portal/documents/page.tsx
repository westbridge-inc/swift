'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, ShieldCheck, AlertTriangle } from 'lucide-react';
import {
  getRiderProfile, getVerificationStatus, submitVerificationDocument, uploadVerificationFile,
} from '@/lib/mover-api';
import { DataUnavailable } from '@/components/data-unavailable';
import { LEGAL_URL } from '@/lib/legal-url';
import { documentLabel, isTaxiChecklist, taxiDocumentHint, TAXI_TWO_LICENCES } from '@/lib/taxi-documents';
import { documentExpiryDay } from '@/lib/documentExpiry';
import {
  OPTIONAL_HEADING, OPTIONAL_INTRO, POLICE_CLEARANCE_DOC, POLICE_CLEARANCE_NO_WORDS, docLabel, latestDocument, optionalDocHint, optionalDocTypes,
  policeClearanceWordsFrom,
} from '@/lib/store-documents';
import { DocumentCard } from '@/app/dashboard/documents/document-card';

// [Owner ruling 11 Oct 2026] plain names and, on a taxi checklist, what each document is.
const pretty = documentLabel;

const expiringSoonAt = (expiresAt: string | null) => !!expiresAt && new Date(expiresAt).getTime() - Date.now() < 30 * 24 * 3600 * 1000;

function statusTone(s: string, expiresAt: string | null, replaced = false) {
  const expiringSoon = expiringSoonAt(expiresAt);
  if (s === 'APPROVED' && expiringSoon) return { label: 'Expiring soon', cls: 'bg-amber-100 text-amber-700' };
  if (s === 'APPROVED') return { label: 'Approved', cls: 'bg-green-100 text-green-700' };
  // [REPLACE-PENDING] a copy that replaced an earlier waiting one says so
  if (s === 'PENDING') return { label: replaced ? 'Replaced — waiting for review' : 'In review', cls: 'bg-sky-100 text-sky-700' };
  if (s === 'EXPIRED') return { label: 'Expired', cls: 'bg-red-100 text-red-700' };
  return { label: 'Rejected', cls: 'bg-red-100 text-red-700' };
}

export default function DocumentsPage() {
  const queryClient = useQueryClient();
  const rider = useQuery({ queryKey: ['p-rider'], queryFn: getRiderProfile, retry: 0 });
  const vehicleType = (rider.data?.['vehicleType'] as string | undefined) ?? undefined;
  const status = useQuery({
    queryKey: ['p-docs', vehicleType],
    queryFn: () => getVerificationStatus(vehicleType),
    enabled: !rider.isLoading,
  });

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: async (v: { docType: string; file: File }) => {
      const { url } = await uploadVerificationFile(v.file);
      return submitVerificationDocument(v.docType, url);
    },
    onSuccess: (_r, v) => {
      setDone(v.docType);
      setUploadFor(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['p-docs'] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const d = status.data;
  // [POLICE-CLEARANCE CONSENT · owner 31 Oct 2026] A TAXI driver may add a police clearance (optional; an approved,
  // current one records the account as police-cleared; it never gates), on the phone's card with its OWN consent in the
  // API's words — never under the privacy-notice tick below. A delivery rider is never offered one, whatever a list says.
  const offersPolice = !!d && isTaxiChecklist(d.checklist ?? []) && optionalDocTypes(d).includes(POLICE_CLEARANCE_DOC);
  const policeWords = offersPolice ? policeClearanceWordsFrom(d) : null;
  // Newest document per checklist type wins the display.
  const latestByType = new Map<string, NonNullable<typeof d>['documents'][number]>();
  for (const doc of d?.documents ?? []) {
    if (!latestByType.has(doc.docType)) latestByType.set(doc.docType, doc);
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="sw-title">Documents</h1>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">
          Upload renewals on a big screen — we review documents Monday to Saturday, 8:00–16:00 Guyana time. An expired document takes you
          offline until it is renewed.
        </p>
      </div>

      {d && isTaxiChecklist(d.checklist ?? []) && (
        <p className="rounded-2xl bg-[var(--swift-subtle)] p-4 text-sm">{TAXI_TWO_LICENCES}</p>
      )}

      {d && (
        <div className={`flex items-center gap-3 rounded-2xl p-4 ${d.roleVerified ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
          {d.roleVerified ? <ShieldCheck className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
          <p className="text-sm font-semibold">
            {d.roleVerified
              ? 'You are fully verified and cleared to work.'
              : `${d.missing.length} document${d.missing.length === 1 ? '' : 's'} still needed before you can go online.`}
          </p>
        </div>
      )}

      <div className="space-y-3">
        {status.isLoading && <p className="text-sm text-[var(--swift-muted)]">Loading…</p>}
        {/* [W-10] `d?.checklist ?? []` rendered an EMPTY checklist on failure —
            a mover was shown no document obligations at all during an outage,
            which is the opposite of the truth for anyone missing a document. */}
        {status.isError && (
          <DataUnavailable
            what="your document checklist"
            error={status.error}
            onRetry={() => void status.refetch()}
          />
        )}
        {(d?.checklist ?? []).filter((docType) => docType !== POLICE_CLEARANCE_DOC).map((docType) => {
          const doc = latestByType.get(docType);
          const tone = doc ? statusTone(doc.status, doc.expiresAt, doc.replaced === true) : null;
          // An approved document stays locked until its renewal window; a copy waiting for review can be replaced.
          const locked = doc?.status === 'APPROVED' && !expiringSoonAt(doc.expiresAt);
          return (
            <div key={docType} className="sw-card p-5">
              <div className="flex flex-wrap items-center gap-3">
                <p className="font-semibold">{pretty(docType)}</p>
                {tone ? (
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${tone.cls}`}>{tone.label}</span>
                ) : (
                  <span className="rounded-full bg-black/5 px-2.5 py-0.5 text-xs font-bold text-[var(--swift-muted)]">Not submitted</span>
                )}
                {doc?.expiresAt && (
                  <span className="text-xs text-[var(--swift-muted)]">expires {documentExpiryDay(doc.expiresAt)}</span>
                )}
                {!locked && (
                  <button
                    onClick={() => { setUploadFor(uploadFor === docType ? null : docType); setConsent(false); setError(null); }}
                    className="ml-auto rounded-lg border border-[var(--swift-border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--swift-subtle)]"
                  >
                    {doc?.status === 'PENDING' ? 'Replace this document' : doc?.status === 'APPROVED' ? 'Upload renewal' : doc ? 'Upload again' : 'Upload'}
                  </button>
                )}
              </div>
              {taxiDocumentHint(docType, d?.checklist ?? []) && (
                <p className="mt-1 text-xs text-[var(--swift-muted)]">{taxiDocumentHint(docType, d?.checklist ?? [])}</p>
              )}
              {doc?.reviewNote && doc.status === 'REJECTED' && (
                <p className="mt-2 text-sm text-[var(--swift-red)]">Reviewer: {doc.reviewNote}</p>
              )}
              {done === docType && <p className="mt-2 text-sm font-medium text-green-600">Submitted — it is in review ✓</p>}
              {uploadFor === docType && (
                <div className="mt-3 space-y-3 border-t border-[var(--swift-border)] pt-3">
                  <label className="flex items-start gap-2 text-xs text-[var(--swift-muted)]">
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--swift-red)]" />
                    <span>
                      I consent to Swift processing this document for verification, per the{' '}
                      <a href={LEGAL_URL('privacy')} target="_blank" rel="noreferrer" className="font-semibold text-[var(--swift-red)]">privacy notice</a>.
                      It is stored encrypted and shared only as the Privacy Policy explains.
                    </span>
                  </label>
                  <button
                    onClick={() => fileRef.current?.click()}
                    disabled={!consent || submit.isPending}
                    className="flex items-center gap-2 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    <FileUp className="h-4 w-4" /> {submit.isPending ? 'Uploading…' : 'Choose file (JPG, PNG or PDF)'}
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f && uploadFor) submit.mutate({ docType: uploadFor, file: f });
                      e.target.value = '';
                    }}
                  />
                  {error && <p className="text-sm text-[var(--swift-red)]">{error}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {d && offersPolice && (
        <section aria-labelledby="documents-optional" className="space-y-3">
          <div>
            <h2 id="documents-optional" className="text-lg font-bold">{OPTIONAL_HEADING}</h2>
            <p className="mt-1 text-sm text-[var(--swift-muted)]">{OPTIONAL_INTRO}</p>
          </div>
          {policeWords ? (
            <DocumentCard
              role="MOVER"
              docType={POLICE_CLEARANCE_DOC}
              doc={latestDocument(d.documents, POLICE_CLEARANCE_DOC)}
              isNext={false}
              optionalHint={optionalDocHint(POLICE_CLEARANCE_DOC)}
              consented={false}
              consentVia="checkbox"
              policeConsent={policeWords}
              onSent={() => void queryClient.invalidateQueries({ queryKey: ['p-docs'] })}
            />
          ) : (
            <div className="sw-card p-5">
              <p className="font-semibold">{docLabel(POLICE_CLEARANCE_DOC)}</p>
              <p className="mt-1 text-sm text-[var(--swift-muted)]">{POLICE_CLEARANCE_NO_WORDS}</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
