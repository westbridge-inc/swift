'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSubscriptions, waiveSubscriptionFee, fetchBillingEvents } from '@/lib/api';
import { StatusPill, gyd } from '@/components/detail';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { QueryFailed } from '@/components/mc/QueryFailed';

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

export default function SubscriptionsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const [openTrail, setOpenTrail] = useState<string | null>(null);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['subscriptions', filter],
    queryFn: () => fetchSubscriptions(filter === 'ALL' ? 'limit=50' : `limit=50&status=${filter}`),
  });
  const actions = useActionRunner(() => void qc.invalidateQueries({ queryKey: ['subscriptions'] }));
  // [A-12] The reason used to be the constant 'Waived by admin' — a field that
  // was always filled and never said anything. This is Swift's own revenue
  // being given away; the operator says why, in their own words, and that is
  // what is stored. [MC-MONEY] Asked in the page's panel; a waiver is money, so
  // it goes to a second admin and the page says so instead of going quiet.
  const waive = (s: any, name: string) => void actions.run({
    title: `Waive this period's fee for ${name}?`,
    body: <p>This is revenue Swift gives up. A second admin approves it before it applies; the reason is kept with it.</p>,
    confirmLabel: 'Waive fee',
    reason: { hint: 'Say why Swift is giving this up — the reason is kept.' },
    submit: ({ reason }) => waiveSubscriptionFee(s.id, reason),
    success: () => `${name}'s fee for this period is waived.`,
  });
  // [MC-MONEY · coordinator ruling under GUARDRAILS] There is no "Top up" here.
  // A partner pays the weekly fee only through the MMG checkout page (card
  // later), and a payment is credited only after the provider's own lookup
  // confirms it — never from a reference an operator types.

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
        The weekly flat fee is Swift&apos;s only revenue — this queue is the business. Partners pay it through the
        MMG checkout page; a payment counts once MMG confirms it, so there is no manual top-up here.
      </p>
      {actions.banner}

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
            ) : isError ? (
              // [DS768 E2] an outage is not "no subscriptions" — this queue is the revenue
              <tr><td colSpan={5} className="p-4"><QueryFailed error={error} what="the subscriptions" onRetry={() => void refetch()} retrying={isFetching} /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={5} className="p-8 text-center text-[var(--muted)]">No subscriptions match.</td></tr>
            ) : (
              rows.map((s: any) => {
                const h = holder(s);
                const when = s.isTrialActive && s.trialEndDate ? `trial → ${new Date(s.trialEndDate).toLocaleDateString()}` : s.nextBillingDate ? new Date(s.nextBillingDate).toLocaleDateString() : '—';
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
                          {!s.feeWaived && (
                            <button
                              onClick={() => waive(s, h.name)}
                              aria-label={`Waive fee for ${h.name}…`}
                              className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
                            >
                              Waive fee…
                            </button>
                          )}
                        </div>
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
