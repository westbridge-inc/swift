'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchModerationReports,
  fetchRatingsModeration,
  moderateRating,
  resolveModerationReport,
  resolveRatingReport,
} from '@/lib/api';
import { MutationError } from '@/components/MutationError';

// ---------------------------------------------------------------------------
// STORE-001 — the reviewer's side of moderation.
//
// Three queues have been filling up with nobody able to open them. The report
// doors shipped on the customer side (UGC reporting, flaggable reviews and
// storefronts) and the API exposed every endpoint an admin needs — and no
// admin page ever called one of them. So reports written by real customers
// went into tables no human could read, and reviews auto-held by the profanity
// filter were withheld from publication waiting on a decision nobody was able
// to make.
//
// The three are NOT the same shape, and the page says so rather than flattening
// them into one comfortable-looking list:
//
//   Reported content  — records a DECISION. It does not remove anything; the
//                       API is explicit that enforcement runs through the
//                       separate admin endpoints for the thing itself.
//   Reported reviews  — upholding REMOVES the review, notifies its author and
//                       re-levels the rating average dispatch reads.
//   Held reviews      — caught by the profanity filter and not published. Until
//                       someone publishes or removes them they stay invisible,
//                       which for an honest review is a silent suppression.
// ---------------------------------------------------------------------------

type Tab = 'content' | 'reviews' | 'held';

const REPORT_STATUSES = ['PENDING', 'REVIEWING', 'ACTIONED', 'DISMISSED'] as const;

/** CSAE is not one reason among eight. It goes to the top and it looks it. */
function reasonClass(reason: string) {
  if (reason === 'CSAE') return 'bg-red-600 text-white font-semibold';
  if (reason === 'VIOLENCE' || reason === 'HATE_SPEECH' || reason === 'SEXUAL_CONTENT') {
    return 'bg-red-500/20 text-red-400';
  }
  return 'bg-yellow-500/20 text-yellow-400';
}

function targetSummary(report: any): string {
  const t = report.target;
  if (!t) return 'Content already gone';
  if (report.targetType === 'RATING') return t.comment || `${t.score}★ review, no text`;
  if (report.targetType === 'CHAT_MESSAGE') return t.message || 'Empty message';
  if (report.targetType === 'USER') return [t.firstName, t.lastName].filter(Boolean).join(' ') || 'Unnamed user';
  if (report.targetType === 'VENDOR') return t.name || 'Unnamed store';
  if (report.targetType === 'ITEM') return t.name || 'Unnamed item';
  return report.targetId;
}

export default function ModerationPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('content');
  const [status, setStatus] = useState<(typeof REPORT_STATUSES)[number]>('PENDING');
  const [note, setNote] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<unknown>(null);

  const reports = useQuery({
    queryKey: ['moderation', 'content', status],
    queryFn: () => fetchModerationReports(status),
  });
  const ratings = useQuery({
    queryKey: ['moderation', 'ratings'],
    queryFn: () => fetchRatingsModeration(),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['moderation'] });
    setActiveId(null);
    setNote('');
    setMutationError(null);
  };
  const onError = (error: unknown) => setMutationError(error);

  const decideReport = useMutation({
    mutationFn: ({ id, next }: { id: string; next: 'REVIEWING' | 'ACTIONED' | 'DISMISSED' }) =>
      resolveModerationReport(id, { status: next, ...(note.trim() ? { note: note.trim() } : {}) }),
    onMutate: () => setMutationError(null),
    onError,
    onSuccess: refresh,
  });
  const decideRatingReport = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'uphold' | 'dismiss' }) => resolveRatingReport(id, action),
    onMutate: () => setMutationError(null),
    onError,
    onSuccess: refresh,
  });
  const decideHeld = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'publish' | 'remove' | 'exclude' }) =>
      moderateRating(id, action === 'publish' ? { action } : { action, reason: 'MODERATION' }),
    onMutate: () => setMutationError(null),
    onError,
    onSuccess: refresh,
  });

  const contentRows: any[] = reports.data?.data ?? [];
  const pendingTotal: number | undefined = reports.data?.pendingTotal;
  const ratingReports: any[] = ratings.data?.data?.reports ?? [];
  const heldReviews: any[] = ratings.data?.data?.held ?? [];

  const busy = decideReport.isPending || decideRatingReport.isPending || decideHeld.isPending;

  const TABS: { key: Tab; label: string; count: number }[] = [
    { key: 'content', label: 'Reported content', count: pendingTotal ?? contentRows.length },
    { key: 'reviews', label: 'Reported reviews', count: ratingReports.length },
    { key: 'held', label: 'Held reviews', count: heldReviews.length },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Moderation</h1>
      <p className="text-[var(--muted)] mb-6 text-sm">
        Everything customers have flagged, plus the reviews the profanity filter is holding back.
        Reports are worked oldest first so nothing rots at the back of the queue.
      </p>

      <div className="flex gap-2 mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setActiveId(null); setMutationError(null); }}
            className={`px-3 py-1.5 rounded-lg text-xs ${
              tab === t.key
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--panel)] text-[var(--muted)] border border-[var(--border)]'
            }`}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      {mutationError ? <MutationError error={mutationError} label="moderation decision" /> : null}

      {tab === 'content' ? (
        <div>
          <div className="flex gap-2 mb-3">
            {REPORT_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => { setStatus(s); setActiveId(null); }}
                className={`px-3 py-1 rounded-lg text-[11px] ${
                  status === s ? 'bg-[var(--accent)] text-white' : 'bg-[var(--panel)] text-[var(--muted)] border border-[var(--border)]'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <p className="text-[var(--muted)] text-xs mb-3">
            Recording a decision here does <strong>not</strong> remove the content. Enforcement —
            taking down a review, suspending a store, banning a user — runs through that thing&apos;s
            own admin page. This is the record of what was decided and by whom.
          </p>

          {reports.isLoading ? (
            <p className="text-[var(--muted)] text-sm">Loading…</p>
          ) : contentRows.length === 0 ? (
            <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-10 text-center text-[var(--muted)] text-sm">
              Nothing {status.toLowerCase()}.
            </div>
          ) : (
            <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] divide-y divide-[var(--border)]">
              {contentRows.map((r) => (
                <div key={r.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <span className={`px-2 py-0.5 rounded text-[11px] ${reasonClass(r.reason)}`}>{r.reason}</span>
                    <span className="text-[11px] text-[var(--muted)]">{r.targetType}</span>
                    <span className="text-[11px] text-[var(--muted)] ml-auto">
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm mt-2">{targetSummary(r)}</p>
                  {r.detail ? (
                    <p className="text-xs text-[var(--muted)] mt-1">Reporter said: {r.detail}</p>
                  ) : null}
                  {!r.target ? (
                    <p className="text-xs text-[var(--muted)] mt-1">
                      The reported content no longer exists — it may already have been removed.
                    </p>
                  ) : null}

                  {r.status === 'PENDING' || r.status === 'REVIEWING' ? (
                    activeId === r.id ? (
                      <div className="mt-3 space-y-2">
                        <textarea
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="What did you decide, and why? (optional, kept on the record)"
                          className="w-full text-sm bg-[var(--bg)] border border-[var(--border)] rounded-lg p-2"
                          rows={2}
                        />
                        <div className="flex gap-2">
                          <button
                            disabled={busy}
                            onClick={() => decideReport.mutate({ id: r.id, next: 'ACTIONED' })}
                            className="px-3 py-1.5 rounded-lg text-xs bg-red-500/20 text-red-400 disabled:opacity-50"
                          >
                            Record as actioned
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => decideReport.mutate({ id: r.id, next: 'DISMISSED' })}
                            className="px-3 py-1.5 rounded-lg text-xs bg-[var(--bg)] border border-[var(--border)] disabled:opacity-50"
                          >
                            Dismiss
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => { setActiveId(null); setNote(''); }}
                            className="px-3 py-1.5 rounded-lg text-xs text-[var(--muted)]"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2 mt-3">
                        <button
                          disabled={busy}
                          onClick={() => { setActiveId(r.id); setNote(''); setMutationError(null); }}
                          className="px-3 py-1.5 rounded-lg text-xs bg-[var(--accent)] text-white disabled:opacity-50"
                        >
                          Decide
                        </button>
                        {r.status === 'PENDING' ? (
                          <button
                            disabled={busy}
                            onClick={() => decideReport.mutate({ id: r.id, next: 'REVIEWING' })}
                            className="px-3 py-1.5 rounded-lg text-xs bg-[var(--bg)] border border-[var(--border)] disabled:opacity-50"
                          >
                            Claim (reviewing)
                          </button>
                        ) : null}
                      </div>
                    )
                  ) : (
                    <p className="text-xs text-[var(--muted)] mt-2">
                      {r.status}
                      {r.resolutionNote ? ` — ${r.resolutionNote}` : ''}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {tab === 'reviews' ? (
        <div>
          <p className="text-[var(--muted)] text-xs mb-3">
            Upholding one of these <strong>removes the review</strong>, tells its author why, and
            re-levels the store&apos;s average — which is what dispatch reads. Dismissing leaves it
            published.
          </p>
          {ratings.isLoading ? (
            <p className="text-[var(--muted)] text-sm">Loading…</p>
          ) : ratingReports.length === 0 ? (
            <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-10 text-center text-[var(--muted)] text-sm">
              No reported reviews waiting.
            </div>
          ) : (
            <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] divide-y divide-[var(--border)]">
              {ratingReports.map((r) => (
                <div key={r.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="px-2 py-0.5 rounded text-[11px] bg-yellow-500/20 text-yellow-400">{r.reason}</span>
                    <span className="text-[11px] text-[var(--muted)] ml-auto">
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm mt-2">
                    {r.rating ? (r.rating.comment || `${r.rating.score}★ review, no text`) : 'Review already gone'}
                  </p>
                  {r.note ? <p className="text-xs text-[var(--muted)] mt-1">Reporter said: {r.note}</p> : null}
                  <div className="flex gap-2 mt-3">
                    <button
                      disabled={busy || !r.rating}
                      onClick={() => decideRatingReport.mutate({ id: r.id, action: 'uphold' })}
                      className="px-3 py-1.5 rounded-lg text-xs bg-red-500/20 text-red-400 disabled:opacity-50"
                    >
                      Uphold &amp; remove review
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => decideRatingReport.mutate({ id: r.id, action: 'dismiss' })}
                      className="px-3 py-1.5 rounded-lg text-xs bg-[var(--bg)] border border-[var(--border)] disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {tab === 'held' ? (
        <div>
          <p className="text-[var(--muted)] text-xs mb-3">
            The profanity filter caught these and <strong>withheld them from the storefront</strong>.
            A held review is invisible to everyone until someone decides — so an honest review left
            sitting here is quietly suppressed.
          </p>
          {ratings.isLoading ? (
            <p className="text-[var(--muted)] text-sm">Loading…</p>
          ) : heldReviews.length === 0 ? (
            <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-10 text-center text-[var(--muted)] text-sm">
              Nothing is being held.
            </div>
          ) : (
            <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] divide-y divide-[var(--border)]">
              {heldReviews.map((h) => (
                <div key={h.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="px-2 py-0.5 rounded text-[11px] bg-[var(--bg)] border border-[var(--border)]">
                      {h.score}★
                    </span>
                    <span className="text-[11px] text-[var(--muted)] ml-auto">
                      {new Date(h.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm mt-2">{h.comment || 'No text'}</p>
                  <div className="flex gap-2 mt-3">
                    <button
                      disabled={busy}
                      onClick={() => decideHeld.mutate({ id: h.id, action: 'publish' })}
                      className="px-3 py-1.5 rounded-lg text-xs bg-green-500/20 text-green-400 disabled:opacity-50"
                    >
                      Publish it
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => decideHeld.mutate({ id: h.id, action: 'remove' })}
                      className="px-3 py-1.5 rounded-lg text-xs bg-red-500/20 text-red-400 disabled:opacity-50"
                    >
                      Remove
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => decideHeld.mutate({ id: h.id, action: 'exclude' })}
                      className="px-3 py-1.5 rounded-lg text-xs bg-[var(--bg)] border border-[var(--border)] disabled:opacity-50"
                    >
                      Exclude from average
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
