'use client';

import { Fragment, useState, useRef } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchSubscriptions, waiveSubscriptionFee, topUpSubscription, setAsideSubscriptionCredit, recordSubscriptionRefundPaid, releaseSubscriptionRefund, fetchBillingEvents } from '@/lib/api';
import { outcomeOfThrown, type MoneyActionOutcome } from '@/lib/cashRail';
import { StatusPill, gyd } from '@/components/detail';
import { label } from '@/lib/labels';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { billDateLabel } from '@/lib/bill-date';

const FILTERS = ['ALL', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const;

/** Who this subscription belongs to + where their page is. */
function holder(s: any): { name: string; kind: string; href?: string } {
  if (s.vendor) return { name: s.vendor.name, kind: 'vendor', href: `/vendors/${s.vendor.id}` };
  if (s.rider?.user)
    return { name: [s.rider.user.firstName, s.rider.user.lastName].filter(Boolean).join(' '), kind: 'rider', href: `/riders/${s.rider.id}` };
  if (s.driver?.user)
    return { name: [s.driver.user.firstName, s.driver.user.lastName].filter(Boolean).join(' '), kind: 'driver', href: `/drivers/${s.driver.id}` };
  return { name: '—', kind: String(s.type ?? '').toLowerCase() };
}

function BillingEvents({ id }: { id: string }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['billing-events', id], queryFn: () => fetchBillingEvents(id) });
  const events: any[] = data?.data ?? [];
  if (isLoading) return <p className="text-xs mc-muted p-3">Loading billing trail…</p>;
  if (isError) return <QueryFailed error={error} what="the billing trail" onRetry={() => void refetch()} retrying={isFetching} className="m-3" />;
  if (events.length === 0) return <p className="text-xs mc-muted p-3">No billing events.</p>;
  return (
    <div className="p-3 space-y-1.5">
      {events.map((e: any) => (
        <div key={e.id} className="flex items-center gap-3 text-xs">
          <span className="mc-muted w-36 shrink-0">{new Date(e.createdAt).toLocaleString()}</span>
          <span>{e.type ? label('BillingEventType', e.type) : String(e.kind ?? '').replaceAll('_', ' ').toLowerCase()}</span>
          {e.amount != null && <span className="ml-auto font-medium">{gyd(e.amount)}</span>}
        </div>
      ))}
    </div>
  );
}

const DONE_COPY = {
  'set-aside': 'Set aside. Pay it now outside Swift, then record the payout here.',
  paid: 'Payout recorded. The refund is complete.',
  release: 'Returned to the credit. Nothing is set aside.',
} as const;
const QUEUED_COPY = {
  'set-aside': 'Do not pay anything yet. Once a second admin approves, apply it from the approvals queue; the credit is then set aside and you pay it.',
  paid: 'Payment reported. A second admin must approve its record in the approvals queue. Do not pay again or release this refund.',
  release: 'Once a second admin approves, apply it from the approvals queue to return the money to the credit.',
} as const;

/** What happened to the last refund step on this row: done, queued for a
 *  second admin (with the approval id), or refused with the server's words. */
function RefundOutcome({ outcome }: { outcome: MoneyActionOutcome }) {
  if (outcome.kind === 'error') return <p role="alert" className="text-xs mc-text-bad mt-2">{outcome.message}</p>;
  return (
    <p role="status" className={`text-xs mt-2 ${outcome.kind === 'queued' ? 'mc-text-warn' : 'mc-muted'}`}>
      {outcome.message}
      {outcome.approvalId && (
        <>
          {' '}Approval {outcome.approvalId}.{' '}
          <Link href="/approvals" className="underline">Open the approvals queue</Link>
        </>
      )}
    </p>
  );
}

export default function SubscriptionsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const [openTrail, setOpenTrail] = useState<string | null>(null);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['subscriptions', filter],
    queryFn: () => fetchSubscriptions(filter === 'ALL' ? 'limit=50' : `limit=50&status=${filter}`),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['subscriptions'] });
  // [A-12] The reason used to be the constant 'Waived by admin' — a field that
  // was always filled and never said anything. This is Swift's own revenue
  // being given away; the operator says why, in their own words, and that is
  // what is stored.
  const waive = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => waiveSubscriptionFee(id, reason),
    onSuccess: invalidate,
  });
  // [U06] Waiving and recording a fee payment are C4: the first answer is a
  // second admin's approval. Both used to show nothing (a refusal was
  // swallowed, a queued ask looked like a dead button) and invited a second
  // press. The panel shows the answer; once queued, that row's button is locked.
  const actions = useActionRunner(invalidate);
  const dialog = useActionDialog();
  const [queuedAsks, setQueuedAsks] = useState<Record<string, true>>({});
  const lockIfQueued = (key: string) => (outcome: { tone: string } | null) => {
    if (outcome?.tone === 'queued') setQueuedAsks((all) => ({ ...all, [key]: true }));
  };
  // [M-08] The idempotency key belongs to the ATTEMPT: minted when the admin
  // confirms an amount, reused if that same top-up is retried after an error
  // or a lost response, and released only once the server has answered. A
  // different amount for the same subscription is a new attempt.
  const attempts = useRef(new Map<string, string>());
  const topup = useMutation({
    // [A-12] The transfer's reference is part of the attempt, not an optional
    // note: a different transfer is a different top-up even for the same
    // subscription and the same amount.
    mutationFn: async ({ id, amount, reference, reason }: { id: string; amount: number; reference: string; reason: string }) => {
      const attempt = `${id}:${amount}:${reference}`;
      const key = attempts.current.get(attempt) ?? crypto.randomUUID();
      attempts.current.set(attempt, key);
      const res = await topUpSubscription(id, amount, reference, key, reason);
      attempts.current.delete(attempt);
      return res;
    },
    onSuccess: invalidate,
  });

  // [Owner ruling 2026-10-07] Refund the whole unused credit, in order: SET IT
  // ASIDE (a second admin approves; nothing is paid before it is set aside),
  // PAY it outside Swift, then RECORD THE PAYOUT with its reference (a second
  // admin approves). RELEASE returns a set-aside that could not be paid.
  // Every answer is shown: a money action answers 202 APPROVAL_REQUIRED, which
  // apiFetch throws, so "queued" is read on the error path, never hidden.
  const [refundOutcome, setRefundOutcome] = useState<Record<string, MoneyActionOutcome>>({});
  const [reportedRefunds, setReportedRefunds] = useState<Record<string, boolean>>({});
  const told = (id: string, outcome: MoneyActionOutcome) => setRefundOutcome((all) => ({ ...all, [id]: outcome }));
  const refundStep = (step: 'set-aside' | 'paid' | 'release') => ({
    onSuccess: (res: unknown, v: { id: string }) => {
      const answer = res as { replayed?: boolean; data?: { refundSetAside?: number } };
      const message = step === 'paid' && Number(answer.data?.refundSetAside ?? 0) > 0
        ? answer.replayed
          ? 'The earlier payout was already recorded. Credit is still set aside for another refund.'
          : 'Payout recorded. Credit is still set aside for another refund.'
        : DONE_COPY[step];
      told(v.id, { kind: 'done', message });
      invalidate();
    },
    onError: (e: unknown, v: { id: string; setAsideId?: string }) => {
      const outcome = outcomeOfThrown(e);
      // [DS1122 S3] Remembered per set-aside: a later set-aside starts clean.
      if (outcome.kind === 'queued' && step === 'paid' && v.setAsideId) setReportedRefunds((all) => ({ ...all, [v.setAsideId!]: true }));
      told(v.id, outcome.kind === 'queued' ? {
        ...outcome, message: step === 'paid' ? QUEUED_COPY.paid : `${outcome.message} ${QUEUED_COPY[step]}`,
      } : outcome);
    },
  });
  const setAside = useMutation({
    mutationFn: ({ id, amount, reason }: { id: string; amount: number; reason: string }) => setAsideSubscriptionCredit(id, amount, reason),
    ...refundStep('set-aside'),
  });
  const recordPaid = useMutation({
    mutationFn: ({ id, amount, method, reference, setAsideId, reason }: { id: string; amount: number; method: 'MMG' | 'BANK_TRANSFER'; reference: string; setAsideId: string; reason: string }) =>
      recordSubscriptionRefundPaid(id, amount, method, reference, setAsideId, reason),
    ...refundStep('paid'),
  });
  const release = useMutation({
    mutationFn: ({ id, amount, setAsideId, reason }: { id: string; amount: number; setAsideId: string; reason: string }) => releaseSubscriptionRefund(id, amount, setAsideId, reason),
    ...refundStep('release'),
  });
  const refundBusy = setAside.isPending || recordPaid.isPending || release.isPending;

  const rows: any[] = data?.data ?? [];
  // [OWNER 8 Oct (4)] Partners pay the weekly fee only through the MMG checkout
  // page; production holds recording a payment by hand (BILLING_TOPUP_HOLD),
  // so the button is not offered while the server says the hold is on.
  const recordingHeld = (data as any)?.manualFeeRecording === 'held';

  return (
    <div className="mc-page">
      <div className="flex items-center justify-between mb-1">
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className="mc-tab"
            >
              {f === 'ALL' ? 'All' : f.replaceAll('_', ' ').toLowerCase()}
            </button>
          ))}
        </div>
      </div>
      <p className="mc-muted text-sm mb-6">
        The weekly flat fee is Swift&apos;s only revenue — this queue is the business.
      </p>
      {recordingHeld ? (
        <p className="mc-muted text-xs -mt-4 mb-6">
          Recording fee payments by hand is on hold: partners pay through the MMG checkout page. A payment that arrived another way is refunded.
        </p>
      ) : null}
      {actions.banner}

      <div className="mc-table-wrap">
        <table className="mc-table mc-table-auto">
          <thead>
            <tr >
              <th className="mc-label text-left">Holder</th>
              <th className="mc-label text-left">Status</th>
              <th className="mc-label text-right">Weekly</th>
              <th className="mc-label text-left">Next bill / trial end</th>
              <th className="mc-label text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={5} className="mc-table-empty">Loading…</td></tr>
            ) : isError ? (
              <tr><td colSpan={5} className="p-4">
                <QueryFailed error={error} what="the subscriptions" onRetry={() => void refetch()} retrying={isFetching} />
              </td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={5} className="mc-table-empty">No subscriptions match.</td></tr>
            ) : (
              rows.map((s: any) => {
                const h = holder(s);
                const when = s.isTrialActive && s.trialEndDate ? `trial → ${new Date(s.trialEndDate).toLocaleDateString()}` : s.nextBillingDate ? (billDateLabel(s.nextBillingDate) === 'Due since' ? `due since ${new Date(s.nextBillingDate).toLocaleDateString()}` : new Date(s.nextBillingDate).toLocaleDateString()) : '—';
                const payoutReported = (s.refundSetAsideId ? reportedRefunds[s.refundSetAsideId] === true : false) || s.refundPayoutReported === true;
                // [Review S2-1] Every payout record for this set-aside was refused, expired or failed:
                // record it again; the release stays refused (a payout may have been sent, Q-1527).
                const payoutNotCompleted = !payoutReported && s.refundPayoutAsk === 'NOT_COMPLETED';
                return (
                  <Fragment key={s.id}>
                    <tr >
                      <td className="p-4">
                        {h.href ? (
                          <Link href={h.href} className="font-medium text-[var(--mc-accent)] font-semibold">
                            {h.name}
                          </Link>
                        ) : (
                          <span className="font-medium">{h.name}</span>
                        )}
                        <span className="text-xs mc-muted ml-2">{h.kind}</span>
                      </td>
                      <td className="p-4">
                        <StatusPill value={s.status} />
                        {s.feeWaived ? <span className="ml-2 text-xs mc-text-info">fee waived</span> : null}
                      </td>
                      <td className="p-4 text-right">{gyd(s.customRate ?? s.weeklyRate)}</td>
                      <td className="p-4 mc-muted">{when}</td>
                      <td className="p-4 text-right">
                        <div className="flex gap-2 justify-end">
                          <button
                            type="button"
                            onClick={() => setOpenTrail(openTrail === s.id ? null : s.id)}
                            className="px-3 py-1 rounded-lg text-xs border border-[var(--mc-line)] hover:bg-[var(--mc-surface)]"
                          >
                            {openTrail === s.id ? 'Hide trail' : 'Billing trail'}
                          </button>
                          {!recordingHeld && <button
                            type="button"
                            onClick={() => void actions.run({
                              // The clause asks for a confirmation naming the TARGET and the DELTA: the panel
                              // names the holder, and the amount and transfer are what the operator types.
                              title: `Record a weekly-fee payment for ${h.name}?`,
                              body: <p>Only for money that arrived by cash or bank transfer. The reference is the proof, and one transfer credits one account. A second admin approves it.</p>,
                              confirmLabel: 'Record payment',
                              fields: [
                                { kind: 'amount', name: 'amount', label: 'Amount received (GYD)' },
                                { kind: 'reference', name: 'reference', label: 'Bank or MMG reference of the transfer' },
                              ],
                              submit: ({ reason, values }) => topup.mutateAsync({ id: s.id, amount: Number(values['amount']), reference: String(values['reference']), reason }),
                              success: () => `Payment recorded for ${h.name}.`,
                            }).then(lockIfQueued(`${s.id}:fee-payment`))}
                            disabled={topup.isPending || queuedAsks[`${s.id}:fee-payment`] === true}
                            className="mc-btn"
                          >
                            {queuedAsks[`${s.id}:fee-payment`] ? 'Payment waiting for approval' : 'Record fee payment'}
                          </button>}
                          {Number(s.refundSetAside ?? 0) > 0 ? (
                            <>
                              <button
                                type="button"
                                onClick={async () => {
                                  const owed = Number(s.refundSetAside);
                                  const answer = await dialog.askWith({
                                    title: `Record that GY$${owed.toLocaleString()} was paid back to ${h.name}?`,
                                    body: <p>Only once the refund has really been paid outside Swift. The reference is the proof the money went back. A second admin approves the record.</p>,
                                    confirmLabel: 'Record payout',
                                    fields: [
                                      { kind: 'choice', name: 'method', label: 'Paid back by', options: [{ value: 'MMG', label: 'MMG' }, { value: 'BANK_TRANSFER', label: 'Bank transfer' }] },
                                      { kind: 'reference', name: 'reference', label: 'Reference of the refund you paid' },
                                    ],
                                  });
                                  if (!answer) return;
                                  const method = answer.values['method'] === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'MMG';
                                  recordPaid.mutate({ id: s.id, amount: owed, method, reference: String(answer.values['reference']), setAsideId: String(s.refundSetAsideId ?? ''), reason: answer.reason });
                                }}
                                disabled={refundBusy || payoutReported}
                                className="mc-btn"
                              >
                                Record payout
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  const owed = Number(s.refundSetAside);
                                  const answer = await dialog.askWith({
                                    title: `Return the GY$${owed.toLocaleString()} set aside for ${h.name} to their credit?`,
                                    body: <p>Only if the refund could not be paid. A second admin approves it.</p>,
                                    confirmLabel: 'Return to credit',
                                  });
                                  if (answer) release.mutate({ id: s.id, amount: owed, setAsideId: String(s.refundSetAsideId ?? ''), reason: answer.reason });
                                }}
                                disabled={refundBusy || payoutReported || payoutNotCompleted}
                                className="mc-btn"
                              >
                                Release
                              </button>
                            </>
                          ) : Number(s.prepaidBalance?.balance ?? 0) > 0 && (
                            <button
                              type="button"
                              onClick={async () => {
                                const credit = Number(s.prepaidBalance.balance);
                                const answer = await dialog.askWith({
                                  title: `Set aside ${h.name}'s unused credit of GY$${credit.toLocaleString()} for a refund?`,
                                  body: <p>A second admin approves it. Do not pay anything yet: pay only once it shows as set aside, then record the payout here.</p>,
                                  confirmLabel: 'Set aside for refund',
                                });
                                if (answer) setAside.mutate({ id: s.id, amount: credit, reason: answer.reason });
                              }}
                              disabled={refundBusy}
                              className="mc-btn"
                            >
                              Refund credit
                            </button>
                          )}
                          {!s.feeWaived && (
                            <button
                              type="button"
                              onClick={() => void actions.run({
                                title: `Waive this period's fee for ${h.name}?`,
                                body: <p>This is revenue Swift is giving up. A second admin approves it.</p>,
                                confirmLabel: 'Waive fee',
                                reason: { label: 'Why it is waived', hint: 'Kept on the record and read by the second admin.' },
                                submit: ({ reason }) => waive.mutateAsync({ id: s.id, reason }),
                                success: () => `Fee waived for ${h.name} for this period.`,
                              }).then(lockIfQueued(`${s.id}:waive`))}
                              disabled={waive.isPending || queuedAsks[`${s.id}:waive`] === true}
                              className="mc-btn"
                            >
                              {queuedAsks[`${s.id}:waive`] ? 'Waiver waiting for approval' : 'Waive fee'}
                            </button>
                          )}
                        </div>
                        {Number(s.refundSetAside ?? 0) > 0 && (
                          <p className="text-xs mc-text-warn mt-2">{payoutReported
                            ? 'Payment reported; recording awaits approval. Do not pay again or release this refund.'
                            : payoutNotCompleted
                              ? 'The last payout record was not completed (refused, expired or failed). Do not pay again: record it again with the correct reference. This refund cannot be released.'
                            : `GY$${Number(s.refundSetAside).toLocaleString()} set aside: pay it outside Swift, then record the payout.`}</p>
                        )}
                        {refundOutcome[s.id] && <RefundOutcome outcome={refundOutcome[s.id]!} />}
                      </td>
                    </tr>
                    {openTrail === s.id && (
                      <tr className="border-b border-[var(--mc-line)] bg-[var(--mc-surface)]">
                        <td colSpan={5}>
                          <BillingEvents id={s.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
