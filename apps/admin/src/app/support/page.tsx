'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchSupportTickets, resolveSupportTicket, type SupportResolution } from '@/lib/api';

const FILTERS = ['OPEN', 'IN_PROGRESS', 'RESOLVED'] as const;

const CATEGORY_CLS: Record<string, string> = {
  SAFETY: 'bg-red-500/15 text-red-400',
  PAYMENT: 'bg-amber-500/15 text-amber-400',
  ORDER_ISSUE: 'bg-sky-500/15 text-sky-400',
};

// [A-18] Closing a ticket is a decision, so the screen asks for one. The old
// flow was a single window.prompt whose CANCEL still resolved the ticket with
// no note — an urgent safety report could leave the queue on a mis-click, with
// nothing recorded but a status change. A safety report cannot be closed as
// "answered" at all: it closes on what was DONE, and on a note its reporter
// will read.
const RESOLUTIONS: { value: SupportResolution; label: string; safety: boolean }[] = [
  { value: 'ACTION_TAKEN', label: 'Action taken', safety: true },
  { value: 'ESCALATED_SAFETY', label: 'Escalated to the safety team', safety: true },
  { value: 'NO_RISK_FOUND', label: 'Reviewed — no risk found', safety: true },
  { value: 'ANSWERED', label: 'Answered / information given', safety: false },
  { value: 'UNABLE_TO_CONTACT', label: 'Unable to contact the reporter', safety: false },
];
const SAFETY_NOTE_MIN = 20;

export default function SupportPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('OPEN');
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['support', filter],
    queryFn: () => fetchSupportTickets(filter),
  });
  const resolve = useMutation({
    mutationFn: ({
      id,
      status,
      note,
      resolution,
      expectedStatus,
    }: {
      id: string;
      status: 'IN_PROGRESS' | 'RESOLVED';
      note?: string;
      resolution?: SupportResolution;
      expectedStatus?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
    }) => resolveSupportTicket(id, status, note, resolution, expectedStatus),
    onSuccess: () => {
      setClosing(null);
      qc.invalidateQueries({ queryKey: ['support'] });
    },
  });

  /** The ticket currently being closed, with the operator's answers so far. */
  const [closing, setClosing] = useState<{ id: string; resolution: SupportResolution | ''; note: string } | null>(null);

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
        ) : isError ? (
          // [A-18] A failed request is not an empty queue. Saying "no tickets"
          // when the server did not answer hides exactly the reports that matter.
          <div className="bg-[var(--panel)] rounded-xl border border-red-500/40 p-8 text-center">
            <p className="font-semibold text-red-400">This queue could not be loaded.</p>
            <p className="text-sm text-[var(--muted)] mt-1">
              There may be open tickets you cannot see. This is not an empty queue.
            </p>
            <button
              onClick={() => void refetch()}
              disabled={isFetching}
              className="mt-4 px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
            >
              {isFetching ? 'Retrying…' : 'Try again'}
            </button>
          </div>
        ) : tickets.length === 0 ? (
          <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-8 text-center text-[var(--muted)]">
            No {filter.replaceAll('_', ' ').toLowerCase()} tickets.
          </div>
        ) : (
          tickets.map((t: any) => {
            const isSafety = t.category === 'SAFETY';
            const open = closing?.id === t.id;
            const choices = RESOLUTIONS.filter((r) => !isSafety || r.safety);
            const noteTooShort = isSafety && (closing?.note ?? '').trim().length < SAFETY_NOTE_MIN;
            const cannotClose = !closing?.resolution || (isSafety && noteTooShort);
            return (
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
                  {t.resolution ? (
                    <span className="rounded-full bg-white/5 px-2.5 py-1 text-xs">
                      {String(t.resolution).replaceAll('_', ' ').toLowerCase()}
                    </span>
                  ) : null}
                </div>

                {t.status !== 'RESOLVED' && (
                  <div className="mt-4">
                    {!open ? (
                      <div className="flex gap-2">
                        {t.status === 'OPEN' && (
                          <button
                            onClick={() => resolve.mutate({ id: t.id, status: 'IN_PROGRESS', expectedStatus: t.status })}
                            disabled={resolve.isPending}
                            className="px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
                          >
                            Take it
                          </button>
                        )}
                        <button
                          onClick={() => setClosing({ id: t.id, resolution: '', note: '' })}
                          className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent)]/80"
                        >
                          Close this ticket
                        </button>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-[var(--border)] p-4">
                        <p className="text-sm font-semibold">
                          {isSafety ? 'Closing a safety report — what was done?' : 'What happened?'}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {choices.map((r) => (
                            <button
                              key={r.value}
                              onClick={() => setClosing({ ...closing!, resolution: r.value })}
                              className={`rounded-full px-3 py-1.5 text-xs ${
                                closing?.resolution === r.value
                                  ? 'bg-white text-black font-semibold'
                                  : 'bg-white/5 text-[var(--muted)] hover:bg-white/10'
                              }`}
                            >
                              {r.label}
                            </button>
                          ))}
                        </div>
                        <label className="mt-3 block text-xs text-[var(--muted)]" htmlFor={`note-${t.id}`}>
                          {isSafety
                            ? `What the reporter will read — required, at least ${SAFETY_NOTE_MIN} characters`
                            : 'What the reporter will read (optional)'}
                        </label>
                        <textarea
                          id={`note-${t.id}`}
                          value={closing?.note ?? ''}
                          onChange={(e) => setClosing({ ...closing!, note: e.target.value })}
                          rows={3}
                          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent p-2 text-sm"
                        />
                        {resolve.isError ? (
                          <p className="mt-2 text-sm text-red-400">{(resolve.error as Error).message}</p>
                        ) : null}
                        <div className="mt-3 flex gap-2">
                          <button
                            onClick={() =>
                              resolve.mutate({
                                id: t.id,
                                status: 'RESOLVED',
                                note: closing?.note?.trim() || undefined,
                                resolution: (closing?.resolution || undefined) as SupportResolution | undefined,
                                expectedStatus: t.status,
                              })
                            }
                            disabled={resolve.isPending || cannotClose}
                            className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
                          >
                            {resolve.isPending ? 'Closing…' : 'Close ticket'}
                          </button>
                          {/* [A-18] Cancel sends nothing. It used to close the ticket. */}
                          <button
                            onClick={() => setClosing(null)}
                            disabled={resolve.isPending}
                            className="px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
