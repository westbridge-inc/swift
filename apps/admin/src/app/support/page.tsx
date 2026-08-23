'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchSupportTickets, resolveSupportTicket } from '@/lib/api';

const FILTERS = ['OPEN', 'IN_PROGRESS', 'RESOLVED'] as const;

const CATEGORY_CLS: Record<string, string> = {
  SAFETY: 'bg-red-500/15 text-red-400',
  PAYMENT: 'bg-amber-500/15 text-amber-400',
  ORDER_ISSUE: 'bg-sky-500/15 text-sky-400',
};

export default function SupportPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('OPEN');
  const { data, isLoading } = useQuery({ queryKey: ['support', filter], queryFn: () => fetchSupportTickets(filter) });
  const resolve = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: 'IN_PROGRESS' | 'RESOLVED'; note?: string }) =>
      resolveSupportTicket(id, status, note),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['support'] }),
  });

  const tickets: any[] = data?.data?.tickets ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">Support</h1>
        <div className="flex gap-1">
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
      </div>
      <p className="text-[var(--muted)] text-sm mb-6">In-app tickets from customers, movers and vendors. Safety first.</p>

      <div className="space-y-3">
        {isLoading ? (
          <div className="h-24 rounded-xl bg-[var(--panel)] border border-[var(--border)] animate-pulse" />
        ) : tickets.length === 0 ? (
          <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-8 text-center text-[var(--muted)]">
            No {filter.replaceAll('_', ' ').toLowerCase()} tickets.
          </div>
        ) : (
          tickets.map((t: any) => (
            <div key={t.id} className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-5">
              <div className="flex flex-wrap items-center gap-3">
                <span className={`px-2.5 py-1 rounded-full text-xs ${CATEGORY_CLS[t.category] ?? 'bg-white/10 text-[var(--muted)]'}`}>
                  {String(t.category).replaceAll('_', ' ').toLowerCase()}
                </span>
                <span className="font-semibold">{t.subject}</span>
                <span className="text-xs text-[var(--muted)] ml-auto">{new Date(t.createdAt).toLocaleString()}</span>
              </div>
              <p className="text-sm text-[var(--muted)] mt-2 whitespace-pre-wrap">{t.message}</p>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-[var(--muted)]">
                {t.user ? (
                  <Link href={`/users/${t.user.id}`} className="hover:text-[var(--accent)] transition-colors">
                    {[t.user.firstName, t.user.lastName].filter(Boolean).join(' ')} · {t.user.phone} →
                  </Link>
                ) : null}
                {t.orderId ? (
                  <Link href={`/orders/${t.orderId}`} className="hover:text-[var(--accent)] transition-colors">
                    View order →
                  </Link>
                ) : null}
                {t.adminNote ? <span className="italic">note: “{t.adminNote}”</span> : null}
              </div>
              {t.status !== 'RESOLVED' && (
                <div className="flex gap-2 mt-4">
                  {t.status === 'OPEN' && (
                    <button
                      onClick={() => resolve.mutate({ id: t.id, status: 'IN_PROGRESS' })}
                      disabled={resolve.isPending}
                      className="px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
                    >
                      Take it
                    </button>
                  )}
                  <button
                    onClick={() => {
                      const note = window.prompt('Resolution note (the user sees this):') ?? undefined;
                      resolve.mutate({ id: t.id, status: 'RESOLVED', note: note || undefined });
                    }}
                    disabled={resolve.isPending}
                    className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
                  >
                    Resolve
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
