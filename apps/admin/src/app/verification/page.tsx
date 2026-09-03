'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DataUnavailable } from '@/components/dashboard/DataUnavailable';
import {
  fetchVerificationQueue,
  getDocSignedUrl,
  approveDoc,
  rejectDoc,
  type InsuranceCheck,
} from '@/lib/api';
import { MutationError } from '@/components/MutationError';

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

export default function VerificationPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('PENDING');
  const [lane, setLane] = useState<Lane>('operator');
  const [selected, setSelected] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [insurance, setInsurance] = useState<InsuranceCheck>(EMPTY_INSURANCE);
  const [mutationError, setMutationError] = useState<unknown>(null);
  // [A-19] Which document has actually been OPENED in this session, and the
  // expiry the reviewer keyed off it. Approving used to be possible without
  // ever looking at the evidence, and without recording the printed date.
  const [previewed, setPreviewed] = useState<Set<string>>(new Set());
  const [expiresAt, setExpiresAt] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['verification', status, lane],
    queryFn: () => fetchVerificationQueue(status, lane),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['verification'] });
    setSelected(null);
    setReason('');
    setInsurance(EMPTY_INSURANCE);
    setExpiresAt('');
    setMutationError(null);
  };

  const approveMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body?: { insurance?: InsuranceCheck } }) => approveDoc(id, body),
    onMutate: () => setMutationError(null),
    onError: (error) => setMutationError(error),
    onSuccess: refresh,
  });
  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => rejectDoc(id, reason),
    onMutate: () => setMutationError(null),
    onError: (error) => setMutationError(error),
    onSuccess: refresh,
  });

  const select = (doc: any) => {
    setSelected(doc);
    setReason('');
    setInsurance(EMPTY_INSURANCE);
    setExpiresAt('');
    setMutationError(null);
  };

  const viewDocument = async (id: string) => {
    try {
      const res = await getDocSignedUrl(id);
      if (!res?.data?.url) throw new Error('no url');
      window.open(res.data.url, '_blank', 'noopener');
      // Only a SUCCESSFUL open counts. A signed-URL failure must not unlock the
      // decision — that is the "false green" half of this defect.
      setPreviewed((seen) => new Set(seen).add(id));
    } catch {
      alert('Could not open document (it may have been purged under retention).');
    }
  };

  const isInsurance = selected?.docType === 'vehicle_insurance';
  const insuranceReady =
    insurance.insurerName.trim() !== '' &&
    insurance.policyNumber.trim() !== '' &&
    (insurance.coverageClass !== 'HIRE' || (insurance.hireClassConfirmed && insurance.plateCrossChecked));
  const decisionPending = approveMutation.isPending || rejectMutation.isPending;
  // [A-19] The three things an approval now requires: the evidence was actually
  // OPENED, the printed expiry was keyed for a type that has one, and it is in
  // the future.
  const needsExpiry = selected ? EXPIRING_DOC_TYPES.includes(selected.docType) : false;
  const expiryOk = !needsExpiry || (expiresAt !== '' && new Date(expiresAt).getTime() > Date.now());
  const hasPreviewed = selected ? previewed.has(selected.id) : false;
  const approveBlocked = !hasPreviewed || !expiryOk || (isInsurance && !insuranceReady);
  const applicantName = selected
    ? [selected.user?.firstName, selected.user?.lastName].filter(Boolean).join(' ') || 'this applicant'
    : '';
  const documentLabel = selected ? String(selected.docType).replaceAll('_', ' ') : '';

  const rows: any[] = data?.data ?? [];

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
            onClick={() => { setStatus(s); setSelected(null); }}
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
            onClick={() => { setLane(l.value); setSelected(null); }}
            className={`px-3 py-1.5 rounded-lg text-xs ${
              lane === l.value ? 'bg-[var(--accent)] text-white' : 'bg-[var(--panel)] text-[var(--muted)] border border-[var(--border)]'
            }`}
          >
            {l.label}
          </button>
        ))}
        {lane !== 'operator' && (
          <span className="text-xs text-[var(--muted)]">
            Customer IDs are shown here deliberately — every document view is audit-logged.
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Queue */}
        <div className="lg:col-span-2 bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-hidden">
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
                      <div className="text-xs text-[var(--muted)]">{doc.user?.phone}</div>
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
        </div>

        {/* Detail panel */}
        <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-4 h-fit">
          {!selected ? (
            <p className="text-[var(--muted)] text-sm">Select a document to review.</p>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="font-semibold">{selected.user?.firstName} {selected.user?.lastName}</div>
                <div className="text-xs text-[var(--muted)]">{selected.user?.phone} · {selected.user?.countryCode}</div>
              </div>

              <div className="text-sm space-y-1">
                <div><span className="text-[var(--muted)]">Document:</span> {String(selected.docType).replace(/_/g, ' ')}</div>
                <div><span className="text-[var(--muted)]">Status:</span> {selected.status}</div>
                <div><span className="text-[var(--muted)]">Consent:</span> {selected.consentAt ? `notice ${selected.privacyNoticeVersion ?? ''}` : 'none on file'}</div>
              </div>

              {/* [A-19] The vehicle facts the reviewer is asked to cross-check.
                  The H-plate checkbox below used to assert a comparison against
                  something the page never showed. */}
              {selected.user?.driver && (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-sm">
                  <div className="text-xs font-medium text-[var(--muted)]">On file for this driver</div>
                  <div className="mt-1 font-mono text-base">{selected.user.driver.licensePlate ?? '—'}</div>
                  <div className="text-xs text-[var(--muted)]">
                    {[selected.user.driver.vehicleMake, selected.user.driver.vehicleModel, selected.user.driver.vehicleType]
                      .filter(Boolean).join(' · ') || 'no vehicle on file'}
                  </div>
                </div>
              )}

              <button
                onClick={() => viewDocument(selected.id)}
                className="w-full px-3 py-2 bg-[var(--panel-2)] text-white rounded-lg text-sm hover:bg-[#3A3A3C]"
              >
                {hasPreviewed ? 'View document again' : 'View document (signed URL)'}
              </button>
              {!hasPreviewed && (
                <p className="text-xs text-amber-400">
                  Open the document before deciding — a decision without opening it is not a review.
                </p>
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
                  <button
                    disabled={decisionPending || approveBlocked}
                    onClick={() => {
                      if (window.confirm(`Approve ${documentLabel} for ${applicantName}? This changes their operating eligibility.`)) {
                        approveMutation.mutate({
                          id: selected.id,
                          body: {
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
                  <textarea
                    placeholder="Rejection reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="w-full px-3 py-2 bg-[var(--panel-2)] rounded-lg text-sm border border-[var(--border)]"
                    rows={2}
                  />
                  <button
                    disabled={decisionPending || reason.trim().length < 3}
                    onClick={() => {
                      const visibleReason = reason.trim();
                      if (window.confirm(`Reject ${documentLabel} for ${applicantName} with reason: "${visibleReason}"?`)) {
                        rejectMutation.mutate({ id: selected.id, reason: visibleReason });
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
