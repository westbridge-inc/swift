'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { discardDeadLetter, errorCode, fetchDeadLetters, requeueDeadLetter, type DeadLetter } from '@/lib/api';
import { MutationError } from '@/components/MutationError';

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
  const [confirmingDiscard, setConfirmingDiscard] = useState<string | null>(null);
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
    setConfirmingDiscard(null);
    setMutationError(null);
  };

  // A 409 means this page is looking at a job that has since changed — someone
  // retried it, or the queue was recreated and the id now belongs to something
  // else. The list must be re-read before the operator decides again, or they
  // will just click the same stale row twice.
  const onActionError = (error: unknown) => {
    setMutationError(error);
    setConfirmingDiscard(null);
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
  const discard = useMutation({
    mutationFn: ({ row }: { row: DeadLetter }) => discardDeadLetter(row.queue, row.id, row),
    onMutate: () => setMutationError(null),
    onError: onActionError,
    onSuccess: refresh,
  });

  const rows: DeadLetter[] = dlq.data?.data ?? [];
  const byQueue = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.queue] = (acc[row.queue] ?? 0) + 1;
    return acc;
  }, {});
  const queues = Object.keys(byQueue).sort();
  const visible = queueFilter ? rows.filter((r) => r.queue === queueFilter) : rows;
  const busy = requeue.isPending || discard.isPending;

  // The queues live in the API process only when it runs them. When it does
  // not, the endpoint says so — and saying "no failed jobs" instead would be
  // reporting a system healthy on the strength of not being able to see it.
  const queuesOffline = errorCode(dlq.error) === 'QUEUES_OFFLINE';

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Background jobs</h1>
      <p className="text-[var(--muted)] mb-6 text-sm">
        Jobs that failed every retry and stopped. Billing, settlements, MMG polling, dispatch,
        notifications and search all run here — so a job sitting on this page is work the platform
        believes it did and did not.
      </p>

      {mutationError ? <MutationError error={mutationError} label="job action" /> : null}

      {dlq.isLoading ? (
        <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] divide-y divide-[var(--border)]">
          {[0, 1, 2].map((i) => (
            <div key={i} className="p-4 animate-pulse">
              <div className="h-3 w-40 bg-[var(--border)] rounded" />
              <div className="h-3 w-72 bg-[var(--border)] rounded mt-3" />
            </div>
          ))}
        </div>
      ) : queuesOffline ? (
        <div className="bg-[var(--panel)] rounded-xl border border-yellow-500/40 p-8 text-sm">
          <p className="font-semibold text-yellow-400">This server is not running the queues.</p>
          <p className="text-[var(--muted)] mt-2">
            The API answered, but background queues are not initialised on it, so it cannot tell you
            whether any job has died. This is not the same as no failures — check the process that
            owns the workers.
          </p>
          <button
            onClick={() => dlq.refetch()}
            className="mt-4 px-3 py-1.5 rounded-lg text-xs bg-[var(--panel)] border border-[var(--border)] text-[var(--muted)]"
          >
            Check again
          </button>
        </div>
      ) : dlq.isError ? (
        <div className="bg-[var(--panel)] rounded-xl border border-red-500/40 p-8 text-sm">
          <p className="font-semibold text-red-400">Could not load the failed jobs.</p>
          <p className="text-[var(--muted)] mt-2">
            {dlq.error instanceof Error ? dlq.error.message : 'Unexpected error'}
          </p>
          <button
            onClick={() => dlq.refetch()}
            className="mt-4 px-3 py-1.5 rounded-lg text-xs bg-[var(--accent)] text-white"
          >
            Try again
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-10 text-center text-sm">
          <p>No jobs have died.</p>
          <p className="text-[var(--muted)] mt-2 text-xs">
            Each queue keeps only its {RETAINED_PER_QUEUE} most recent failures, so this page shows
            what is still retained rather than everything that has ever failed. Admins are paged when
            a job dies, so an empty page here should follow an empty inbox.
          </p>
        </div>
      ) : (
        <>
          <div className="flex gap-2 mb-4 flex-wrap">
            <button
              onClick={() => setQueueFilter(null)}
              className={`px-3 py-1.5 rounded-lg text-xs ${
                queueFilter === null
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--panel)] text-[var(--muted)] border border-[var(--border)]'
              }`}
            >
              All ({rows.length})
            </button>
            {queues.map((q) => (
              <button
                key={q}
                onClick={() => setQueueFilter(q)}
                className={`px-3 py-1.5 rounded-lg text-xs ${
                  queueFilter === q
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--panel)] text-[var(--muted)] border border-[var(--border)]'
                }`}
              >
                {q} ({byQueue[q]})
              </button>
            ))}
          </div>

          {/* [A-08] This used to say "Retrying is safe: every Swift job is
              written to be idempotent" — of all 53 classes, as a fact nobody
              had established. Retry-safety is a property each class earns, and
              each row below says where its own class stands. */}
          <p className="text-[var(--muted)] text-xs mb-3">
            Retrying replays the job. Whether that is safe depends on the job — a class is only
            replayable once someone has established that re-running it cannot repeat an external
            effect, and each row says where its class stands. Discarding is permanent and means the
            work should never happen. Both actions are recorded in the audit log.
          </p>

          <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] divide-y divide-[var(--border)]">
            {visible.map((row) => {
              const key = `${row.queue}:${row.id}`;
              return (
                <div key={key} className="p-4">
                  <div className="flex items-start gap-3 flex-wrap">
                    <span
                      className={`px-2 py-0.5 rounded text-[11px] ${
                        MONEY_QUEUES.has(row.queue)
                          ? 'bg-red-500/20 text-red-400 font-semibold'
                          : 'bg-[var(--border)] text-[var(--muted)]'
                      }`}
                    >
                      {row.queue}
                    </span>
                    <span className="text-sm font-medium">{row.name}</span>
                    <span className="text-[11px] text-[var(--muted)]">
                      gave up after {row.attemptsMade} attempt{row.attemptsMade === 1 ? '' : 's'}
                    </span>
                    <span className="text-[11px] text-[var(--muted)] ml-auto">{ago(row.finishedOn)}</span>
                  </div>

                  <p className="text-xs text-red-400 mt-2 break-words">
                    {row.failedReason || 'The job failed without recording a reason.'}
                  </p>

                  <button
                    onClick={() => setExpanded(expanded === key ? null : key)}
                    className="text-[11px] text-[var(--muted)] underline mt-2"
                  >
                    {expanded === key ? 'Hide payload' : 'Show payload'}
                  </button>
                  {expanded === key ? (
                    <pre className="text-[11px] text-[var(--muted)] mt-2 whitespace-pre-wrap break-all bg-[var(--bg)] rounded-lg p-3 border border-[var(--border)]">
                      {row.data}
                    </pre>
                  ) : null}

                  {row.recovery && row.recovery.policy !== 'SAFE_REPLAY' ? (
                    <p className="mt-2 text-xs text-amber-400">
                      Not replayable: {row.recovery.why}
                    </p>
                  ) : null}

                  <div className="mt-3 flex gap-2 items-center flex-wrap">
                    <button
                      disabled={busy || (row.recovery ? row.recovery.policy !== 'SAFE_REPLAY' : false)}
                      title={row.recovery && row.recovery.policy !== 'SAFE_REPLAY' ? row.recovery.why : undefined}
                      onClick={() => requeue.mutate({ row })}
                      className="px-3 py-1.5 rounded-lg text-xs bg-[var(--accent)] text-white disabled:opacity-50"
                    >
                      Retry this job
                    </button>

                    {confirmingDiscard === key ? (
                      <>
                        <span className="text-xs text-red-400">
                          Discard permanently? This job will never run.
                        </span>
                        <button
                          disabled={busy}
                          onClick={() => discard.mutate({ row })}
                          className="px-3 py-1.5 rounded-lg text-xs bg-red-600 text-white disabled:opacity-50"
                        >
                          Yes, discard {row.name}
                        </button>
                        <button
                          onClick={() => setConfirmingDiscard(null)}
                          className="px-3 py-1.5 rounded-lg text-xs bg-[var(--panel)] border border-[var(--border)] text-[var(--muted)]"
                        >
                          Keep it
                        </button>
                      </>
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() => setConfirmingDiscard(key)}
                        className="px-3 py-1.5 rounded-lg text-xs bg-[var(--panel)] border border-red-500/40 text-red-400 disabled:opacity-50"
                      >
                        Discard
                      </button>
                    )}
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
