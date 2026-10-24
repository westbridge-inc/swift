'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchModerationReports,
  fetchRatingsModeration,
  moderateRating,
  resolveModerationReport,
  type CsaeDisposition,
  resolveRatingReport,
} from '@/lib/api';
import { MutationError } from '@/components/MutationError';
import { useAskReason } from '@/components/mc/ReasonDialog';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { humanise, label } from '@/lib/labels';

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
  if (reason === 'CSAE') return 'mc-badge mc-badge-alarm';
  if (reason === 'VIOLENCE' || reason === 'HATE_SPEECH' || reason === 'SEXUAL_CONTENT') {
    return 'mc-badge mc-tone-bad';
  }
  return 'mc-badge mc-tone-warn';
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
  // The reason is asked in the in-page panel (never a browser prompt); the
  // decision itself still runs once (buttons are disabled while it runs) and a
  // refusal is shown above the list.
  const ask = useAskReason();
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
    mutationFn: ({ id, next, reason, csae }: {
      id: string;
      next: 'REVIEWING' | 'ACTIONED' | 'DISMISSED' | 'PROPOSE_DISMISS';
      reason: string;
      csae?: { disposition: CsaeDisposition; enforcementRef?: string; authorityRef?: string; evidencePreserved?: boolean };
    }) =>
      resolveModerationReport(id, {
        status: next,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(csae ?? {}),
      }, reason),
    onMutate: () => setMutationError(null),
    onError,
    onSuccess: refresh,
  });
  const decideRatingReport = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: 'uphold' | 'dismiss'; reason: string }) => resolveRatingReport(id, action, reason),
    onMutate: () => setMutationError(null),
    onError,
    onSuccess: refresh,
  });
  const decideHeld = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: 'publish' | 'remove' | 'exclude'; reason: string }) =>
      moderateRating(id, action === 'publish' ? { action } : { action, category: 'MODERATION' }, reason),
    onMutate: () => setMutationError(null),
    onError,
    onSuccess: refresh,
  });

  const contentRows: any[] = reports.data?.data ?? [];
  const pendingTotal: number | undefined = reports.data?.pendingTotal;
  const ratingReports: any[] = ratings.data?.data?.reports ?? [];
  const heldReviews: any[] = ratings.data?.data?.held ?? [];

  const busy = decideReport.isPending || decideRatingReport.isPending || decideHeld.isPending;

  // A count is shown only once its read succeeded: a failed or pending read is '—', never 0.
  const TABS: { key: Tab; label: string; count: number | '—' }[] = [
    { key: 'content', label: 'Reported content', count: reports.isSuccess ? pendingTotal ?? contentRows.length : '—' },
    { key: 'reviews', label: 'Reported reviews', count: ratings.isSuccess ? ratingReports.length : '—' },
    { key: 'held', label: 'Held reviews', count: ratings.isSuccess ? heldReviews.length : '—' },
  ];

  return (
    <div className="mc-page">
      <p className="mc-muted mb-4">
        Everything customers have flagged, plus the reviews the profanity filter is holding back.
        Reports are worked oldest first so nothing rots at the back of the queue.
      </p>

      <div className="mc-tabs" role="group" aria-label="Queue">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={tab === t.key}
            onClick={() => { setTab(t.key); setActiveId(null); setMutationError(null); }}
            className="mc-tab"
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      {mutationError ? <div className="mb-4"><MutationError error={mutationError} label="moderation decision" /></div> : null}

      {tab === 'content' ? (
        <div>
          <div className="mc-tabs mc-tabs-sub" role="group" aria-label="Report status">
            {REPORT_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={status === s}
                onClick={() => { setStatus(s); setActiveId(null); }}
                className="mc-tab"
              >
                {label('ReportStatus', s)}
              </button>
            ))}
          </div>
          <p className="mc-muted text-xs mb-3">
            Recording a decision here does <strong>not</strong> remove the content. Enforcement —
            taking down a review, suspending a store, banning a user — runs through that thing&apos;s
            own admin page. This is the record of what was decided and by whom.
          </p>

          {reports.isLoading ? (
            <div className="mc-loading" aria-busy="true">Loading…</div>
          ) : reports.isError ? (
            <QueryFailed error={reports.error} what="the reported content" onRetry={() => void reports.refetch()} retrying={reports.isFetching} />
          ) : contentRows.length === 0 ? (
            <div className="mc-empty">
              Nothing {status.toLowerCase()}.
            </div>
          ) : (
            <div className="mc-list">
              {contentRows.map((r) => (
                <div key={r.id} className="mc-card">
                  <div className="flex items-start gap-3">
                    <span className={reasonClass(r.reason)}>{humanise(r.reason)}</span>
                    <span className="mc-muted text-xs">{humanise(r.targetType)}</span>
                    <span className="text-xs mc-muted ml-auto">
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-2">{targetSummary(r)}</p>
                  {r.detail ? (
                    <p className="text-xs mc-muted mt-1">Reporter said: {r.detail}</p>
                  ) : null}
                  {!r.target ? (
                    <p className="text-xs mc-muted mt-1">
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
                          aria-label="Decision note"
                          className="mc-input"
                          rows={2}
                        />
                        {r.reason === 'CSAE' ? (
                          /* [A-17] A child-safety report closes with a CODED
                             decision and the evidence it implies — what was
                             enforced, whether the evidence is preserved, and
                             the authority report where one was made. The
                             standards page promises all three. A dismissal is
                             PROPOSED here and confirmed by a second reviewer. */
                          <CsaeCase
                            busy={busy}
                            proposedBy={r.dismissProposedBy ?? null}
                            onAction={async (csae) => { const reason = await ask({ action: 'record this child-safety enforcement' }); if (reason) decideReport.mutate({ id: r.id, next: 'ACTIONED', reason, csae }); }}
                            onProposeDismiss={async (disposition) => { const reason = await ask({ action: 'propose dismissing this child-safety report' }); if (reason) decideReport.mutate({ id: r.id, next: 'PROPOSE_DISMISS', reason, csae: { disposition } }); }}
                            onConfirmDismiss={async (disposition) => { const reason = await ask({ action: 'confirm dismissing this child-safety report' }); if (reason) decideReport.mutate({ id: r.id, next: 'DISMISSED', reason, csae: { disposition } }); }}
                          />
                        ) : (
                        <div className="mc-actions mt-0">
                          <button
                            disabled={busy}
                            onClick={async () => { const reason = await ask({ action: 'record this report as actioned' }); if (reason) decideReport.mutate({ id: r.id, next: 'ACTIONED', reason }); }}
                            className="mc-btn mc-btn-danger"
                          >
                            Record as actioned
                          </button>
                          <button
                            disabled={busy}
                            onClick={async () => { const reason = await ask({ action: 'dismiss this report' }); if (reason) decideReport.mutate({ id: r.id, next: 'DISMISSED', reason }); }}
                            className="mc-btn"
                          >
                            Dismiss
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => { setActiveId(null); setNote(''); }}
                            className="mc-btn mc-btn-quiet"
                          >
                            Cancel
                          </button>
                        </div>
                        )}
                      </div>
                    ) : (
                      <div className="mc-actions">
                        <button
                          disabled={busy}
                          onClick={() => { setActiveId(r.id); setNote(''); setMutationError(null); }}
                          className="mc-btn mc-btn-primary"
                        >
                          Decide
                        </button>
                        {r.status === 'PENDING' ? (
                        <button
                          disabled={busy}
                          onClick={async () => { const reason = await ask({ action: 'claim this report for review' }); if (reason) decideReport.mutate({ id: r.id, next: 'REVIEWING', reason }); }}
                            className="mc-btn"
                          >
                            Claim (reviewing)
                          </button>
                        ) : null}
                      </div>
                    )
                  ) : (
                    <p className="text-xs mc-muted mt-2">
                      {label('ReportStatus', r.status)}
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
          <p className="mc-muted text-xs mb-3">
            Upholding one of these <strong>removes the review</strong>, tells its author why, and
            re-levels the store&apos;s average — which is what dispatch reads. Dismissing leaves it
            published.
          </p>
          {ratings.isLoading ? (
            <div className="mc-loading" aria-busy="true">Loading…</div>
          ) : ratings.isError ? (
            <QueryFailed error={ratings.error} what="the reported reviews" onRetry={() => void ratings.refetch()} retrying={ratings.isFetching} />
          ) : ratingReports.length === 0 ? (
            <div className="mc-empty">
              No reported reviews waiting.
            </div>
          ) : (
            <div className="mc-list">
              {ratingReports.map((r) => (
                <div key={r.id} className="mc-card">
                  <div className="flex items-start gap-3">
                    <span className="mc-badge mc-tone-warn">{humanise(r.reason)}</span>
                    <span className="text-xs mc-muted ml-auto">
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-2">
                    {r.rating ? (r.rating.comment || `${r.rating.score}★ review, no text`) : 'Review already gone'}
                  </p>
                  {r.note ? <p className="text-xs mc-muted mt-1">Reporter said: {r.note}</p> : null}
                  <div className="mc-actions">
                    <button
                      disabled={busy || !r.rating}
                      onClick={async () => { const reason = await ask({ action: 'uphold this report and remove the review' }); if (reason) decideRatingReport.mutate({ id: r.id, action: 'uphold', reason }); }}
                      className="mc-btn mc-btn-danger"
                    >
                      Uphold &amp; remove review
                    </button>
                    <button
                      disabled={busy}
                      onClick={async () => { const reason = await ask({ action: 'dismiss this review report' }); if (reason) decideRatingReport.mutate({ id: r.id, action: 'dismiss', reason }); }}
                      className="mc-btn"
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
          <p className="mc-muted text-xs mb-3">
            The profanity filter caught these and <strong>withheld them from the storefront</strong>.
            A held review is invisible to everyone until someone decides — so an honest review left
            sitting here is quietly suppressed.
          </p>
          {ratings.isLoading ? (
            <div className="mc-loading" aria-busy="true">Loading…</div>
          ) : ratings.isError ? (
            <QueryFailed error={ratings.error} what="the held reviews" onRetry={() => void ratings.refetch()} retrying={ratings.isFetching} />
          ) : heldReviews.length === 0 ? (
            <div className="mc-empty">
              Nothing is being held.
            </div>
          ) : (
            <div className="mc-list">
              {heldReviews.map((h) => (
                <div key={h.id} className="mc-card">
                  <div className="flex items-start gap-3">
                    <span className="mc-badge mc-numbers">
                      {h.score}★
                    </span>
                    <span className="text-xs mc-muted ml-auto">
                      {new Date(h.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-2">{h.comment || 'No text'}</p>
                  <div className="mc-actions">
                    <button
                      disabled={busy}
                      onClick={async () => { const reason = await ask({ action: 'publish this held review' }); if (reason) decideHeld.mutate({ id: h.id, action: 'publish', reason }); }}
                      className="mc-btn mc-btn-primary"
                    >
                      Publish it
                    </button>
                    <button
                      disabled={busy}
                      onClick={async () => { const reason = await ask({ action: 'remove this review' }); if (reason) decideHeld.mutate({ id: h.id, action: 'remove', reason }); }}
                      className="mc-btn mc-btn-danger"
                    >
                      Remove
                    </button>
                    <button
                      disabled={busy}
                      onClick={async () => { const reason = await ask({ action: 'exclude this review from the rating' }); if (reason) decideHeld.mutate({ id: h.id, action: 'exclude', reason }); }}
                      className="mc-btn"
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


// ---------------------------------------------------------------------------
// [A-17] THE CHILD-SAFETY CASE PANEL.
//
// A CSAE report used to close through the same two buttons as a spam report.
// Swift's published child-safety standards promise that confirmed material is
// removed, the account banned, the matter reported to the relevant authorities
// and the evidence preserved — so the panel asks for exactly those, and the
// server refuses a closure that does not carry them.
//
// Acting is one step: the failure mode there is acting too slowly. Dismissing
// takes two people, because deciding a child-safety report is NOT a violation
// is the highest-consequence "nothing happened" decision here.
// ---------------------------------------------------------------------------
function CsaeCase({ busy, proposedBy, onAction, onProposeDismiss, onConfirmDismiss }: {
  busy: boolean;
  proposedBy: string | null;
  onAction: (_csae: { disposition: CsaeDisposition; enforcementRef: string; authorityRef?: string; evidencePreserved: boolean }) => void;
  onProposeDismiss: (_disposition: CsaeDisposition) => void;
  onConfirmDismiss: (_disposition: CsaeDisposition) => void;
}) {
  const [enforcementRef, setEnforcementRef] = useState('');
  const [authorityRef, setAuthorityRef] = useState('');
  const [preserved, setPreserved] = useState(false);
  const [dismissReason, setDismissReason] = useState<CsaeDisposition>('NO_VIOLATION');
  const reported = authorityRef.trim().length > 0;

  return (
    <div className="space-y-3 rounded-[var(--mc-radius-sm)] border border-[rgb(185_28_28/30%)] bg-[var(--mc-bad-soft)] p-3">
      <p className="mc-text-bad font-semibold">Child safety — this closes as a case, not a click</p>

      <label className="mc-field">
        What was enforced (the content removed, or the account actioned)
        <input
          value={enforcementRef}
          onChange={(e) => setEnforcementRef(e.target.value)}
          placeholder="user:banned:… or rating:removed:…"
          className="mc-input mt-1"
        />
      </label>

      <label className="mc-field">
        Report made to an authority or child-protection body (optional — leave blank if none was made yet)
        <input
          value={authorityRef}
          onChange={(e) => setAuthorityRef(e.target.value)}
          placeholder="NCMEC-2026-00417"
          className="mc-input mt-1"
        />
      </label>

      <label className="mc-check">
        <input type="checkbox" checked={preserved} onChange={(e) => setPreserved(e.target.checked)} />
        The evidence needed for those reports has been preserved
      </label>

      <div className="flex gap-2 flex-wrap">
        <button
          disabled={busy || enforcementRef.trim().length < 3 || !preserved}
          onClick={() => onAction({
            disposition: reported ? 'ENFORCED_AND_REPORTED' : 'ENFORCED',
            enforcementRef: enforcementRef.trim(),
            ...(reported ? { authorityRef: authorityRef.trim() } : {}),
            evidencePreserved: true,
          })}
          className="mc-btn mc-btn-danger"
        >
          Record as actioned
        </button>
      </div>

      <div className="border-t border-[var(--mc-line)] pt-3 space-y-2">
        <label className="mc-field">
          Or dismiss — which needs a second reviewer
          <select
            value={dismissReason}
            onChange={(e) => setDismissReason(e.target.value as CsaeDisposition)}
            className="mc-input mt-1"
          >
            <option value="NO_VIOLATION">Reviewed against the policy — not a violation</option>
            <option value="DUPLICATE">Already covered by another open case</option>
          </select>
        </label>
        {proposedBy ? (
          <>
            <p className="text-xs mc-text-warn">
              A dismissal has been proposed. A different reviewer confirms it — if that is not you, leave it.
            </p>
            <button
              disabled={busy}
              onClick={() => onConfirmDismiss(dismissReason)}
              className="mc-btn"
            >
              Confirm dismissal (second reviewer)
            </button>
          </>
        ) : (
          <button
            disabled={busy}
            onClick={() => onProposeDismiss(dismissReason)}
            className="mc-btn"
          >
            Propose dismissal
          </button>
        )}
      </div>
    </div>
  );
}
