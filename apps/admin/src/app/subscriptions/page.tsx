'use client';

import { Fragment, useState, useRef } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchSubscriptions, waiveSubscriptionFee, topUpSubscription, setAsideSubscriptionCredit, recordSubscriptionRefundPaid, releaseSubscriptionRefund, fetchBillingEvents } from '@/lib/api';
import { outcomeOfThrown, type MoneyActionOutcome } from '@/lib/cashRail';
import { StatusPill, gyd } from '@/components/detail';
import { askReason, reasonTooShort } from '@/lib/ask-reason';

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
  const { data, isLoading } = useQuery({ queryKey: ['billing-events', id], queryFn: () => fetchBillingEvents(id) });
  const events: any[] = data?.data ?? [];
  if (isLoading) return <p className="text-xs text-[var(--muted)] p-3">Loading billing trail…</p>;
  if (events.length === 0) return <p className="text-xs text-[var(--muted)] p-3">No billing events.</p>;
  return (
    <div className="p-3 space-y-1.5">
      {events.map((e: any) => (
        <div key={e.id} className="flex items-center gap-3 text-xs">
          <span className="text-[var(--muted)] w-36 shrink-0">{new Date(e.createdAt).toLocaleString()}</span>
          <span>{String(e.type ?? e.kind ?? '').replaceAll('_', ' ').toLowerCase()}</span>
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
  if (outcome.kind === 'error') return <p role="alert" className="text-xs text-red-500 mt-2">{outcome.message}</p>;
  return (
    <p role="status" className={`text-xs mt-2 ${outcome.kind === 'queued' ? 'text-amber-500' : 'text-[var(--muted)]'}`}>
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
  const { data, isLoading } = useQuery({
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
    onError: (e: unknown, v: { id: string }) => {
      const outcome = outcomeOfThrown(e);
      if (outcome.kind === 'queued' && step === 'paid') setReportedRefunds((all) => ({ ...all, [v.id]: true }));
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
    mutationFn: ({ id, amount, method, reference, reason }: { id: string; amount: number; method: 'MMG' | 'BANK_TRANSFER'; reference: string; reason: string }) =>
      recordSubscriptionRefundPaid(id, amount, method, reference, reason),
    ...refundStep('paid'),
  });
  const release = useMutation({
    mutationFn: ({ id, amount, reason }: { id: string; amount: number; reason: string }) => releaseSubscriptionRefund(id, amount, reason),
    ...refundStep('release'),
  });
  const refundBusy = setAside.isPending || recordPaid.isPending || release.isPending;

  const rows: any[] = data?.data ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">Subscriptions</h1>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 rounded-lg text-xs ${
                filter === f ? 'bg-white text-black font-semibold' : 'bg-white/5 text-[var(--muted)] hover:bg-white/10'
              }`}
            >
              {f === 'ALL' ? 'All' : f.replaceAll('_', ' ').toLowerCase()}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[var(--muted)] text-sm mb-6">
        The weekly flat fee is Swift&apos;s only revenue — this queue is the business.
      </p>

      <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left p-4 text-[var(--muted)] font-medium">Holder</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Status</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Weekly</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Next bill / trial end</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={5} className="p-8 text-center text-[var(--muted)]">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={5} className="p-8 text-center text-[var(--muted)]">No subscriptions match.</td></tr>
            ) : (
              rows.map((s: any) => {
                const h = holder(s);
                const when = s.isTrialActive && s.trialEndDate ? `trial → ${new Date(s.trialEndDate).toLocaleDateString()}` : s.nextBillingDate ? new Date(s.nextBillingDate).toLocaleDateString() : '—';
                const payoutReported = reportedRefunds[s.id] || s.refundPayoutReported === true;
                return (
                  <Fragment key={s.id}>
                    <tr className="border-b border-[var(--border)] hover:bg-white/5">
                      <td className="p-4">
                        {h.href ? (
                          <Link href={h.href} className="font-medium hover:text-[var(--accent)] transition-colors">
                            {h.name}
                          </Link>
                        ) : (
                          <span className="font-medium">{h.name}</span>
                        )}
                        <span className="text-xs text-[var(--muted)] ml-2">{h.kind}</span>
                      </td>
                      <td className="p-4">
                        <StatusPill value={s.status} />
                        {s.feeWaived ? <span className="ml-2 text-xs text-sky-400">fee waived</span> : null}
                      </td>
                      <td className="p-4 text-right">{gyd(s.customRate ?? s.weeklyRate)}</td>
                      <td className="p-4 text-[var(--muted)]">{when}</td>
                      <td className="p-4 text-right">
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => setOpenTrail(openTrail === s.id ? null : s.id)}
                            className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] hover:bg-white/10"
                          >
                            {openTrail === s.id ? 'Hide trail' : 'Billing trail'}
                          </button>
                          <button
                            onClick={() => {
                              const amt = window.prompt(`Record a cash/bank top-up for ${h.name} (whole GYD):`);
                              const n = Number(amt);
                              if (!amt || !Number.isInteger(n) || n <= 0) return;
                              const reference = window.prompt(
                                'Bank or MMG reference for the transfer that arrived (this is the proof, and one transfer credits one account):',
                              );
                              if (!reference) return;
                              // The clause asks for a confirmation naming the TARGET and the DELTA.
                              if (!window.confirm(`Credit ${h.name} with GY$${n.toLocaleString()} against transfer ${reference}?`)) return;
                              const reason = askReason({ action: 'record this top-up', subject: `${h.name} (${reference})` });
                              if (reason) topup.mutate({ id: s.id, amount: n, reference, reason });
                            }}
                            disabled={topup.isPending}
                            className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
                          >
                            Top up
                          </button>
                          {Number(s.refundSetAside ?? 0) > 0 ? (
                            <>
                              <button
                                onClick={() => {
                                  const owed = Number(s.refundSetAside);
                                  const how = window.prompt(`GY$${owed.toLocaleString()} is set aside to refund ${h.name}. Paid back by MMG or BANK?`, 'MMG');
                                  const method = how?.trim().toUpperCase() === 'BANK' ? 'BANK_TRANSFER' : how?.trim().toUpperCase() === 'MMG' ? 'MMG' : null;
                                  if (!method) return;
                                  const reference = window.prompt('Reference of the refund you paid (MMG or bank). It is the proof the money went back:');
                                  if (!reference) return;
                                  if (!window.confirm(`Record that GY$${owed.toLocaleString()} was paid back to ${h.name} by ${method === 'MMG' ? 'MMG' : 'bank transfer'} (${reference})? A second admin approves it.`)) return;
                                  const reason = askReason({ action: 'record this refund payout', subject: `${h.name} (${reference})` });
                                  if (reason) recordPaid.mutate({ id: s.id, amount: owed, method, reference, reason });
                                }}
                                disabled={refundBusy || payoutReported}
                                className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
                              >
                                Record payout
                              </button>
                              <button
                                onClick={() => {
                                  const owed = Number(s.refundSetAside);
                                  if (!window.confirm(`Return the GY$${owed.toLocaleString()} set aside for ${h.name} to their credit? Only if the refund could not be paid.`)) return;
                                  const reason = askReason({ action: 'return this refund set-aside to credit', subject: h.name });
                                  if (reason) release.mutate({ id: s.id, amount: owed, reason });
                                }}
                                disabled={refundBusy || payoutReported}
                                className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
                              >
                                Release
                              </button>
                            </>
                          ) : Number(s.prepaidBalance?.balance ?? 0) > 0 && (
                            <button
                              onClick={() => {
                                const credit = Number(s.prepaidBalance.balance);
                                if (!window.confirm(`Set aside ${h.name}'s unused credit of GY$${credit.toLocaleString()} for a refund? A second admin approves it. Do not pay anything yet: pay only once it shows as set aside, then record the payout here.`)) return;
                                const reason = askReason({ action: 'set this credit aside for a refund', subject: h.name });
                                if (reason) setAside.mutate({ id: s.id, amount: credit, reason });
                              }}
                              disabled={refundBusy}
                              className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
                            >
                              Refund credit
                            </button>
                          )}
                          {!s.feeWaived && (
                            <button
                              onClick={() => {
                                const reason = window.prompt(
                                  `Waive this period's fee for ${h.name}? Say why — this is revenue Swift is giving up, and the reason is kept:`,
                                );
                                if (!reason || reasonTooShort(reason)) return;
                                waive.mutate({ id: s.id, reason: reason.trim() });
                              }}
                              disabled={waive.isPending}
                              className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
                            >
                              Waive fee
                            </button>
                          )}
                        </div>
                        {Number(s.refundSetAside ?? 0) > 0 && (
                          <p className="text-xs text-amber-500 mt-2">{payoutReported
                            ? 'Payment reported; recording awaits approval. Do not pay again or release this refund.'
                            : `GY$${Number(s.refundSetAside).toLocaleString()} set aside: pay it outside Swift, then record the payout.`}</p>
                        )}
                        {refundOutcome[s.id] && <RefundOutcome outcome={refundOutcome[s.id]!} />}
                      </td>
                    </tr>
                    {openTrail === s.id && (
                      <tr className="border-b border-[var(--border)] bg-black/20">
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
