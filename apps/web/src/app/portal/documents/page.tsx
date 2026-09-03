'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, ShieldCheck, AlertTriangle } from 'lucide-react';
import {
  getRiderProfile, getVerificationStatus, submitVerificationDocument, uploadVerificationFile,
} from '@/lib/mover-api';
import { DataUnavailable } from '@/components/data-unavailable';
import { LEGAL_URL } from '@/lib/api';

const pretty = (docType: string) => docType.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function statusTone(s: string, expiresAt: string | null) {
  const expiringSoon = expiresAt && new Date(expiresAt).getTime() - Date.now() < 30 * 24 * 3600 * 1000;
  if (s === 'APPROVED' && expiringSoon) return { label: 'Expiring soon', cls: 'bg-amber-100 text-amber-700' };
  if (s === 'APPROVED') return { label: 'Approved', cls: 'bg-green-100 text-green-700' };
  if (s === 'PENDING') return { label: 'In review', cls: 'bg-sky-100 text-sky-700' };
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
  // Newest document per checklist type wins the display.
  const latestByType = new Map<string, NonNullable<typeof d>['documents'][number]>();
  for (const doc of d?.documents ?? []) {
    if (!latestByType.has(doc.docType)) latestByType.set(doc.docType, doc);
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold">Documents</h1>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">
          Upload renewals on a big screen — reviews usually finish within 24 hours. An expired document takes you
          offline until it is renewed.
        </p>
      </div>

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
        {(d?.checklist ?? []).map((docType) => {
          const doc = latestByType.get(docType);
          const tone = doc ? statusTone(doc.status, doc.expiresAt) : null;
          return (
            <div key={docType} className="rounded-2xl border border-black/5 bg-white p-5">
              <div className="flex flex-wrap items-center gap-3">
                <p className="font-semibold">{pretty(docType)}</p>
                {tone ? (
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${tone.cls}`}>{tone.label}</span>
                ) : (
                  <span className="rounded-full bg-black/5 px-2.5 py-0.5 text-xs font-bold text-[var(--swift-muted)]">Not submitted</span>
                )}
                {doc?.expiresAt && (
                  <span className="text-xs text-[var(--swift-muted)]">expires {new Date(doc.expiresAt).toLocaleDateString()}</span>
                )}
                <button
                  onClick={() => { setUploadFor(uploadFor === docType ? null : docType); setConsent(false); setError(null); }}
                  className="ml-auto rounded-lg border border-black/10 px-3 py-1.5 text-xs font-semibold hover:bg-[var(--swift-subtle)]"
                >
                  {doc ? 'Upload renewal' : 'Upload'}
                </button>
              </div>
              {doc?.reviewNote && doc.status === 'REJECTED' && (
                <p className="mt-2 text-sm text-[var(--swift-red)]">Reviewer: {doc.reviewNote}</p>
              )}
              {done === docType && <p className="mt-2 text-sm font-medium text-green-600">Submitted — it is in review ✓</p>}
              {uploadFor === docType && (
                <div className="mt-3 space-y-3 border-t border-black/5 pt-3">
                  <label className="flex items-start gap-2 text-xs text-[var(--swift-muted)]">
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--swift-red)]" />
                    <span>
                      I consent to Swift processing this document for verification, per the{' '}
                      <a href={LEGAL_URL('privacy')} target="_blank" rel="noreferrer" className="font-semibold text-[var(--swift-red)]">privacy notice</a>.
                      It is stored encrypted and never shared.
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
    </div>
  );
}
