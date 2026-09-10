'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DataUnavailable } from '@/components/dashboard/DataUnavailable';
import {
  apiMediaUrl,
  fetchVerificationQueue,
  getVerificationReviewDetail,
  getDocSignedUrl,
  acknowledgeVerificationDocumentRendered,
  claimVerificationCase,
  releaseVerificationCase,
  approveDoc,
  rejectDoc,
  VERIFICATION_REJECTION_REASON_CODES,
  type InsuranceCheck,
  type VerificationRejectionReasonCode,
} from '@/lib/api';
import { MutationError } from '@/components/MutationError';
import { SecureDocumentViewer } from '@/components/verification/SecureDocumentViewer';

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
type Status = (typeof STATUSES)[number];

// [A-19] Document types that carry a printed expiry date. Mirrors
// AUTO_APPROVE_EXPIRY_DAYS in apps/api verification.service.ts — the server is
// the authority and refuses these without a date; a census test asserts the two
// lists stay identical, so this copy cannot drift.
const EXPIRING_DOC_TYPES = [
  'police_clearance', 'fitness_cert', 'vehicle_insurance', 'hire_car_permit',
  'road_service_licence', 'food_handler_cert', 'gra_restaurant_licence',
  'drivers_licence', 'vehicle_registration',
  // [DOC-1 §18.1] the addendum's annual licences, submittable through a category gate
  'liquor_licence', 'sanitary_certificate', 'trade_licence',
  // [DOC-1 §3.6 · P3-2] the unregistered trader's signed self-declaration — a one-year
  // validity like a licence, so the console must ask for its date too.
  'self_declaration_unregistered',
] as const;

const EMPTY_INSURANCE: InsuranceCheck = {
  insurerName: '',
  policyNumber: '',
  coverageClass: 'HIRE',
  hireClassConfirmed: false,
  plateCrossChecked: false,
};

function statusClass(status: string) {
  if (status === 'APPROVED') return 'bg-green-500/20 text-green-400';
  if (status === 'PENDING') return 'bg-yellow-500/20 text-yellow-400';
  return 'bg-red-500/20 text-red-400';
}

/** [G6] Review lanes. A customer's national ID (uploaded for the high-value
 *  order gate) is not routine review work: the operator lane is the default
 *  view, and customer identity is opened by name, on purpose. Mirrors the API
 *  default — the two must agree or the page lies about what it shows. */
const LANES = [
  { value: 'operator', label: 'Operators' },
  { value: 'customer', label: 'Customers' },
  { value: 'all', label: 'Everything' },
] as const;
type Lane = (typeof LANES)[number]['value'];

interface BoundDocumentView {
  documentId: string;
  caseId: string;
  assignmentAt: string;
  url: string;
  mimeType: string;
  reviewGrantToken: string;
  expiresAtEpochMs: number;
  label: string;
}

export default function VerificationPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('PENDING');
  const [lane, setLane] = useState<Lane>('operator');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<any>(null);
  const [documentView, setDocumentView] = useState<BoundDocumentView | null>(null);
  const [acknowledgedGrantToken, setAcknowledgedGrantToken] = useState<string | null>(null);
  const [renderAckPending, setRenderAckPending] = useState(false);
  const [approvalReason, setApprovalReason] = useState('');
  const [reason, setReason] = useState('');
  const [reasonCode, setReasonCode] = useState<VerificationRejectionReasonCode | ''>('');
  const [insurance, setInsurance] = useState<InsuranceCheck>(EMPTY_INSURANCE);
  const [mutationError, setMutationError] = useState<unknown>(null);
  const [expiresAt, setExpiresAt] = useState('');
  const selectedRef = useRef<any>(null);
  const documentViewRef = useRef<BoundDocumentView | null>(null);
  const viewEpochRef = useRef(0);
  selectedRef.current = selected;
  documentViewRef.current = documentView;

  const clearDocumentReview = () => {
    viewEpochRef.current += 1;
    setDocumentView(null);
    setAcknowledgedGrantToken(null);
    setRenderAckPending(false);
  };

  useEffect(() => () => {
    // Invalidates an outstanding grant-mint or render acknowledgement without
    // calling a state setter after unmount.
    viewEpochRef.current += 1;
  }, []);

  useEffect(() => {
    if (!documentView) return;
    const token = documentView.reviewGrantToken;
    const remaining = documentView.expiresAtEpochMs - Date.now();
    const expire = () => {
      if (documentViewRef.current?.reviewGrantToken !== token) return;
      viewEpochRef.current += 1;
      setDocumentView(null);
      setAcknowledgedGrantToken(null);
      setRenderAckPending(false);
      setMutationError(new Error('The secure review grant expired. Reopen the document before deciding.'));
    };
    if (remaining <= 0) {
      expire();
      return;
    }
    const timer = window.setTimeout(expire, remaining);
    return () => window.clearTimeout(timer);
  }, [documentView]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['verification', status, lane, page],
    queryFn: () => fetchVerificationQueue(status, lane, page),
  });
  const detailQuery = useQuery({
    queryKey: [
      'verification-detail',
      selected?.id,
      selected?.reviewCase?.id,
      selected?.reviewCase?.assignedAt,
    ],
    queryFn: () => getVerificationReviewDetail(selected.id),
    enabled: Boolean(
      selected?.id
      && selected?.reviewCase?.claimedByMe === true
      && selected?.reviewCase?.assignedAt,
    ),
    // Decrypted PII belongs only to the active assignment. Remove it from the
    // query cache as soon as this observer closes instead of keeping React
    // Query's normal multi-minute inactive cache.
    gcTime: 0,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['verification'] });
    setSelected(null);
    clearDocumentReview();
    setApprovalReason('');
    setReason('');
    setReasonCode('');
    setInsurance(EMPTY_INSURANCE);
    setExpiresAt('');
    setMutationError(null);
  };

  const approveMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { reason: string; reviewGrantToken: string; expiresAt?: string; insurance?: InsuranceCheck } }) => approveDoc(id, body),
    onMutate: () => setMutationError(null),
    onError: (error) => setMutationError(error),
    onSuccess: refresh,
  });
  const rejectMutation = useMutation({
    mutationFn: ({ id, reason, reasonCode, reviewGrantToken }: { id: string; reason: string; reasonCode: VerificationRejectionReasonCode; reviewGrantToken: string }) => rejectDoc(id, reason, reasonCode, reviewGrantToken),
    onMutate: () => setMutationError(null),
    onError: (error) => setMutationError(error),
    onSuccess: refresh,
  });
  const claimMutation = useMutation({
    mutationFn: ({ caseId }: { documentId: string; caseId: string }) => claimVerificationCase(caseId),
    onMutate: () => setMutationError(null),
    onError: (error) => setMutationError(error),
    onSuccess: (result, target) => {
      const current = selectedRef.current;
      if (current?.id === target.documentId && current?.reviewCase?.id === target.caseId) {
        clearDocumentReview();
        setSelected((selectedDocument: any) => selectedDocument ? {
          ...selectedDocument,
          reviewCase: { ...selectedDocument.reviewCase, ...result.data, claimedByMe: true },
        } : selectedDocument);
      }
      void queryClient.invalidateQueries({ queryKey: ['verification'] });
      void queryClient.invalidateQueries({ queryKey: ['verification-detail'] });
    },
  });
  const releaseMutation = useMutation({
    mutationFn: ({ caseId }: { documentId: string; caseId: string; assignmentAt: string }) => releaseVerificationCase(caseId),
    onMutate: () => setMutationError(null),
    onError: (error) => setMutationError(error),
    onSuccess: (_result, target) => {
      const current = selectedRef.current;
      if (
        current?.id === target.documentId
        && current?.reviewCase?.id === target.caseId
        && String(current?.reviewCase?.assignedAt) === target.assignmentAt
      ) {
        clearDocumentReview();
        setSelected((selectedDocument: any) => selectedDocument ? {
          ...selectedDocument,
          reviewCase: selectedDocument.reviewCase
            ? { ...selectedDocument.reviewCase, claimedByMe: false, assignedAt: null }
            : null,
        } : selectedDocument);
      }
      void queryClient.invalidateQueries({ queryKey: ['verification'] });
      void queryClient.invalidateQueries({ queryKey: ['verification-detail'] });
    },
  });

  const select = (doc: any) => {
    clearDocumentReview();
    setSelected(doc);
    setApprovalReason('');
    setReason('');
    setReasonCode('');
    setInsurance(EMPTY_INSURANCE);
    setExpiresAt('');
    setMutationError(null);
  };

  const viewDocument = async (id: string) => {
    const target = selectedRef.current;
    const targetCase = target?.reviewCase;
    if (
      target?.id !== id
      || targetCase?.claimedByMe !== true
      || typeof targetCase.id !== 'string'
      || !targetCase.assignedAt
    ) {
      setMutationError(new Error('Claim this exact review case before opening its document.'));
      return;
    }
    const requestEpoch = viewEpochRef.current + 1;
    viewEpochRef.current = requestEpoch;
    setDocumentView(null);
    setAcknowledgedGrantToken(null);
    setRenderAckPending(false);
    const assignmentAt = String(targetCase.assignedAt);
    const label = `${String(target.docType).replaceAll('_', ' ')} submitted by ${[
      target.user?.firstName,
      target.user?.lastName,
    ].filter(Boolean).join(' ') || 'this applicant'}`;
    try {
      const res = await getDocSignedUrl(id);
      if (
        !res?.data?.url
        || typeof res?.data?.reviewGrantToken !== 'string'
        || typeof res?.data?.expiresInSeconds !== 'number'
        || !Number.isFinite(res.data.expiresInSeconds)
        || res.data.expiresInSeconds <= 0
      ) {
        throw new Error('The API did not return a complete review grant.');
      }
      const current = selectedRef.current;
      if (
        viewEpochRef.current !== requestEpoch
        || current?.id !== id
        || current?.reviewCase?.id !== targetCase.id
        || String(current?.reviewCase?.assignedAt) !== assignmentAt
        || current?.reviewCase?.claimedByMe !== true
      ) return;
      setDocumentView({
        documentId: id,
        caseId: targetCase.id,
        assignmentAt,
        url: apiMediaUrl(res.data.url),
        mimeType: res.data.mimeType ?? detailQuery.data?.data?.content?.mimeType ?? 'application/octet-stream',
        reviewGrantToken: res.data.reviewGrantToken,
        // Treat the server's remaining TTL conservatively. This timer relocks
        // the UI; the server remains the final authority if clocks or transit
        // time differ.
        expiresAtEpochMs: Date.now() + Math.max(0, res.data.expiresInSeconds * 1000 - 1_000),
        label,
      });
    } catch (error) {
      if (viewEpochRef.current !== requestEpoch) return;
      setDocumentView(null);
      setAcknowledgedGrantToken(null);
      setMutationError(error);
      alert('Could not open document (it may have been purged under retention).');
    }
  };

  const acknowledgeDocumentRendered = async (view: BoundDocumentView) => {
    if (documentViewRef.current?.reviewGrantToken !== view.reviewGrantToken) return;
    const acknowledgementEpoch = viewEpochRef.current;
    setRenderAckPending(true);
    setAcknowledgedGrantToken(null);
    try {
      await acknowledgeVerificationDocumentRendered(view.documentId, view.reviewGrantToken);
      const current = selectedRef.current;
      if (
        viewEpochRef.current !== acknowledgementEpoch
        || documentViewRef.current?.reviewGrantToken !== view.reviewGrantToken
        || current?.id !== view.documentId
        || current?.reviewCase?.id !== view.caseId
        || String(current?.reviewCase?.assignedAt) !== view.assignmentAt
        || current?.reviewCase?.claimedByMe !== true
      ) return;
      setAcknowledgedGrantToken(view.reviewGrantToken);
    } catch (error) {
      if (viewEpochRef.current === acknowledgementEpoch) {
        setAcknowledgedGrantToken(null);
        setMutationError(error);
      }
    } finally {
      if (viewEpochRef.current === acknowledgementEpoch) setRenderAckPending(false);
    }
  };

  const rows: any[] = data?.data ?? [];
  const meta = data?.meta;
  const detail = detailQuery.data?.data;
  const applicant = detail?.applicant ?? selected?.user;

  const isInsurance = selected?.docType === 'vehicle_insurance';
  const insuranceReady =
    insurance.insurerName.trim() !== '' &&
    insurance.policyNumber.trim() !== '' &&
    (insurance.coverageClass !== 'HIRE' || (insurance.hireClassConfirmed && insurance.plateCrossChecked));
  const decisionPending = approveMutation.isPending || rejectMutation.isPending
    || claimMutation.isPending || releaseMutation.isPending || renderAckPending;
  // [A-19] The three things an approval now requires: the evidence was actually
  // OPENED, the printed expiry was keyed for a type that has one, and it is in
  // the future.
  const needsExpiry = selected ? EXPIRING_DOC_TYPES.includes(selected.docType) : false;
  const expiryOk = !needsExpiry || (expiresAt !== '' && new Date(expiresAt).getTime() > Date.now());
  const viewMatchesSelected = Boolean(
    documentView
    && selected?.id === documentView.documentId
    && selected?.reviewCase?.id === documentView.caseId
    && String(selected?.reviewCase?.assignedAt) === documentView.assignmentAt
    && selected?.reviewCase?.claimedByMe === true,
  );
  const hasPreviewed = Boolean(
    viewMatchesSelected
    && acknowledgedGrantToken
    && acknowledgedGrantToken === documentView?.reviewGrantToken,
  );
  const caseReady = Boolean(
    selected?.reviewCase?.claimedByMe === true && selected?.reviewCase?.assignedAt,
  );
  const approveBlocked = !caseReady || !hasPreviewed || approvalReason.trim().length < 12 || !expiryOk || (isInsurance && !insuranceReady);
  const rejectBlocked = !caseReady || !hasPreviewed || reason.trim().length < 12 || !reasonCode;
  const applicantName = selected
    ? [applicant?.firstName, applicant?.lastName].filter(Boolean).join(' ') || 'this applicant'
    : '';
  const documentLabel = selected ? String(selected.docType).replaceAll('_', ' ') : '';

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Verification Center</h1>
      <p className="text-[var(--muted)] mb-6 text-sm">
        Review submitted documents. Drivers cannot carry passengers until a hire-class
        insurance is confirmed here.
      </p>

      <div className="flex gap-2 mb-4">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => { clearDocumentReview(); setStatus(s); setPage(1); setSelected(null); }}
            className={`px-3 py-1.5 rounded-lg text-xs ${
              status === s ? 'bg-[var(--accent)] text-white' : 'bg-[var(--panel)] text-[var(--muted)] border border-[var(--border)]'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 mb-4">
        {LANES.map((l) => (
          <button
            key={l.value}
            onClick={() => { clearDocumentReview(); setLane(l.value); setPage(1); setSelected(null); }}
            className={`px-3 py-1.5 rounded-lg text-xs ${
              lane === l.value ? 'bg-[var(--accent)] text-white' : 'bg-[var(--panel)] text-[var(--muted)] border border-[var(--border)]'
            }`}
          >
            {l.label}
          </button>
        ))}
        {lane !== 'operator' && (
          <span className="text-xs text-[var(--muted)]">
            Customer IDs are shown here deliberately. Sensitive detail, grant, fetch, and browser-render events are recorded separately.
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Queue */}
        <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-hidden h-fit">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="text-left p-4 text-[var(--muted)] font-medium">Applicant</th>
                <th className="text-left p-4 text-[var(--muted)] font-medium">Role</th>
                <th className="text-left p-4 text-[var(--muted)] font-medium">Document</th>
                <th className="text-left p-4 text-[var(--muted)] font-medium">Country</th>
                <th className="text-left p-4 text-[var(--muted)] font-medium">Status</th>
                <th className="text-right p-4 text-[var(--muted)] font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="p-8 text-center text-[var(--muted)]">Loading...</td></tr>
              ) : isError ? (
                /* [A-19] A failed read rendered "No documents" — an empty
                   compliance queue, to the person whose job is to work it. */
                <tr><td colSpan={6} className="p-4">
                  <DataUnavailable
                    what="the verification queue"
                    notAnAllClear="This is not an empty queue — we could not read it."
                    onRetry={() => void refetch()}
                  />
                </td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="p-8 text-center text-[var(--muted)]">No documents</td></tr>
              ) : (
                rows.map((doc) => (
                  <tr
                    key={doc.id}
                    className={`border-b border-[var(--border)] hover:bg-white/5 ${selected?.id === doc.id ? 'bg-white/5' : ''}`}
                  >
                    <td className="p-4">
                      <div className="font-medium">{doc.user?.firstName} {doc.user?.lastName}</div>
                    </td>
                    <td className="p-4">{doc.role}</td>
                    <td className="p-4">{String(doc.docType).replace(/_/g, ' ')}</td>
                    <td className="p-4">{doc.user?.countryCode}</td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded-full text-xs ${statusClass(doc.status)}`}>{doc.status}</span>
                    </td>
                    <td className="p-4 text-right">
                      <button
                        onClick={() => select(doc)}
                        className="px-3 py-1 bg-[var(--panel-2)] text-white rounded-lg text-xs hover:bg-[#3A3A3C]"
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {meta && (meta.hasPrev || meta.hasNext) && (
            <nav aria-label="Verification queue pages" className="flex items-center justify-between p-3 border-t border-[var(--border)]">
              <button
                disabled={!meta.hasPrev || isLoading}
                onClick={() => { clearDocumentReview(); setPage((value) => Math.max(1, value - 1)); setSelected(null); }}
                className="px-3 py-1.5 rounded-lg text-xs bg-[var(--panel-2)] disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-xs text-[var(--muted)]">Page {meta.page} of {meta.totalPages} · {meta.total} documents</span>
              <button
                disabled={!meta.hasNext || isLoading}
                onClick={() => { clearDocumentReview(); setPage((value) => value + 1); setSelected(null); }}
                className="px-3 py-1.5 rounded-lg text-xs bg-[var(--panel-2)] disabled:opacity-40"
              >
                Next
              </button>
            </nav>
          )}
        </div>

        {/* Detail panel */}
        <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-4 h-fit">
          {!selected ? (
            <p className="text-[var(--muted)] text-sm">Select a document to review.</p>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="font-semibold">{applicant?.firstName} {applicant?.lastName}</div>
                <div className="text-xs text-[var(--muted)]">{applicant?.phone ?? 'Phone withheld until the claimed detail loads'} · {applicant?.countryCode}</div>
              </div>

              <div className="text-sm space-y-1">
                <div><span className="text-[var(--muted)]">Document:</span> {String(selected.docType).replace(/_/g, ' ')}</div>
                <div><span className="text-[var(--muted)]">Status:</span> {selected.status}</div>
                <div><span className="text-[var(--muted)]">Consent:</span> {detail?.document?.consentAt ? `notice ${detail.document.privacyNoticeVersion ?? ''}` : detailQuery.isSuccess ? 'none on file' : 'available after claim'}</div>
              </div>

              {detailQuery.isLoading && (
                <p className="text-xs text-[var(--muted)]">Loading extraction, validation and case history…</p>
              )}
              {detailQuery.isError && (
                <DataUnavailable
                  what="the document review record"
                  notAnAllClear="The source document may still exist, but its review evidence could not be loaded."
                  onRetry={() => void detailQuery.refetch()}
                />
              )}

              {selected.reviewCase && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-sm space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-medium text-[var(--muted)]">Review case</div>
                      <div>{String(selected.reviewCase.queue).replaceAll('_', ' ')} · priority {selected.reviewCase.priority}</div>
                    </div>
                    {selected.reviewCase.claimedByMe ? (
                      <button
                        disabled={decisionPending}
                        onClick={() => releaseMutation.mutate({
                          documentId: selected.id,
                          caseId: selected.reviewCase.id,
                          assignmentAt: String(selected.reviewCase.assignedAt),
                        })}
                        className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] disabled:opacity-40"
                      >
                        Release
                      </button>
                    ) : selected.reviewCase.assignedAt ? (
                      <span className="text-xs text-amber-400">Claimed by another reviewer</span>
                    ) : (
                      <button
                        disabled={decisionPending}
                        onClick={() => claimMutation.mutate({
                          documentId: selected.id,
                          caseId: selected.reviewCase.id,
                        })}
                        className="px-3 py-1.5 rounded-lg text-xs bg-[var(--accent)] text-white disabled:opacity-40"
                      >
                        Claim case
                      </button>
                    )}
                  </div>
                  {!caseReady && (
                    <p className="text-xs text-amber-400">Claim this case before viewing or deciding it.</p>
                  )}
                </div>
              )}

              {!selected.reviewCase && (
                <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
                  This submission has no open review case. Decisions are disabled until the queue integrity issue is repaired.
                </div>
              )}

              {detail?.legalHold && (
                <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
                  Legal hold active · review due {new Date(detail.legalHold.reviewBy).toLocaleDateString()}. The source image must not be purged.
                </div>
              )}

              {detail?.policy && (
                <div className="rounded-lg border border-[var(--border)] p-3 text-xs text-[var(--muted)]">
                  Data class: {detail.policy.bucket} · image policy: {String(detail.policy.imagePolicy).replaceAll('_', ' ')}
                  {detail.policy.amlRecordClass !== 'NOT_APPLICABLE' ? ` · record class: ${detail.policy.amlRecordClass}` : ''}
                </div>
              )}

              {/* [A-19] The vehicle facts the reviewer is asked to cross-check.
                  The H-plate checkbox below used to assert a comparison against
                  something the page never showed. */}
              {applicant?.driver && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-sm">
                  <div className="text-xs font-medium text-[var(--muted)]">On file for this driver</div>
                  <div className="mt-1 font-mono text-base">{applicant.driver.licensePlate ?? '—'}</div>
                  <div className="text-xs text-[var(--muted)]">
                    {[applicant.driver.vehicleMake, applicant.driver.vehicleModel, applicant.driver.vehicleType]
                      .filter(Boolean).join(' · ') || 'no vehicle on file'}
                  </div>
                </div>
              )}

              <button
                disabled={!caseReady}
                onClick={() => viewDocument(selected.id)}
                className="w-full px-3 py-2 bg-[var(--panel-2)] text-white rounded-lg text-sm hover:bg-[#3A3A3C] disabled:opacity-40"
              >
                {documentView ? 'Reload secure document viewer' : 'Open secure document viewer'}
              </button>
              {documentView && viewMatchesSelected && (
                <SecureDocumentViewer
                  url={documentView.url}
                  reviewGrantToken={documentView.reviewGrantToken}
                  mimeType={documentView.mimeType}
                  label={documentView.label}
                  onRendered={() => void acknowledgeDocumentRendered(documentView)}
                  onError={() => {
                    if (documentViewRef.current?.reviewGrantToken === documentView.reviewGrantToken) {
                      setAcknowledgedGrantToken(null);
                    }
                  }}
                />
              )}
              {renderAckPending && (
                <p role="status" className="text-xs text-[var(--muted)]">
                  Recording the completed browser render…
                </p>
              )}
              {!hasPreviewed && !renderAckPending && (
                <p className="text-xs text-amber-400">
                  Load the document content before deciding. The server requires a current session-, case-, assignment-, and generation-bound render acknowledgement.
                </p>
              )}

              {detail?.extraction?.length > 0 && (
                <details open className="rounded-lg border border-[var(--border)] p-3 text-sm">
                  <summary className="cursor-pointer font-medium">Extracted fields</summary>
                  <div className="mt-3 space-y-3">
                    {detail.extraction.map((run: any) => (
                      <div key={run.runId} className="space-y-2">
                        <div className="text-xs text-[var(--muted)]">
                          {run.engine} {run.engineVersion} · {run.outcome}
                          {run.confidence !== null ? ` · ${Math.round(run.confidence * 100)}% confidence` : ''}
                          {run.ranExternally ? ' · external processor' : ' · local processor'}
                        </div>
                        {run.fields.map((field: any) => (
                          <div key={field.code} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 border-t border-[var(--border)] pt-2">
                            <span className="font-mono text-xs">{field.code}</span>
                            <span className={field.valueUnavailable || field.illegible ? 'text-amber-400' : ''}>
                              {field.valueUnavailable ? 'Encrypted value unavailable' : field.illegible ? 'Illegible' : field.value ?? 'Not extracted'}
                            </span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {(detail?.validations?.length > 0 || detail?.missingDeclaredFields?.length > 0) && (
                <details className="rounded-lg border border-[var(--border)] p-3 text-sm">
                  <summary className="cursor-pointer font-medium">Validation checks</summary>
                  <div className="mt-3 space-y-2">
                    {detail.validations.map((validation: any) => (
                      <div key={validation.code} className="flex justify-between gap-3">
                        <span className="font-mono text-xs">{validation.code}</span>
                        <span className={validation.status === 'FAIL' ? 'text-red-400' : validation.status === 'PASS' ? 'text-green-400' : 'text-amber-400'}>
                          {validation.status}{validation.blocking ? ' · blocking' : ''}
                        </span>
                      </div>
                    ))}
                    {detail.missingDeclaredFields.map((field: any) => (
                      <div key={field.code} className="flex justify-between gap-3 text-amber-400">
                        <span className="font-mono text-xs">{field.code}</span>
                        <span>{field.required ? 'Required · no extraction row' : 'No extraction row'}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {detail?.cases?.length > 0 && (
                <details className="rounded-lg border border-[var(--border)] p-3 text-sm">
                  <summary className="cursor-pointer font-medium">Decision history</summary>
                  <div className="mt-3 space-y-3">
                    {detail.cases.map((reviewCase: any) => (
                      <div key={reviewCase.id} className="border-t border-[var(--border)] pt-2 first:border-0 first:pt-0">
                        <div className="text-xs text-[var(--muted)]">{reviewCase.queue} · opened {new Date(reviewCase.createdAt).toLocaleString()}</div>
                        {reviewCase.independentReviewRequired ? (
                          <div className="text-xs">Prior decisions are hidden until this independent review closes.</div>
                        ) : reviewCase.decisions.length === 0 ? (
                          <div className="text-xs">No decision yet</div>
                        ) : reviewCase.decisions.map((decision: any, index: number) => (
                          <div key={`${reviewCase.id}-${index}`} className="mt-1">
                            {decision.outcome} · {decision.reasonCode}
                            {decision.internalNote ? <div className="text-xs text-[var(--muted)]">{decision.internalNote}</div> : null}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {needsExpiry && (
                <div className="space-y-1 border-t border-[var(--border)] pt-3">
                  <label className="text-xs font-medium text-[var(--muted)]">
                    Expiry printed on the document (required)
                  </label>
                  <input
                    type="date"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    className="w-full px-3 py-2 bg-[var(--panel-2)] rounded-lg text-sm border border-[var(--border)]"
                  />
                  {!expiryOk && (
                    <p className="text-xs text-amber-400">
                      {expiresAt === ''
                        ? 'This document type expires — key the date from the document.'
                        : 'That date has already passed; an expired document cannot be approved.'}
                    </p>
                  )}
                </div>
              )}

              {isInsurance && (
                <div className="space-y-2 border-t border-[var(--border)] pt-3">
                  <div className="text-xs font-medium text-[var(--muted)]">Insurance 5-point check</div>
                  <input
                    placeholder="Insurer (e.g. GTM, GBTI)"
                    value={insurance.insurerName}
                    onChange={(e) => setInsurance({ ...insurance, insurerName: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--panel-2)] rounded-lg text-sm border border-[var(--border)]"
                  />
                  <input
                    placeholder="Policy number"
                    value={insurance.policyNumber}
                    onChange={(e) => setInsurance({ ...insurance, policyNumber: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--panel-2)] rounded-lg text-sm border border-[var(--border)]"
                  />
                  <select
                    value={insurance.coverageClass}
                    onChange={(e) => setInsurance({ ...insurance, coverageClass: e.target.value as 'HIRE' | 'PRIVATE' })}
                    className="w-full px-3 py-2 bg-[var(--panel-2)] rounded-lg text-sm border border-[var(--border)]"
                  >
                    <option value="HIRE">HIRE class</option>
                    <option value="PRIVATE">PRIVATE class</option>
                  </select>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={insurance.hireClassConfirmed}
                      onChange={(e) => setInsurance({ ...insurance, hireClassConfirmed: e.target.checked })}
                    />
                    Hire class confirmed (required for live rides)
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={insurance.plateCrossChecked}
                      onChange={(e) => setInsurance({ ...insurance, plateCrossChecked: e.target.checked })}
                    />
                    Cross-checked against the H-plate
                  </label>
                  {insurance.coverageClass === 'HIRE' && !(insurance.hireClassConfirmed && insurance.plateCrossChecked) && (
                    <p className="text-xs text-amber-400">
                      Both checks are required before HIRE cover can be approved for passenger work.
                    </p>
                  )}
                </div>
              )}

              {selected.status === 'PENDING' && (
                <div className="space-y-2 border-t border-[var(--border)] pt-3">
                  <label htmlFor="verification-approval-reason" className="text-xs font-medium text-[var(--muted)]">
                    Approval evidence and rationale (required)
                  </label>
                  <textarea
                    id="verification-approval-reason"
                    placeholder="State what you checked and why this document is acceptable"
                    value={approvalReason}
                    onChange={(e) => setApprovalReason(e.target.value)}
                    className="w-full px-3 py-2 bg-[var(--panel-2)] rounded-lg text-sm border border-[var(--border)]"
                    rows={3}
                  />
                  {approvalReason.trim().length > 0 && approvalReason.trim().length < 12 && (
                    <p className="text-xs text-amber-400">Give a reviewable reason of at least 12 characters.</p>
                  )}
                  <button
                    disabled={decisionPending || approveBlocked}
                    onClick={() => {
                      if (!documentView || !hasPreviewed) return;
                      if (window.confirm(`Approve ${documentLabel} for ${applicantName}? This changes their operating eligibility.`)) {
                        approveMutation.mutate({
                          id: selected.id,
                          body: {
                            reason: approvalReason.trim(),
                            reviewGrantToken: documentView.reviewGrantToken,
                            ...(needsExpiry ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
                            ...(isInsurance ? { insurance } : {}),
                          },
                        });
                      }
                    }}
                    className="w-full px-3 py-2 bg-[var(--accent)] text-white rounded-lg text-sm hover:bg-[var(--accent)]/80 disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <label htmlFor="verification-rejection-code" className="text-xs font-medium text-[var(--muted)]">
                    Rejection category (required)
                  </label>
                  <select
                    id="verification-rejection-code"
                    aria-label="Rejection category"
                    value={reasonCode}
                    onChange={(e) => setReasonCode(e.target.value as VerificationRejectionReasonCode | '')}
                    className="w-full px-3 py-2 bg-[var(--panel-2)] rounded-lg text-sm border border-[var(--border)]"
                  >
                    <option value="">Choose a category</option>
                    {VERIFICATION_REJECTION_REASON_CODES.map((code) => (
                      <option key={code} value={code}>{code.replaceAll('_', ' ')}</option>
                    ))}
                  </select>
                  <textarea
                    aria-label="Rejection reason"
                    placeholder="Rejection reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="w-full px-3 py-2 bg-[var(--panel-2)] rounded-lg text-sm border border-[var(--border)]"
                    rows={2}
                  />
                  <button
                    disabled={decisionPending || rejectBlocked}
                    onClick={() => {
                      if (!reasonCode || !documentView || !hasPreviewed) return;
                      const visibleReason = reason.trim();
                      if (window.confirm(`Reject ${documentLabel} for ${applicantName} with reason: "${visibleReason}"?`)) {
                        rejectMutation.mutate({
                          id: selected.id,
                          reason: visibleReason,
                          reasonCode,
                          reviewGrantToken: documentView.reviewGrantToken,
                        });
                      }
                    }}
                    className="w-full px-3 py-2 bg-red-500/20 text-red-400 rounded-lg text-sm hover:bg-red-500/30 disabled:opacity-40"
                  >
                    Reject
                  </button>
                  <MutationError
                    error={mutationError}
                    label="Verification action failed"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
