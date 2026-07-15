'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchReturns, resolveReturn } from '@/lib/api';
import { StatusPill } from '@/components/detail';

const FILTERS = ['REQUESTED', 'APPROVED', 'REJECTED', 'REFUNDED'] as const;

export default function ReturnsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('REQUESTED');
  const { data, isLoading } = useQuery({ queryKey: ['returns', filter], queryFn: () => fetchReturns(filter) });
  const resolve = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: 'APPROVED' | 'REJECTED' | 'REFUNDED'; note?: string }) =>
      resolveReturn(id, status, note),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['returns'] }),
  });

  const rows: any[] = data?.data ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">Retail returns</h1>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 rounded-lg text-xs ${
                filter === f ? 'bg-white text-black font-semibold' : 'bg-white/5 text-[#8E8E93] hover:bg-white/10'
              }`}
            >
              {f.toLowerCase()}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[#8E8E93] text-sm mb-6">
        Return requests on retail orders. Money moved in cash — a REFUNDED outcome records the decision, it doesn&apos;t move money.
      </p>

      <div className="space-y-3">
        {isLoading ? (
          <div className="h-24 rounded-xl bg-[#1C1C1E] border border-[#38383A] animate-pulse" />
        ) : rows.length === 0 ? (
          <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-8 text-center text-[#8E8E93]">
            No {filter.toLowerCase()} returns.
          </div>
        ) : (
          rows.map((r: any) => (
            <div key={r.id} className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-5">
              <div className="flex flex-wrap items-center gap-3">
                <StatusPill value={r.status} />
                <span className="text-sm">{r.reason ?? 'No reason given'}</span>
                <span className="text-xs text-[#8E8E93] ml-auto">{new Date(r.createdAt).toLocaleString()}</span>
              </div>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-[#8E8E93]">
                <Link href={`/orders/${r.orderId}`} className="hover:text-[#E8192C] transition-colors">
                  View order →
                </Link>
                {r.resolutionNote ? <span className="italic">“{r.resolutionNote}”</span> : null}
              </div>
              {r.status === 'REQUESTED' && (
                <div className="flex gap-2 mt-4">
                  {(['APPROVED', 'REFUNDED', 'REJECTED'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => {
                        const note = window.prompt(`Note for ${s.toLowerCase()} (optional):`) ?? undefined;
                        if (window.confirm(`Mark this return ${s}?`)) resolve.mutate({ id: r.id, status: s, note: note || undefined });
                      }}
                      disabled={resolve.isPending}
                      className={`px-4 py-2 rounded-lg text-sm disabled:opacity-50 ${
                        s === 'REJECTED' ? 'border border-[#38383A] hover:bg-white/10' : s === 'REFUNDED' ? 'bg-[#E8192C] hover:bg-[#E8192C]/80' : 'border border-[#38383A] hover:bg-white/10'
                      }`}
                    >
                      {s.charAt(0) + s.slice(1).toLowerCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
