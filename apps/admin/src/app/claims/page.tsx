'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchClaims, approveClaim, rejectClaim, payClaim, fetchCashMetrics, fetchRlpReserve, adjustRlpReserve } from '@/lib/api';
import { StatusPill, gyd } from '@/components/detail';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { QueryFailed } from '@/components/mc/QueryFailed';

const FILTERS = ['PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED', 'PAID', 'REJECTED'] as const;

/**
 * The under-$50 guarantee queue: failed cash handovers (no-show / refused)
 * with GPS + photo evidence. Deterministic guardrail flags (over_cap,
 * outlier, collusion_*) surface what needs a harder look.
 *
 * [MISSION CONTROL · MONEY] Every decision here is money (C4): it is asked in
 * the page's panel — the payout's reference and amount, the reserve entry's
 * amount and note, and the reason, together — checked before anything is
 * sent, and answered on screen: "sent for a second admin's approval", done,
 * or the server's refusal kept in the panel.
 */
export default function ClaimsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('PENDING_REVIEW');
  const claimsQ = useQuery({ queryKey: ['claims', filter], queryFn: () => fetchClaims(filter) });
  const { data, isLoading } = claimsQ;
  const metricsQ = useQuery({ queryKey: ['cash-metrics'], queryFn: fetchCashMetrics });
  const actions = useActionRunner(() => {
    void qc.invalidateQueries({ queryKey: ['claims'] });
    void qc.invalidateQueries({ queryKey: ['cash-metrics'] });
    void qc.invalidateQueries({ queryKey: ['rlp-reserve'] });
  });

  const approve = (c: any) => void actions.run({
    title: `Approve this ${gyd(c.amount)} claim?`,
    body: <p>Order {c.orderId}. Approving means the company guarantee pays it; the payout is recorded separately once the money is sent.</p>,
    confirmLabel: 'Approve claim',
    submit: ({ reason }) => approveClaim(c.id, reason),
    success: () => `The ${gyd(c.amount)} claim is approved.`,
  });
  const reject = (c: any) => void actions.run({
    title: `Reject this ${gyd(c.amount)} claim?`,
    body: <p>Order {c.orderId}. Nothing is paid; the reason is what the filer is answered with.</p>,
    confirmLabel: 'Reject claim',
    submit: ({ reason }) => rejectClaim(c.id, reason),
    success: () => `The ${gyd(c.amount)} claim is rejected.`,
  });
  // [A-11] The reference must be unique — one transfer settles one claim — and
  // the payer states what they actually sent, which the server checks against
  // the claim's own figure before anything closes.
  const pay = (c: any) => void actions.run({
    title: `Mark this ${gyd(c.amount)} claim paid?`,
    body: <p>Order {c.orderId}. Record the transfer you already sent. The amount must be the claim&apos;s own figure, to the cent.</p>,
    confirmLabel: 'Mark paid',
    fields: [
      { kind: 'reference', name: 'reference', label: 'Payment reference', hint: 'Bank or MMG reference, or receipt number — unique to this payout' },
      { kind: 'amount', name: 'amount', label: 'Amount you transferred', hint: `In GYD; this claim is ${gyd(c.amount)}`, cents: true },
    ],
    submit: ({ reason, values }) => payClaim(c.id, String(values['reference']), Number(values['amount']), reason),
    success: () => `The ${gyd(c.amount)} claim is paid.`,
  });

  // [DOC-1 §31.4 · P31-1] The reserve line every payout is drawn from: balance, floor, this month's provisioning.
  const reserveQ = useQuery({ queryKey: ['rlp-reserve'], queryFn: () => fetchRlpReserve('GY') });
  const adjust = () => void actions.run({
    title: 'Record an entry on the GY reserve line?',
    body: <p>A top-up adds to the loss-protection reserve; a negative amount corrects it downwards. Payouts are drawn from this line.</p>,
    confirmLabel: 'Record entry',
    fields: [
      { kind: 'amount', name: 'amount', label: 'Amount', hint: 'In GYD; start with a minus sign to correct downwards', cents: true, signed: true },
      { kind: 'text', name: 'note', label: 'Note', hint: 'Recorded with the entry', required: true, maxLength: 500 },
    ],
    submit: ({ reason, values }) => adjustRlpReserve('GY', Number(values['amount']), String(values['note']), reason),
    success: (_r, { values }) => `${gyd(values['amount'])} recorded on the GY reserve line.`,
  });
  const reserve: any = reserveQ.data?.data ?? null;

  const rows: any[] = data?.data ?? [];
  const m: any = metricsQ.data?.data ?? {};

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Guarantee claims</h1>
      <p className="text-[var(--muted)] text-sm mb-6">
        Failed cash handovers under the company guarantee — GPS-evidenced, guardrail-flagged. Approve, reject, or mark the payout done.
      </p>

      {actions.banner}

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

      {/* [DOC-1 §31.4] The reserve line: a claim is paid from it or not at all. */}
      <div className={`rounded-xl border p-5 mb-6 ${reserve?.low ? 'border-amber-500/60 bg-amber-500/5' : 'border-[var(--border)] bg-[var(--panel)]'}`} data-testid="rlp-reserve">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <p className="text-[var(--muted)] text-sm">Loss-protection reserve (GY)</p>
            <p className="text-2xl font-bold">{reserveQ.isLoading ? '—' : reserve ? gyd(reserve.balance) : '—'}</p>
            {reserve ? (
              <p className="text-xs text-[var(--muted)]">
                floor {gyd(reserve.floor)} · {reserve.provisionedThisPeriod ? 'provisioned this month' : 'not yet provisioned this month'}
                {reserve.low ? ' · BELOW FLOOR — payouts refuse once the line is empty' : ''}
              </p>
            ) : null}
          </div>
          <button
            onClick={adjust}
            className="ml-auto px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
          >
            Adjust reserve…
          </button>
        </div>
        {reserve?.entries?.length ? (
          <ul className="mt-3 text-xs text-[var(--muted)] space-y-1">
            {reserve.entries.slice(0, 5).map((e: any) => (
              <li key={e.id}>{new Date(e.createdAt).toLocaleString()} · {String(e.kind).toLowerCase()} · {gyd(e.amount)}{e.note ? ` · ${e.note}` : ''}</li>
            ))}
          </ul>
        ) : null}
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
        ) : claimsQ.isError ? (
          // [DS768 E4] unpaid guarantee claims never look "clear" because a read failed
          <QueryFailed error={claimsQ.error} what="the claims" onRetry={() => void claimsQ.refetch()} retrying={claimsQ.isFetching} />
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
              {/* [DOC-1 §31.4 · DOC-INV-47] The evidence bundle as filed — a payout needs every required item. */}
              {c.evidence?.items?.length ? (
                <div className="mt-3 flex flex-wrap gap-2" data-testid={`evidence-${c.id}`}>
                  {c.evidence.items.map((it: { key: string; present: boolean; required: boolean }) => (
                    <span
                      key={it.key}
                      className={`px-2 py-0.5 rounded text-xs ${it.present ? 'bg-emerald-500/15 text-emerald-300' : it.required ? 'bg-red-500/15 text-red-300' : 'bg-white/5 text-[var(--muted)]'}`}
                    >
                      {it.key.replaceAll('_', ' ')}{it.present ? ' ✓' : it.required ? ' — missing' : ' (optional)'}
                    </span>
                  ))}
                  {c.evidenceComplete ? null : (
                    <span className="text-xs text-red-300">bundle incomplete — a payout is refused until a person approves with the missing items on record</span>
                  )}
                </div>
              ) : null}
              {(c.status === 'PENDING_REVIEW' || c.status === 'AUTO_APPROVED' || c.status === 'APPROVED') && (
                <div className="flex gap-2 mt-4">
                  {c.status === 'PENDING_REVIEW' && (
                    <>
                      <button
                        onClick={() => approve(c)}
                        className="px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
                      >
                        Approve…
                      </button>
                      <button
                        onClick={() => reject(c)}
                        className="px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
                      >
                        Reject…
                      </button>
                    </>
                  )}
                  {(c.status === 'APPROVED' || c.status === 'AUTO_APPROVED') && (
                    <button
                      onClick={() => pay(c)}
                      className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
                    >
                      Mark paid…
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
