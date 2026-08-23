'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchVerificationQueue,
  getDocSignedUrl,
  approveDoc,
  rejectDoc,
  type InsuranceCheck,
} from '@/lib/api';

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
type Status = (typeof STATUSES)[number];

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

export default function VerificationPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('PENDING');
  const [selected, setSelected] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [insurance, setInsurance] = useState<InsuranceCheck>(EMPTY_INSURANCE);

  const { data, isLoading } = useQuery({
    queryKey: ['verification', status],
    queryFn: () => fetchVerificationQueue(status),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['verification'] });
    setSelected(null);
    setReason('');
    setInsurance(EMPTY_INSURANCE);
  };

  const approveMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body?: { insurance?: InsuranceCheck } }) => approveDoc(id, body),
    onSuccess: refresh,
  });
  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => rejectDoc(id, reason),
    onSuccess: refresh,
  });

  const select = (doc: any) => {
    setSelected(doc);
    setReason('');
    setInsurance(EMPTY_INSURANCE);
  };

  const viewDocument = async (id: string) => {
    try {
      const res = await getDocSignedUrl(id);
      if (res?.data?.url) window.open(res.data.url, '_blank', 'noopener');
    } catch {
      alert('Could not open document (it may have been purged under retention).');
    }
  };

  const isInsurance = selected?.docType === 'vehicle_insurance';
  const insuranceReady = insurance.insurerName.trim() !== '' && insurance.policyNumber.trim() !== '';

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

              <button
                onClick={() => viewDocument(selected.id)}
                className="w-full px-3 py-2 bg-[var(--panel-2)] text-white rounded-lg text-sm hover:bg-[#3A3A3C]"
              >
                View document (signed URL)
              </button>

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
                </div>
              )}

              {selected.status === 'PENDING' && (
                <div className="space-y-2 border-t border-[var(--border)] pt-3">
                  <button
                    disabled={approveMutation.isPending || (isInsurance && !insuranceReady)}
                    onClick={() => approveMutation.mutate({ id: selected.id, body: isInsurance ? { insurance } : undefined })}
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
                    disabled={rejectMutation.isPending || reason.trim().length < 3}
                    onClick={() => rejectMutation.mutate({ id: selected.id, reason })}
                    className="w-full px-3 py-2 bg-red-500/20 text-red-400 rounded-lg text-sm hover:bg-red-500/30 disabled:opacity-40"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
