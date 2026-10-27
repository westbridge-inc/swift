'use client';

import { useState } from 'react';
import Link from 'next/link';
import { maskedPhone } from '@/lib/review-center';
import { REASON_MIN, reasonTooShort } from '@/lib/ask-reason';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { completeAccountClosure, fetchSupportTickets, resolveSupportTicket, type SupportResolution } from '@/lib/api';
import { humanise } from '@/lib/labels';
import { useStatusFromUrl } from '@/lib/status-from-url';

const FILTERS = ['OPEN', 'IN_PROGRESS', 'RESOLVED'] as const;

const CATEGORY_CLS: Record<string, string> = {
  SAFETY: 'mc-badge mc-tone-bad',
  PAYMENT: 'mc-badge mc-tone-warn',
  ORDER_ISSUE: 'mc-badge mc-tone-info',
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
// [DELETION-INTEGRITY] The subject the server gives a closure request that was
// confirmed in the app. Only these can be completed from the queue.
const CLOSURE_SUBJECT = 'Account closure request';
const isClosureRequest = (t: { category?: string; subject?: string }) => t.category === 'ACCOUNT' && t.subject === CLOSURE_SUBJECT;

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function SupportPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('OPEN');
  // [ADMIN-AUDIT S2-1] Today's rows open the tab that lists them (?status=…).
  useStatusFromUrl(FILTERS, setFilter);
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

  // [U57] "Take it" is its own act with its own answer, shown next to ITS
  // ticket's button. It used to share the close mutation, whose error renders
  // only inside an open close panel (possibly another ticket's), so a failed
  // take showed nothing.
  const take = useMutation({
    mutationFn: ({ id, expectedStatus }: { id: string; expectedStatus: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' }) =>
      resolveSupportTicket(id, 'IN_PROGRESS', undefined, undefined, expectedStatus),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['support'] }),
  });

  /** [DELETION-INTEGRITY] The closure request being completed, with the stated reason. */
  const [completing, setCompleting] = useState<{ id: string; reason: string } | null>(null);
  const closeAccount = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => completeAccountClosure(id, reason),
    onSuccess: () => {
      setCompleting(null);
      qc.invalidateQueries({ queryKey: ['support'] });
    },
  });

  /** The ticket currently being closed, with the operator's answers so far. */
  const [closing, setClosing] = useState<{ id: string; resolution: SupportResolution | ''; note: string } | null>(null);

  const tickets: any[] = data?.data?.tickets ?? [];

  return (
    <div className="mc-page">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="mc-muted">In-app tickets from customers, movers and businesses. Safety first.</p>
        <div className="mc-tabs mb-0" role="group" aria-label="Tickets">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className="mc-tab"
            >
              {humanise(f)}
            </button>
          ))}
        </div>
      </div>
      <div className="mc-list">
        {isLoading ? (
          <div className="mc-loading" aria-busy="true">Loading tickets…</div>
        ) : isError ? (
          // [A-18] A failed request is not an empty queue. Saying "no tickets"
          // when the server did not answer hides exactly the reports that matter.
          <div className="mc-card border-l-4 border-l-[var(--mc-bad)]">
            <p className="mc-text-bad font-semibold">This queue could not be loaded.</p>
            <p className="mc-muted mt-1">
              There may be open tickets you cannot see. This is not an empty queue.
            </p>
            <button
              onClick={() => void refetch()}
              disabled={isFetching}
              className="mc-btn mt-3"
            >
              {isFetching ? 'Retrying…' : 'Try again'}
            </button>
          </div>
        ) : tickets.length === 0 ? (
          <div className="mc-empty">
            No {filter.replaceAll('_', ' ').toLowerCase()} tickets.
          </div>
        ) : (
          tickets.map((t: any) => {
            const isSafety = t.category === 'SAFETY';
            const completion = completing?.id === t.id ? completing : null;
            const open = closing?.id === t.id;
            const choices = RESOLUTIONS.filter((r) => !isSafety || r.safety);
            const noteTooShort = isSafety && (closing?.note ?? '').trim().length < SAFETY_NOTE_MIN;
            const cannotClose = !closing?.resolution || (isSafety && noteTooShort);
            return (
              <div key={t.id} className={`mc-card${isSafety ? ' border-l-4 border-l-[var(--mc-bad)]' : ''}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className={CATEGORY_CLS[t.category] ?? 'mc-badge'}>
                    {humanise(String(t.category))}
                  </span>
                  <span className="mc-card-title">{t.subject}</span>
                  <span className="mc-muted mc-numbers ml-auto text-xs">{when(t.createdAt)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap">{t.message}</p>
                <div className="mc-muted mt-3 flex flex-wrap items-center gap-4">
                  {t.user ? (
                    <Link href={`/users/${t.user.id}`} className="font-semibold text-[var(--mc-accent)]">
                      {[t.user.firstName, t.user.lastName].filter(Boolean).join(' ')} · {maskedPhone(t.user.phone)} →
                    </Link>
                  ) : null}
                  {t.orderId ? (
                    <Link href={`/orders/${t.orderId}`} className="font-semibold text-[var(--mc-accent)]">
                      View order →
                    </Link>
                  ) : null}
                  {t.adminNote ? <span className="italic">note: “{t.adminNote}”</span> : null}
                  {t.resolution ? (
                    <span className="mc-badge">
                      {humanise(String(t.resolution))}
                    </span>
                  ) : null}
                </div>

                {t.status !== 'RESOLVED' && isClosureRequest(t) && (
                  <div className="mt-4">
                    {!completion ? (
                      <button
                        onClick={() => { closeAccount.reset(); setCompleting({ id: t.id, reason: '' }); }}
                        className="mc-btn mc-btn-danger"
                      >
                        Complete account closure
                      </button>
                    ) : (
                      <div className="rounded-[var(--mc-radius-sm)] border border-[rgb(185_28_28/30%)] bg-[var(--mc-bad-soft)] p-4">
                        <p className="font-semibold">Close this account and de-identify the person?</p>
                        <p className="mc-muted mt-1 text-xs">
                          This cannot be undone. Financial and legal records are kept. If orders, jobs or cash are still
                          open, the server refuses and says what is outstanding; the request stays open.
                        </p>
                        <label className="mt-3 block text-xs font-semibold" htmlFor={`closure-reason-${t.id}`}>
                          Why you are closing this account (recorded in the audit trail)
                        </label>
                        <textarea
                          id={`closure-reason-${t.id}`}
                          value={completion.reason}
                          onChange={(e) => setCompleting({ id: t.id, reason: e.target.value })}
                          rows={2}
                          aria-describedby={`closure-reason-help-${t.id}`}
                          className="mc-input mt-1"
                        />
                        {/* [U56] The server needs at least REASON_MIN characters; say so before sending. */}
                        <p id={`closure-reason-help-${t.id}`} className="mc-muted mt-1 text-xs">
                          At least {REASON_MIN} characters ({completion.reason.trim().length} so far).
                        </p>
                        {closeAccount.isError && closeAccount.variables?.id === t.id ? (
                          <p className="mc-alert mt-2">{(closeAccount.error as Error).message}</p>
                        ) : null}
                        <div className="mc-actions">
                          <button
                            onClick={() => closeAccount.mutate({ id: t.id, reason: completion.reason.trim() })}
                            disabled={closeAccount.isPending || reasonTooShort(completion.reason)}
                            className="mc-btn mc-btn-primary"
                          >
                            {closeAccount.isPending ? 'Closing…' : 'Close the account'}
                          </button>
                          <button
                            onClick={() => setCompleting(null)}
                            disabled={closeAccount.isPending}
                            className="mc-btn"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {t.status !== 'RESOLVED' && (
                  <div className="mt-4">
                    {!open ? (
                      <div className="mc-actions mt-0">
                        {t.status === 'OPEN' && (
                          <button
                            type="button"
                            onClick={() => take.mutate({ id: t.id, expectedStatus: t.status })}
                            disabled={take.isPending}
                            className="mc-btn"
                          >
                            {take.isPending && take.variables?.id === t.id ? 'Taking…' : 'Take it'}
                          </button>
                        )}
                        <button
                          onClick={() => setClosing({ id: t.id, resolution: '', note: '' })}
                          className="mc-btn mc-btn-primary"
                        >
                          Close this ticket
                        </button>
                        {take.isError && take.variables?.id === t.id ? (
                          <p role="alert" className="mc-text-bad self-center">{(take.error as Error).message}</p>
                        ) : null}
                      </div>
                    ) : (
                      <div className="rounded-[var(--mc-radius-sm)] border border-[var(--mc-line)] bg-[var(--mc-surface)] p-4">
                        <p className="font-semibold">
                          {isSafety ? 'Closing a safety report — what was done?' : 'What happened?'}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {choices.map((r) => (
                            <button
                              key={r.value}
                              onClick={() => setClosing({ ...closing!, resolution: r.value })}
                              type="button"
                              aria-pressed={closing?.resolution === r.value}
                              className="mc-tab"
                            >
                              {r.label}
                            </button>
                          ))}
                        </div>
                        <label className="mt-3 block text-xs font-semibold" htmlFor={`note-${t.id}`}>
                          {isSafety
                            ? `What the reporter will read — required, at least ${SAFETY_NOTE_MIN} characters`
                            : 'What the reporter will read (optional)'}
                        </label>
                        <textarea
                          id={`note-${t.id}`}
                          value={closing?.note ?? ''}
                          onChange={(e) => setClosing({ ...closing!, note: e.target.value })}
                          rows={3}
                          className="mc-input mt-1"
                        />
                        {resolve.isError && resolve.variables?.id === t.id ? (
                          <p role="alert" className="mc-alert mt-2">{(resolve.error as Error).message}</p>
                        ) : null}
                        <div className="mc-actions">
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
                            className="mc-btn mc-btn-primary"
                          >
                            {resolve.isPending ? 'Closing…' : 'Close ticket'}
                          </button>
                          {/* [A-18] Cancel sends nothing. It used to close the ticket. */}
                          <button
                            onClick={() => setClosing(null)}
                            disabled={resolve.isPending}
                            className="mc-btn"
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
