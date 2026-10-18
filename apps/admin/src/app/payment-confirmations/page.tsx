'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorCode, errorDetails, errorStatus, fetchConfirmationApprovals, fetchPaymentConfirmations, requestConfirmationResolution, type PaymentConfirmation } from '@/lib/api';
import type { ApprovalRow } from '@/lib/approvals';
import { checkReason } from '@/lib/reason-rules';
import { useConfirmationRequestLocks, type ConfirmationRequestLocks } from '@/lib/confirmation-request-locks';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { MutationError } from '@/components/MutationError';

const ACTION = '/billing/confirmations/:id/resolve';
const QUEUE_KEY = ['payment-confirmations'] as const;
const APPROVALS_KEY = ['confirmation-approvals'] as const;
// Both reads decide whether a decision may be requested, so neither is ever served from the console's 30 s cache.
const FRESH = { staleTime: 0, refetchOnMount: 'always' } as const;
// The resolver resumes the clock only when no authority hold and no other active confirmation hold
// remain, and the partner may be a store or a mover: never promise more, never say "store".
const NOT_PAID_CLOCK = "The partner's billing clock resumes with its remaining grace only when no other payment check or hold is still open.";
const SOURCE: Record<string, string> = { MMG_CHECKOUT: 'MMG checkout', CARD_SESSION: 'Card session', PAYMENT: 'Payment', OBLIGATION: 'Legacy obligation', RETURN_REANCHOR: 'Return payment' };
// Why a payment is held, in words. Two reasons mean the payment is already confirmed and being settled;
// every other reason is a review code, shown as plain words (never the raw code) without guessing more.
const REASON_WORDS: Record<string, string> = {
  SETTLEMENT_APPLY_PENDING: 'Confirmed as PAID; applying the MMG credit to this fee',
  VERIFIED_POSITIVE_CORRECTION: 'MMG confirmed this payment after it was closed as not paid; applying the credit to this fee',
};
// A suspended partner's payment that could not restart their billing at the return paid the week
// that fell due as it stood (the server's re-anchor refusal): finance checks the days billed.
const RETURN_PREFIX = 'RETURN_NOT_REANCHORED_';
const RETURN_WHY: Record<string, string> = {
  CLOCK_DISAGREES: 'the server clock and the database clock disagreed',
  SUSPENSION_UNPROVEN_OR_USED: 'no unused suspension record proves the return',
  OBLIGATION_HELD: 'the fee was held for review',
  OBLIGATION_SOURCE_MISMATCH: 'the fee belongs to another fee source',
  INSTRUCTION_KEEPS_ITS_WEEK: 'the payment kept the week it was issued for',
};
const ACRONYMS = new Set(['MMG']);
const codeWords = (code: string) => code.split('_').filter(Boolean).map((word, i) => (ACRONYMS.has(word) ? word : i === 0 ? word.charAt(0) + word.slice(1).toLowerCase() : word.toLowerCase())).join(' ');
const reasonWords = (code: string) => REASON_WORDS[code] ?? (code.startsWith(RETURN_PREFIX)
  ? `A suspended partner's payment paid the week that fell due as it stood (${RETURN_WHY[code.slice(RETURN_PREFIX.length)] ?? codeWords(code.slice(RETURN_PREFIX.length)).toLowerCase()}): the days they were suspended may have been billed`
  : /^[A-Z0-9_]+$/.test(code) ? codeWords(code) : code);
const when = (date: string) => new Date(date).toLocaleString('en-GB', { timeZone: 'America/Guyana' });
const grace = (ms: number) => { const minutes = Math.max(0, Math.floor(ms / 60_000)); return `${Math.floor(minutes / 60)} h ${minutes % 60} min`; };
function activeApproval(row: PaymentConfirmation, approvals: ApprovalRow[]) {
  return approvals.find((approval) => {
    const snapshot = approval.bodySnapshot as { params?: { id?: string } } | null;
    return approval.action.endsWith(ACTION) && (snapshot?.params?.id ?? approval.entityId) === row.id
      && ['PENDING', 'APPROVED'].includes(approval.status) && new Date(approval.expiresAt).getTime() > Date.now();
  });
}

export default function PaymentConfirmationsPage() {
  const queue = useQuery({ queryKey: QUEUE_KEY, queryFn: fetchPaymentConfirmations, ...FRESH });
  const approvals = useQuery({ queryKey: APPROVALS_KEY, queryFn: fetchConfirmationApprovals, ...FRESH });
  const { store: locks, locks: lockByRow } = useConfirmationRequestLocks();
  const [selection, setSelection] = useState<{ row: PaymentConfirmation; decision: 'PAID' | 'UNPAID' } | null>(null);
  const [queued, setQueued] = useState<Record<string, string>>({});
  const sending = Object.values(lockByRow).some((lock) => lock.state === 'sending');
  const rows = [...(queue.data?.data ?? [])].sort((a, b) => Number(b.overdue) - Number(a.overdue) || Date.parse(a.reviewDueAt) - Date.parse(b.reviewDueAt) || a.id.localeCompare(b.id));
  const ready = !sending && !queue.isFetching && !approvals.isFetching && !queue.isError && !approvals.isError && !!approvals.data;
  const reload = async () => {
    setSelection(null);
    const mark = locks.mark();
    const [queueResult, approvalResult] = await Promise.all([queue.refetch(), approvals.refetch()]);
    if (!queueResult.isError && !approvalResult.isError) { setQueued({}); locks.reloaded(mark); }
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-bold">Payment confirmations</h1>
          <p className="text-sm text-[var(--muted)] mt-1">Weekly-fee payments waiting for review. The billing clock is paused; the remaining grace is preserved.</p></div>
        <button type="button" className="px-4 py-2 border border-[var(--border)] rounded-lg text-sm" onClick={() => void reload()} disabled={sending || queue.isFetching || approvals.isFetching}>Reload confirmations</button>
      </div>
      <p className="text-sm text-[var(--muted)]">Every resolution is approved on Approvals before it applies: by a second admin, or, while the owner is the only admin who can approve it, by the owner after a waiting period (solo approval). Review the payment evidence, request a decision, then complete it on Approvals once it is approved.</p>
      {queue.isPending && <p role="status">Loading payment confirmations…</p>}
      {queue.isError && <QueryFailed error={queue.error} what="payment confirmations" />}
      {approvals.isError && <QueryFailed error={approvals.error} what="existing approvals" />}
      {!queue.isPending && !queue.isError && !rows.length && <p>No payment confirmations need review.</p>}
      {!queue.isError && rows.length > 0 && <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <table aria-label="Payment confirmations" className="w-full text-sm text-left">
          <thead className="text-xs text-[var(--muted)]"><tr>{['Payment / partner', 'Review', 'Remaining grace', 'Action'].map((title) => <th key={title} scope="col" className="p-4">{title}</th>)}</tr></thead>
          <tbody className="divide-y divide-[var(--border)]">{rows.map((row) => {
            const approval = activeApproval(row, approvals.data ?? []);
            const waiting = queued[row.id] || approval;
            const reference = row.swiftReference ?? row.sourceId ?? row.id;
            const lock = lockByRow[row.id];
            // MMG already reports a credited transaction for this checkout: closing it as NOT PAID would be wrong.
            const credited = (row.settlementPayments ?? []).length > 0;
            return <tr key={row.id}>
              <td className="p-4"><p className="font-medium">{SOURCE[row.source] ?? row.source}</p><p className="font-mono break-all">{reference}</p><p className="text-[var(--muted)]">{row.partner ?? 'Partner unavailable'}</p>
                {row.source === 'MMG_CHECKOUT' && row.sourceId && <Link className="underline text-[var(--accent)]" href={`/mmg-payments?checkout=${encodeURIComponent(row.sourceId)}`}>MMG timeline</Link>}</td>
              <td className="p-4"><p className={row.overdue ? 'text-amber-400 font-semibold' : ''}>{row.overdue ? 'Overdue for review' : 'Review due'} · {when(row.reviewDueAt)}</p><p className="text-[var(--muted)]">Began {when(row.beganAt)}</p><p>{reasonWords(row.reason)}</p></td>
              <td className="p-4 whitespace-nowrap">{grace(row.remainingGraceMs)}</td>
              <td className="p-4">{row.source === 'RETURN_REANCHOR' ? <p>Read-only. Compare the days billed with the time this partner was suspended, and correct any difference through the existing billing workflow.</p> : !row.resolvable || !row.sourceId ? <p>Read-only. Review through the existing obligation workflow.</p> : waiting ? <div role="status">
                <p>{approval?.status === 'APPROVED' ? 'Approved; waiting for the requester to apply it on Approvals.' : 'Waiting for approval: a second admin, or solo approval on Approvals. Nothing has changed yet.'}</p>
                <Link className="underline text-[var(--accent)]" href="/approvals">Open Approvals</Link>
              </div> : row.status === 'SETTLEMENT_APPLY_PENDING' ? <p role="status">This payment is confirmed as PAID and its MMG credit is being applied to this fee. Nothing to request.</p> : <div className="flex flex-wrap gap-2">
                {lock?.state === 'sending' && <p>A request for this payment is still being sent. Wait for the answer.</p>}
                {lock?.state === 'reload' && <p>Reload confirmations before another request.</p>}
                {credited && <p id={`credited-${row.id}`}>MMG shows a credited payment for this checkout — reconcile it as PAID instead.</p>}
                <button type="button" disabled={!ready || !!lock || credited} aria-describedby={credited ? `credited-${row.id}` : undefined} aria-label={`Close as NOT PAID ${reference}`} onClick={() => setSelection({ row, decision: 'UNPAID' })} className="px-3 py-2 border border-[var(--border)] rounded-lg disabled:opacity-40">Close as NOT PAID</button>
                <button type="button" disabled={!ready || !!lock} aria-label={`Mark PAID ${reference}`} onClick={() => setSelection({ row, decision: 'PAID' })} className="px-3 py-2 border border-[var(--border)] rounded-lg disabled:opacity-40">Mark PAID</button>
              </div>}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
      {selection && <ResolveForm key={`${selection.row.id}:${selection.decision}`} {...selection} locks={locks} onCancel={() => setSelection(null)} onQueued={(id) => { setQueued((old) => ({ ...old, [selection.row.id]: id })); setSelection(null); }} />}
    </div>
  );
}

function ResolveForm({ row, decision, locks, onCancel, onQueued }: { row: PaymentConfirmation; decision: 'PAID' | 'UNPAID'; locks: ConfirmationRequestLocks; onCancel: () => void; onQueued: (_id: string) => void }) {
  const queryClient = useQueryClient();
  const [evidence, setEvidence] = useState('');
  const [reason, setReason] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mmg = row.source === 'MMG_CHECKOUT';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current || stale) return;
    const checked = checkReason(reason);
    if (!/^[A-Za-z0-9._:/-]{8,128}$/.test(evidence)) { setProblem('Evidence reference must be 8–128 characters: letters, numbers, dot, underscore, colon, slash or hyphen.'); return; }
    if (!checked.ok) { setProblem(checked.message); return; }
    if (decision === 'PAID' && mmg && !row.settlementPayments?.some((p) => p.providerPaymentId === paymentId)) { setProblem('Select a recorded MMG transaction. If none is available, complete the existing settlement workflow first.'); return; }
    if (!row.sourceId) return;
    inFlight.current = true; setBusy(true); setProblem(null); setError(null);
    // Held outside this page: leaving it while the request is unanswered must not unlock the row.
    locks.sending(row.id);
    let answer: 'queued' | 'refused' | 'uncertain' = 'uncertain';
    try {
      await requestConfirmationResolution(row.id, { sourceId: row.sourceId, epoch: row.epoch, clockVersion: row.clockVersion, decision,
        ...(decision === 'PAID' && mmg ? { providerPaymentId: paymentId } : {}), evidenceReference: evidence, reason: checked.reason });
      setStale(true);
      setError(new Error('The server did not confirm a queued approval. Reload confirmations and check Approvals before sending again.'));
    } catch (err) {
      const approvalId = errorDetails(err)?.['approvalId'];
      if (errorCode(err) === 'APPROVAL_REQUIRED' && typeof approvalId === 'string' && approvalId.length > 0) { answer = 'queued'; onQueued(approvalId); return; }
      // The approval gate answers every request it accepts with 202 before the resolver runs, so a 4xx here is a refusal
      // from an earlier gate (session, permission, reason) and nothing was queued. No answer, a 5xx or a 202 without an
      // approval id may have queued one.
      if (errorCode(err) === 'APPROVAL_REQUIRED' || !errorStatus(err) || errorStatus(err)! >= 500) setStale(true);
      else answer = 'refused';
      setError(err);
    } finally {
      // Both lists are read again after every answer, and those reads start before the row unlocks.
      void queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
      void queryClient.invalidateQueries({ queryKey: APPROVALS_KEY });
      if (answer === 'uncertain') locks.reloadRequired(row.id); else locks.release(row.id);
      inFlight.current = false; setBusy(false);
    }
  };
  const inputClass = 'w-full mt-1 p-2 rounded-lg border border-[var(--border)] bg-[var(--bg)]';
  return <form aria-label="Resolve payment confirmation" onSubmit={submit} noValidate className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5 space-y-4">
    <h2 className="font-semibold">{decision === 'UNPAID' ? 'Close as NOT PAID' : 'Mark PAID'} · {row.swiftReference ?? row.sourceId}</h2>
    <p>{decision === 'UNPAID'
      ? `Close as NOT PAID: ${mmg ? 'the checkout becomes NOT_PAID' : 'the payment becomes failed'}; nothing is credited. ${NOT_PAID_CLOCK}`
      : mmg ? "Mark PAID: only with MMG's transaction id; credits once" : 'Mark PAID: only with recorded settlement evidence; credits once.'}</p>
    {decision === 'PAID' && <p className="text-sm text-[var(--muted)]">Swift rechecks the existing settlement record before applying the decision. Entering a reference cannot create credit or credit a payment twice.</p>}
    {decision === 'PAID' && mmg && <label className="block text-sm">MMG transaction ID<select className={inputClass} value={paymentId} onChange={(e) => setPaymentId(e.target.value)} disabled={busy || stale}>
      <option value="">Select a recorded MMG transaction</option>{row.settlementPayments?.map((payment) => <option key={payment.providerPaymentId} value={payment.providerPaymentId}>{payment.mmgTransactionId}</option>)}
    </select></label>}
    <label className="block text-sm">Evidence reference<input className={inputClass} value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={128} disabled={busy || stale} /></label>
    <label className="block text-sm">Reason<textarea className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} disabled={busy || stale} /></label>
    <p className="text-sm text-[var(--muted)]">State what you checked. Whoever approves it will review this reason and the exact decision.</p>
    {problem && <p role="alert" className="text-amber-400">{problem}</p>}
    {error != null && <MutationError error={error} label="The resolution was not confirmed" />}
    {stale && <p>Reload confirmations and review the current evidence before requesting another decision.</p>}
    <div className="flex flex-wrap gap-3"><button disabled={busy || stale} className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg disabled:opacity-40">{busy ? 'Requesting…' : 'Request approval'}</button>
      <button type="button" disabled={busy} onClick={onCancel} className="px-4 py-2 border border-[var(--border)] rounded-lg">Close</button></div>
  </form>;
}
