'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchClaims, approveClaim, rejectClaim, payClaim, fetchCashMetrics } from '@/lib/api';
import { StatusPill, gyd } from '@/components/detail';

const FILTERS = ['PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED', 'PAID', 'REJECTED'] as const;

/**
 * The under-$50 guarantee queue: failed cash handovers (no-show / refused)
 * with GPS + photo evidence. Deterministic guardrail flags (over_cap,
 * outlier, collusion_*) surface what needs a harder look.
 */
export default function ClaimsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('PENDING_REVIEW');
  const { data, isLoading } = useQuery({ queryKey: ['claims', filter], queryFn: () => fetchClaims(filter) });
  const metricsQ = useQuery({ queryKey: ['cash-metrics'], queryFn: fetchCashMetrics });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['claims'] });
    qc.invalidateQueries({ queryKey: ['cash-metrics'] });
  };
  const approve = useMutation({ mutationFn: (id: string) => approveClaim(id), onSuccess: invalidate });
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => rejectClaim(id, reason),
    onSuccess: invalidate,
  });
  const pay = useMutation({
    mutationFn: ({ id, reference }: { id: string; reference?: string }) => payClaim(id, reference),
    onSuccess: invalidate,
  });

  const rows: any[] = data?.data ?? [];
  const m: any = metricsQ.data?.data ?? {};
  const busy = approve.isPending || reject.isPending || pay.isPending;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Guarantee claims</h1>
      <p className="text-[var(--muted)] text-sm mb-6">
        Failed cash handovers under the company guarantee — GPS-evidenced, guardrail-flagged. Approve, reject, or mark the payout done.
      </p>

      {/* Founder cockpit numbers (cash-rules founderMetrics) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-[var(--panel)] rounded-xl p-6 border border-[var(--border)]">
          <p className="text-[var(--muted)] text-sm">Failed-payment rate (30d)</p>
          <p className="text-3xl font-bold mt-1">
            {metricsQ.isLoading ? '—' : m.failedPaymentPct != null ? `${Number(m.failedPaymentPct).toFixed(1)}%` : '—'}
          </p>
          <p className="text-[var(--muted)] text-xs mt-1">failed handovers vs completed</p>
        </div>
        <div className="bg-[var(--panel)] rounded-xl p-6 border border-[var(--border)]">
          <p className="text-[var(--muted)] text-sm">Guarantee payouts (7d)</p>
          <p className="text-3xl font-bold mt-1">{metricsQ.isLoading ? '—' : gyd(m.guaranteePayoutsThisWeek?.total ?? 0)}</p>
          <p className="text-[var(--muted)] text-xs mt-1">{m.guaranteePayoutsThisWeek?.count ?? 0} approved claims</p>
        </div>
        <div className="bg-[var(--panel)] rounded-xl p-6 border border-[var(--border)]">
          <p className="text-[var(--muted)] text-sm">Riders with claims (30d)</p>
          <p className="text-3xl font-bold mt-1">{metricsQ.isLoading ? '—' : Number((m.claimsByRider ?? []).length).toLocaleString()}</p>
          <p className="text-[var(--muted)] text-xs mt-1">repeat filers surface first</p>
        </div>
      </div>

      <div className="flex gap-1 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2.5 py-1 rounded-lg text-xs ${
              filter === f ? 'bg-white text-black font-semibold' : 'bg-white/5 text-[var(--muted)] hover:bg-white/10'
            }`}
          >
            {f.replaceAll('_', ' ').toLowerCase()}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {isLoading ? (
          <div className="h-24 rounded-xl bg-[var(--panel)] border border-[var(--border)] animate-pulse" />
        ) : rows.length === 0 ? (
          <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-8 text-center text-[var(--muted)]">
            No {filter.replaceAll('_', ' ').toLowerCase()} claims.
          </div>
        ) : (
          rows.map((c: any) => (
            <div key={c.id} className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xl font-bold">{gyd(c.amount)}</span>
                <StatusPill value={c.status} />
                <span className="px-2.5 py-1 rounded-full text-xs bg-white/10 text-[var(--muted)]">
                  {String(c.reason).replaceAll('_', ' ')}
                </span>
                {(c.flags ?? []).map((f: string) => (
                  <span key={f} className="px-2.5 py-1 rounded-full text-xs bg-red-500/15 text-red-400">
                    {f.replaceAll('_', ' ')}
                  </span>
                ))}
                <span className="text-xs text-[var(--muted)] ml-auto">{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-[var(--muted)]">
                <Link href={`/orders/${c.orderId}`} className="hover:text-[var(--accent)] transition-colors">
                  View order →
                </Link>
                <a
                  href={`https://maps.google.com/?q=${c.gpsLat},${c.gpsLng}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-white transition-colors"
                >
                  GPS evidence ({Number(c.gpsLat).toFixed(4)}, {Number(c.gpsLng).toFixed(4)})
                </a>
                {c.photoUrl ? <span>photo attached</span> : <span>no photo</span>}
                {c.reviewNote ? <span className="italic">“{c.reviewNote}”</span> : null}
              </div>
              {(c.status === 'PENDING_REVIEW' || c.status === 'AUTO_APPROVED' || c.status === 'APPROVED') && (
                <div className="flex gap-2 mt-4">
                  {c.status === 'PENDING_REVIEW' && (
                    <>
                      <button
                        onClick={() => {
                          if (window.confirm(`Approve this ${gyd(c.amount)} claim?`)) approve.mutate(c.id);
                        }}
                        disabled={busy}
                        className="px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => {
                          const reason = window.prompt('Rejection reason (the rider sees this):');
                          if (reason && reason.trim().length >= 3) reject.mutate({ id: c.id, reason: reason.trim() });
                        }}
                        disabled={busy}
                        className="px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {(c.status === 'APPROVED' || c.status === 'AUTO_APPROVED') && (
                    <button
                      onClick={() => {
                        const ref = window.prompt('Payment reference (optional):') ?? undefined;
                        if (window.confirm(`Mark this ${gyd(c.amount)} claim as PAID?`)) pay.mutate({ id: c.id, reference: ref || undefined });
                      }}
                      disabled={busy}
                      className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
                    >
                      Mark paid
                    </button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
