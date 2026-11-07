'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { discardDeadLetter, errorCode, fetchDeadLetters, requeueDeadLetter, type DeadLetter } from '@/lib/api';
import { MutationError } from '@/components/MutationError';
import { useActionRunner } from '@/components/mc/useActionRunner';

// ---------------------------------------------------------------------------
// N4 / WS-8.1 — the dead letters, finally visible.
//
// `GET /dlq`, `POST /dlq/:queue/:id/requeue` and `DELETE /dlq/:queue/:id` have
// existed, guarded and audited, since the mission-control spec landed. The
// route-reachability sweep found nothing in any client calling one of them. So
// a background job that exhausted its retries died into a list no human could
// open — and the money jobs are in that list: process-billing runs hourly,
// process-settlements Sunday at midnight, poll-mmg-billing every two minutes,
// billing-invariants nightly. A silently dead billing job is a silently
// unbilled week.
//
// Two distinctions this page refuses to blur:
//
//   Requeue vs discard. Requeue re-runs the job — safe here because every
//   Swift job is written idempotent (money jobs guard with DB-level uniqueness
//   or a status CAS), which is the whole reason retry-with-backoff is the
//   default. Discard is permanent and is the operator saying the work should
//   never happen. Only one of those gets a confirmation.
//
//   Empty vs blind. The queue keeps only its most recent failures, and this
//   process can be one that does not run the queues at all. "No dead letters"
//   and "I cannot see the queues" look identical in a list and mean opposite
//   things, so the page says which one it is.
// ---------------------------------------------------------------------------

/** Failures older than the queue's retention are dropped by BullMQ itself. */
const RETAINED_PER_QUEUE = 50;

function ago(finishedOn: number | null): string {
  if (!finishedOn) return 'unknown time';
  const seconds = Math.max(0, Math.round((Date.now() - finishedOn) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** The money queues. A dead job here is revenue, not a retryable annoyance. */
const MONEY_QUEUES = new Set(['subscription', 'settlement']);

export default function JobsPage() {
  const queryClient = useQueryClient();
  const [queueFilter, setQueueFilter] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<unknown>(null);

  const dlq = useQuery({
    queryKey: ['dlq'],
    queryFn: fetchDeadLetters,
    // A dead letter is not a live feed; an operator working the list does not
    // want rows moving under the cursor. Refresh is explicit.
    refetchOnWindowFocus: false,
    retry: false,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['dlq'] });
    setMutationError(null);
  };

  // A 409 means this page is looking at a job that has since changed — someone
  // retried it, or the queue was recreated and the id now belongs to something
  // else. The list must be re-read before the operator decides again, or they
  // will just click the same stale row twice.
  const onActionError = (error: unknown) => {
    setMutationError(error);
    if (errorCode(error) === 'JOB_NO_LONGER_FAILED' || errorCode(error) === 'JOB_IDENTITY_MISMATCH') {
      queryClient.invalidateQueries({ queryKey: ['dlq'] });
    }
  };

  const requeue = useMutation({
    mutationFn: ({ row }: { row: DeadLetter }) => requeueDeadLetter(row.queue, row.id, row),
    onMutate: () => setMutationError(null),
    onError: onActionError,
    onSuccess: refresh,
  });
  // Discarding is permanent and a reconciled retry repeats a job that may have
  // half-finished: both are confirmed in the in-page panel, which runs the
  // request once and keeps a refusal in view. Whatever the answer, the list is
  // read again (a refusal often means the job moved on).
  const actions = useActionRunner();
  const discard = (row: DeadLetter) => void actions.run({
    title: `Permanently discard ${row.name}?`,
    body: <p>This job will never run. It is removed from the dead-letter list.</p>,
    confirmLabel: `Discard ${row.name}`,
    submit: ({ reason }) => discardDeadLetter(row.queue, row.id, row, reason),
    success: () => `${row.name} discarded.`,
  }).then((outcome) => { if (outcome) refresh(); });
  // [U58] A RECONCILE_FIRST job may have half-finished before it failed. The
  // server retries it only once the operator says they checked what that run
  // already did; the console never offered that, so these jobs could not be
  // retried at all. Two steps: the button names the precondition, the panel
  // repeats why and asks for the confirmation.
  const retryReconciled = (row: DeadLetter) => void actions.run({
    title: `Retry ${row.name} after reconciling it?`,
    body: (
      <>
        <p>{row.recovery?.why}</p>
        <p>Confirm you checked what the failed run already did (for example a payment or a message it sent), so one more run cannot repeat it.</p>
      </>
    ),
    reason: false,
    confirmLabel: 'I have reconciled it: retry',
    submit: () => requeueDeadLetter(row.queue, row.id, row, true),
    success: () => `${row.name} queued to run once more.`,
  }).then((outcome) => { if (outcome) refresh(); });

  const rows: DeadLetter[] = dlq.data?.data ?? [];
  const byQueue = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.queue] = (acc[row.queue] ?? 0) + 1;
    return acc;
  }, {});
  const queues = Object.keys(byQueue).sort();
  const visible = queueFilter ? rows.filter((r) => r.queue === queueFilter) : rows;
  const busy = requeue.isPending;

  // The queues live in the API process only when it runs them. When it does
  // not, the endpoint says so — and saying "no failed jobs" instead would be
  // reporting a system healthy on the strength of not being able to see it.
  const queuesOffline = errorCode(dlq.error) === 'QUEUES_OFFLINE';

  return (
    <div className="mc-page">
      <p className="mc-muted mb-4 max-w-3xl">
        Jobs that failed every retry and stopped. Billing, settlements, MMG polling, dispatch,
        notifications and search all run here — so a job sitting on this page is work the platform
        believes it did and did not.
      </p>

      {mutationError ? <div className="mb-4"><MutationError error={mutationError} label="job action" /></div> : null}
      {actions.banner}

      {dlq.isLoading ? (
        <div className="mc-loading" aria-busy="true">Loading failed jobs…</div>
      ) : queuesOffline ? (
        <div className="mc-card border-l-4 border-l-[var(--mc-warn)]">
          <p className="mc-text-warn font-semibold">This server is not running the queues.</p>
          <p className="mc-muted mt-2">
            The API answered, but background queues are not initialised on it, so it cannot tell you
            whether any job has died. This is not the same as no failures — check the process that
            owns the workers.
          </p>
          <button type="button" onClick={() => dlq.refetch()} className="mc-btn mt-3">
            Check again
          </button>
        </div>
      ) : dlq.isError ? (
        <div className="mc-card border-l-4 border-l-[var(--mc-bad)]" role="alert">
          <p className="mc-text-bad font-semibold">Could not load the failed jobs.</p>
          <p className="mc-muted mt-2">
            {dlq.error instanceof Error ? dlq.error.message : 'Unexpected error'}
          </p>
          <button type="button" onClick={() => dlq.refetch()} className="mc-btn mc-btn-primary mt-3">
            Try again
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="mc-empty">
          <p className="mc-card-title">No jobs have died.</p>
          <p className="mt-2 text-xs">
            Each queue keeps only its {RETAINED_PER_QUEUE} most recent failures, so this page shows
            what is still retained rather than everything that has ever failed. Admins are paged when
            a job dies, so an empty page here should follow an empty inbox.
          </p>
        </div>
      ) : (
        <>
          <div className="mc-tabs" role="group" aria-label="Queue">
            <button type="button" onClick={() => setQueueFilter(null)} aria-pressed={queueFilter === null} className="mc-tab">
              All ({rows.length})
            </button>
            {queues.map((q) => (
              <button key={q} type="button" onClick={() => setQueueFilter(q)} aria-pressed={queueFilter === q} className="mc-tab">
                {q} ({byQueue[q]})
              </button>
            ))}
          </div>

          {/* [A-08] This used to say "Retrying is safe: every Swift job is
              written to be idempotent" — of all 53 classes, as a fact nobody
              had established. Retry-safety is a property each class earns, and
              each row below says where its own class stands. */}
          <p className="mc-muted mb-3 text-xs">
            Retrying replays the job. Whether that is safe depends on the job — a class is only
            replayable once someone has established that re-running it cannot repeat an external
            effect, and each row says where its class stands. Discarding is permanent and means the
            work should never happen. Both actions are recorded in the audit log.
          </p>

          <div className="mc-list">
            {visible.map((row) => {
              const key = `${row.queue}:${row.id}`;
              return (
                <div key={key} className="mc-card">
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                    <span className={`mc-badge${MONEY_QUEUES.has(row.queue) ? ' mc-tone-bad' : ''}`}>
                      {row.queue}
                    </span>
                    <span className="mc-card-title mc-mono" style={{ fontSize: '.875rem' }}>{row.name}</span>
                    <span className="mc-muted text-xs">
                      gave up after {row.attemptsMade} attempt{row.attemptsMade === 1 ? '' : 's'}
                    </span>
                    <span className="mc-muted ml-auto text-xs">{ago(row.finishedOn)}</span>
                  </div>

                  <p className="mc-text-bad mt-2 break-words text-xs">
                    {row.failedReason || 'The job failed without recording a reason.'}
                  </p>

                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === key ? null : key)}
                    aria-expanded={expanded === key}
                    className="mc-link-button mt-2 text-xs"
                  >
                    {expanded === key ? 'Hide payload' : 'Show payload'}
                  </button>
                  {expanded === key ? (
                    <pre className="mc-mono mt-2 whitespace-pre-wrap break-all rounded-[var(--mc-radius-sm)] border border-[var(--mc-line)] bg-[var(--mc-surface)] p-3">
                      {row.data}
                    </pre>
                  ) : null}

                  {row.recovery?.policy === 'RECONCILE_FIRST' ? (
                    <p className="mc-note mc-note-warn mt-2 text-xs">
                      Reconcile first: {row.recovery.why}
                    </p>
                  ) : row.recovery && row.recovery.policy !== 'SAFE_REPLAY' ? (
                    <p className="mc-note mc-note-warn mt-2 text-xs">
                      Not replayable: {row.recovery.why}
                    </p>
                  ) : null}

                  <div className="mc-actions">
                    {row.recovery?.policy === 'RECONCILE_FIRST' ? (
                      <button type="button" disabled={busy} onClick={() => retryReconciled(row)} className="mc-btn mc-btn-primary">
                        I have reconciled it: retry
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy || (row.recovery ? row.recovery.policy !== 'SAFE_REPLAY' : false)}
                        title={row.recovery && row.recovery.policy !== 'SAFE_REPLAY' ? row.recovery.why : undefined}
                        onClick={() => requeue.mutate({ row })}
                        className="mc-btn mc-btn-primary"
                      >
                        Retry this job
                      </button>
                    )}

                    <button type="button" disabled={busy} onClick={() => discard(row)} className="mc-btn mc-btn-danger">
                      Discard
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
