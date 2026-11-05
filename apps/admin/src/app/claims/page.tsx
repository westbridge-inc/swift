'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchClaims, approveClaim, rejectClaim, payClaim, fetchCashMetrics, fetchRlpReserve, adjustRlpReserve } from '@/lib/api';
import { StatusPill, gyd } from '@/components/detail';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { gyDateTime } from '@/lib/dates';
import { label } from '@/lib/labels';
import { useStatusFromUrl } from '@/lib/status-from-url';

const FILTERS = ['PENDING_REVIEW', 'AUTO_APPROVED', 'APPROVED', 'PAID', 'REJECTED'] as const;

/** What a flag reads as. A flag with no line here reads as its own words. */
const FLAG_WORDS: Record<string, string> = {
  protection_suspended: 'help suspended', over_gate: 'over the ID gate', sla_breached: 'past the staff deadline',
  review_overdue: 'waiting a week or more', paid_evidence_incomplete: 'paid with evidence missing',
};

/** What a missing piece of evidence reads as. */
const EVIDENCE_WORDS: Record<string, string> = {
  handover_not_completed: 'the handover record', rider_at_door: 'the rider at the door', elapsed_wait: 'the wait at the door',
  door_photo: 'the door photo', pickup_proof: 'the pickup record', cart_snapshot: 'the order contents', customer_contacted: 'contact with the customer',
};

/** The evidence as it stands now. An older row or a failed read falls back to what was stored. */
const evidenceOk = (c: any): boolean => c.evidenceNow?.complete ?? c.evidenceComplete === true;

/**
 * [Coordinator ruling, 5 Nov 2026] Case by case: failed cash handovers (no-show / refused) with GPS + photo evidence.
 * Swift MAY help, at its discretion, from company money, and a person decides each one. Nothing here is owed, and no
 * row is decided by a machine. Deterministic flags (over_cap, outlier, collusion_*) surface what needs a harder look.
 */
export default function ClaimsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('PENDING_REVIEW');
  // [ADMIN-AUDIT S2-1] Today's rows open the tab that lists them (?status=…).
  useStatusFromUrl(FILTERS, setFilter);
  const claimsQ = useQuery({ queryKey: ['claims', filter], queryFn: () => fetchClaims(filter) });
  const metricsQ = useQuery({ queryKey: ['cash-metrics'], queryFn: fetchCashMetrics });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['claims'] });
    qc.invalidateQueries({ queryKey: ['cash-metrics'] });
  };
  // [U28] Every claim decision and payout is C4: the first answer is a second
  // admin's approval, which used to print as a red "did not record" and invite
  // a second press. The panel shows the real answer; a queued row is locked.
  const actions = useActionRunner(invalidate);
  const [queuedRows, setQueuedRows] = useState<Record<string, true>>({});
  const lockIfQueued = (id: string) => (outcome: { tone: string } | null) => {
    if (outcome?.tone === 'queued') setQueuedRows((all) => ({ ...all, [id]: true }));
  };
  const approve = (c: any) => void actions.run({
    title: `Approve this ${gyd(c.amount)} payment request?`,
    body: (
      <>
        <p>Order {c.orderId}. Nobody is owed this: you are deciding that Swift helps on this order only, from company money. The rider is told so.</p>
        {evidenceOk(c) ? null : <p className="mc-text-bad mt-2">Evidence is missing. If you approve, paying it needs a written reason, and the rider is told it needs one more decision.</p>}
        {balance == null || balance >= Number(c.amount) ? null : <p className="mc-text-warn mt-2">The set-aside holds {gyd(balance)}, less than this. Company money must be recorded before it can be paid.</p>}
      </>
    ),
    confirmLabel: 'Approve request',
    submit: ({ reason }) => approveClaim(c.id, reason),
    success: () => 'Request approved.',
  }).then(lockIfQueued(c.id));
  const reject = (c: any) => void actions.run({
    title: `Reject this ${gyd(c.amount)} payment request?`,
    body: <p>Order {c.orderId}. The rider is told a person decided not to help, and reads your reason.{c.status === 'APPROVED' ? ' This closes a case that was approved and never paid.' : ''}</p>,
    confirmLabel: 'Reject request',
    submit: ({ reason }) => rejectClaim(c.id, reason),
    success: () => 'Request rejected.',
  }).then(lockIfQueued(c.id));
  // [A-11] The reference must be unique — one transfer settles one claim — and
  // the payer states what they actually sent, which the server checks against
  // the claim's own figure before anything closes. Never pre-filled.
  const pay = (c: any) => void actions.run({
    title: `Mark this ${gyd(c.amount)} payment request as paid?`,
    body: (
      <>
        <p>Order {c.orderId}. Type the reference and the amount you actually transferred.</p>
        {evidenceOk(c) ? null : <p className="mc-text-bad mt-2">Evidence is missing{c.evidenceNow?.missing?.length ? `: ${c.evidenceNow.missing.map((key: string) => EVIDENCE_WORDS[key] ?? 'other evidence').join(', ')}` : ''}. You may still pay: write why. A second admin approves your reason.</p>}
      </>
    ),
    confirmLabel: 'Mark paid',
    fields: [
      { kind: 'reference', name: 'reference', label: 'Payment reference (bank or MMG, unique to this payout)' },
      { kind: 'amount', name: 'amount', label: 'Amount you actually transferred (GYD)', cents: true },
      ...(evidenceOk(c) ? [] : [{ kind: 'text' as const, name: 'evidenceReason', label: 'Why this is paid with evidence missing', required: true, minLength: 10 }]),
    ],
    submit: ({ reason, values }) => payClaim(c.id, String(values['reference']), Number(values['amount']), reason, evidenceOk(c) ? undefined : String(values['evidenceReason'])),
    success: () => 'Payout recorded.',
  }).then(lockIfQueued(c.id));

  // [DOC-1 §31.4 · P31-1] The line every payment is drawn from: balance and the latest entries. It only holds what a
  // person records: no share of fees feeds it, and no sum has to be held (coordinator ruling, 5 Nov 2026).
  const reserveQ = useQuery({ queryKey: ['rlp-reserve'], queryFn: () => fetchRlpReserve('GY') });
  const reserveActions = useActionRunner(() => { qc.invalidateQueries({ queryKey: ['rlp-reserve'] }); });
  const adjust = () => void reserveActions.run({
    title: 'Record an entry on the GY set-aside?',
    body: <p>Record plain company money only, never a share of fees. A positive amount adds to the set-aside; a negative one corrects it downwards. A second admin approves it.</p>,
    confirmLabel: 'Record entry',
    fields: [
      { kind: 'amount', name: 'amount', label: 'Adjust the set-aside by (GYD)', signed: true },
      { kind: 'text', name: 'note', label: 'Note recorded with the entry', required: true, minLength: 3 },
    ],
    submit: ({ reason, values }) => adjustRlpReserve('GY', Number(values['amount']), String(values['note']), reason),
    success: () => 'Set-aside entry recorded.',
  });
  const reserve: any = reserveQ.data?.data ?? null;
  const balance: number | null = reserve ? Number(reserve.balance) : null;

  const rows: any[] = claimsQ.data?.data ?? [];
  const m: any = metricsQ.data?.data ?? {};

  return (
    <div className="mc-page">
      <p className="mc-muted text-sm mb-6">
        Failed cash handovers, with GPS evidence and flags. A person decides each one: Swift may help from company money, and nobody is owed it. Approve, reject, or mark the payment done.
      </p>

      {actions.banner}

      {/* Founder cockpit numbers (cash-rules founderMetrics) */}
      {metricsQ.isError ? (
        <QueryFailed error={metricsQ.error} what="the payment numbers" onRetry={() => void metricsQ.refetch()} retrying={metricsQ.isFetching} className="mb-6" />
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="mc-card">
          <p className="mc-muted text-sm">Failed-payment rate (30d)</p>
          <p className="text-3xl font-bold mt-1">
            {metricsQ.isLoading ? '—' : m.failedPaymentPct != null ? `${Number(m.failedPaymentPct).toFixed(1)}%` : '—'}
          </p>
          <p className="mc-muted text-xs mt-1">failed handovers vs completed</p>
        </div>
        <div className="mc-card">
          <p className="mc-muted text-sm">Payments (7d)</p>
          <p className="text-3xl font-bold mt-1">{metricsQ.isLoading ? '—' : gyd(m.guaranteePayoutsThisWeek?.total ?? 0)}</p>
          <p className="mc-muted text-xs mt-1">{metricsQ.isLoading ? '—' : m.guaranteePayoutsThisWeek?.count ?? 0} paid</p>
        </div>
        <div className="mc-card">
          <p className="mc-muted text-sm">Riders with payment requests (30d)</p>
          <p className="text-3xl font-bold mt-1">{metricsQ.isLoading ? '—' : Number((m.claimsByRider ?? []).length).toLocaleString()}</p>
          <p className="mc-muted text-xs mt-1">repeat filers surface first</p>
        </div>
      </div>
      )}

      {/* [DOC-1 §31.4] The reserve line: a claim is paid from it or not at all. */}
      <div className="rounded-[var(--mc-radius)] border p-5 mb-6 border-[var(--mc-line)] bg-[var(--mc-card)]" data-testid="rlp-reserve">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <p className="mc-muted text-sm">Set-aside (GY)</p>
            <p className="text-2xl font-bold">{reserveQ.isLoading ? '—' : reserve ? gyd(reserve.balance) : '—'}</p>
            <p className="mc-muted text-xs">Company money a person has recorded. A payment is recorded from it or not at all.</p>
          </div>
          <button
            type="button"
            onClick={adjust}
            className="ml-auto px-4 py-2 rounded-lg text-sm border border-[var(--mc-line)] hover:bg-[var(--mc-surface)] disabled:opacity-50"
          >
            Adjust set-aside
          </button>
        </div>
        {reserveQ.isError ? (
          <QueryFailed error={reserveQ.error} what="the set-aside" onRetry={() => void reserveQ.refetch()} retrying={reserveQ.isFetching} className="mt-3" />
        ) : null}
        <div className="mt-3">{reserveActions.banner}</div>
        {reserve?.entries?.length ? (
          <ul className="mt-3 text-xs mc-muted space-y-1">
            {reserve.entries.slice(0, 5).map((e: any) => (
              <li key={e.id}>{gyDateTime(e.createdAt)} · {String(e.kind).toLowerCase()} · {gyd(e.amount)}{e.note ? ` · ${e.note}` : ''}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex gap-1 mb-4" role="group" aria-label="Show payment requests">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className="mc-tab"
          >
            {label('ClaimStatus', f)}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {claimsQ.isLoading ? (
          <div className="mc-loading h-24" />
        ) : claimsQ.isError ? (
          <QueryFailed error={claimsQ.error} what="the payment requests" onRetry={() => void claimsQ.refetch()} retrying={claimsQ.isFetching} />
        ) : rows.length === 0 ? (
          <div className="mc-empty">
            No payment requests under “{label('ClaimStatus', filter)}”.
          </div>
        ) : (
          rows.map((c: any) => (
            <div key={c.id} className="mc-card">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xl font-bold">{gyd(c.amount)}</span>
                <StatusPill value={c.status} />
                <span className="px-2.5 py-1 rounded-full text-xs bg-[var(--mc-surface)] mc-muted">
                  {String(c.reason).replaceAll('_', ' ')}
                </span>
                {(c.flags ?? []).map((f: string) => (
                  <span key={f} className="px-2.5 py-1 rounded-full text-xs bg-[var(--mc-bad-soft)] mc-text-bad">
                    {FLAG_WORDS[f] ?? f.replaceAll('_', ' ')}
                  </span>
                ))}
                <span className="text-xs mc-muted ml-auto">{gyDateTime(c.createdAt)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-sm mc-muted">
                <Link href={`/orders/${c.orderId}`} className="text-[var(--mc-accent)] font-semibold">
                  View order →
                </Link>
                <a
                  href={`https://maps.google.com/?q=${c.gpsLat},${c.gpsLng}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-[var(--mc-accent)] transition-colors"
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
                      className={`px-2 py-0.5 rounded text-xs ${it.present ? 'bg-[var(--mc-good-soft)] mc-text-good' : it.required ? 'bg-[var(--mc-bad-soft)] mc-text-bad' : 'bg-[var(--mc-surface)] mc-muted'}`}
                    >
                      {it.key.replaceAll('_', ' ')}{it.present ? ' ✓' : it.required ? ' — missing' : ' (optional)'}
                    </span>
                  ))}
                  {evidenceOk(c) ? null : (
                    <span className="text-xs mc-text-bad">evidence incomplete — paying this needs a written reason and a second admin</span>
                  )}
                </div>
              ) : null}
              {queuedRows[c.id] ? (
                <p role="status" className="mt-3 text-xs mc-text-warn">
                  Waiting for a second admin&apos;s approval. Do not ask again: once approved, apply it from{' '}
                  <Link href="/approvals" className="underline">Approvals</Link>.
                </p>
              ) : null}
              {c.status === 'AUTO_APPROVED' ? (
                <p className="mt-3 text-xs mc-text-warn" data-testid={`old-rule-${c.id}`}>
                  Approved automatically under the old rule, and the rider was told Swift would pay. Nobody decided it, so it cannot be paid until a person does.
                </p>
              ) : null}
              {c.status === 'APPROVED' && balance != null && balance < Number(c.amount) ? (
                <p className="mt-3 text-xs mc-text-warn" data-testid={`short-line-${c.id}`}>
                  The set-aside holds {gyd(balance)}. Record company money before you send anything: a payment that cannot be recorded here is lost to the record.
                </p>
              ) : null}
              {(c.status === 'PENDING_REVIEW' || c.status === 'AUTO_APPROVED' || c.status === 'APPROVED') && (
                <div className="flex gap-2 mt-4">
                  {(c.status === 'PENDING_REVIEW' || c.status === 'AUTO_APPROVED') && (
                    <button
                      type="button"
                      onClick={() => approve(c)}
                      disabled={queuedRows[c.id] === true}
                      className="mc-btn"
                    >
                      Approve
                    </button>
                  )}
                  {/* Mark paid only when it can be recorded: on this rail the money leaves first. */}
                  {c.status === 'APPROVED' && balance != null && balance >= Number(c.amount) && (
                    <button
                      type="button"
                      onClick={() => pay(c)}
                      disabled={queuedRows[c.id] === true}
                      className="mc-btn mc-btn-primary"
                    >
                      Mark paid
                    </button>
                  )}
                  {/* No case is ever stuck: until it is paid, a person can close it. */}
                  <button
                    type="button"
                    onClick={() => reject(c)}
                    disabled={queuedRows[c.id] === true}
                    className="mc-btn"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
