'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchSubscriptions, waiveSubscriptionFee, topUpSubscription, fetchBillingEvents } from '@/lib/api';
import { StatusPill, gyd } from '@/components/detail';

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
  if (isLoading) return <p className="text-xs text-[#8E8E93] p-3">Loading billing trail…</p>;
  if (events.length === 0) return <p className="text-xs text-[#8E8E93] p-3">No billing events.</p>;
  return (
    <div className="p-3 space-y-1.5">
      {events.map((e: any) => (
        <div key={e.id} className="flex items-center gap-3 text-xs">
          <span className="text-[#8E8E93] w-36 shrink-0">{new Date(e.createdAt).toLocaleString()}</span>
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
  const { data, isLoading } = useQuery({
    queryKey: ['subscriptions', filter],
    queryFn: () => fetchSubscriptions(filter === 'ALL' ? 'limit=50' : `limit=50&status=${filter}`),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['subscriptions'] });
  const waive = useMutation({ mutationFn: (id: string) => waiveSubscriptionFee(id, 'Waived by admin'), onSuccess: invalidate });
  const topup = useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: number }) => topUpSubscription(id, amount),
    onSuccess: invalidate,
  });

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
                filter === f ? 'bg-white text-black font-semibold' : 'bg-white/5 text-[#8E8E93] hover:bg-white/10'
              }`}
            >
              {f === 'ALL' ? 'All' : f.replaceAll('_', ' ').toLowerCase()}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[#8E8E93] text-sm mb-6">
        The weekly flat fee is Swift&apos;s only revenue — this queue is the business.
      </p>

      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#38383A]">
              <th className="text-left p-4 text-[#8E8E93] font-medium">Holder</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Status</th>
              <th className="text-right p-4 text-[#8E8E93] font-medium">Weekly</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Next bill / trial end</th>
              <th className="text-right p-4 text-[#8E8E93] font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={5} className="p-8 text-center text-[#8E8E93]">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={5} className="p-8 text-center text-[#8E8E93]">No subscriptions match.</td></tr>
            ) : (
              rows.map((s: any) => {
                const h = holder(s);
                const when = s.isTrialActive && s.trialEndDate ? `trial → ${new Date(s.trialEndDate).toLocaleDateString()}` : s.nextBillingDate ? new Date(s.nextBillingDate).toLocaleDateString() : '—';
                return (
                  <Fragment key={s.id}>
                    <tr className="border-b border-[#38383A] hover:bg-white/5">
                      <td className="p-4">
                        {h.href ? (
                          <Link href={h.href} className="font-medium hover:text-[#E8192C] transition-colors">
                            {h.name}
                          </Link>
                        ) : (
                          <span className="font-medium">{h.name}</span>
                        )}
                        <span className="text-xs text-[#8E8E93] ml-2">{h.kind}</span>
                      </td>
                      <td className="p-4">
                        <StatusPill value={s.status} />
                        {s.feeWaived ? <span className="ml-2 text-xs text-sky-400">fee waived</span> : null}
                      </td>
                      <td className="p-4 text-right">{gyd(s.customRate ?? s.weeklyRate)}</td>
                      <td className="p-4 text-[#8E8E93]">{when}</td>
                      <td className="p-4 text-right">
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => setOpenTrail(openTrail === s.id ? null : s.id)}
                            className="px-3 py-1 rounded-lg text-xs border border-[#38383A] hover:bg-white/10"
                          >
                            {openTrail === s.id ? 'Hide trail' : 'Billing trail'}
                          </button>
                          <button
                            onClick={() => {
                              const amt = window.prompt(`Record a cash/bank top-up for ${h.name} (GYD):`);
                              const n = Number(amt);
                              if (amt && Number.isFinite(n) && n > 0) topup.mutate({ id: s.id, amount: n });
                            }}
                            disabled={topup.isPending}
                            className="px-3 py-1 rounded-lg text-xs border border-[#38383A] hover:bg-white/10 disabled:opacity-50"
                          >
                            Top up
                          </button>
                          {!s.feeWaived && (
                            <button
                              onClick={() => {
                                if (window.confirm(`Waive this period's fee for ${h.name}?`)) waive.mutate(s.id);
                              }}
                              disabled={waive.isPending}
                              className="px-3 py-1 rounded-lg text-xs border border-[#38383A] hover:bg-white/10 disabled:opacity-50"
                            >
                              Waive fee
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {openTrail === s.id && (
                      <tr className="border-b border-[#38383A] bg-black/20">
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
