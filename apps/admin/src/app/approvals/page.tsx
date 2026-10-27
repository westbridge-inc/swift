'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchApprovals, decideApproval, applyApproval, startSoloApproval, cancelApproval, sendStepUpCode, verifyStepUpCode,
} from '@/lib/api';
import { MutationError } from '@/components/MutationError';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';
import {
  blockedBecause, BLOCK_COPY, minutesLeft, urgencyOf, describeAction,
  entityLabel, shortFingerprint, noteProblem, CLASS_MEANING, NOTE_MAX,
  canApply, awaitsRequester, snapshotEntries, soloWaitCopy, SOLO_EXPLAIN, needsStepUp,
  type ApprovalRow, personWords } from '@/lib/approvals';

const FILTERS = ['PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'EXPIRED', 'CANCELLED'] as const;

/**
 * [ADM-005] The second signature.
 *
 * A money (C4) or platform (C5) action takes two people. The first admin's
 * request returns 202 APPROVAL_REQUIRED and writes a PENDING row carrying what
 * was asked, by whom, with what reason, and a fingerprint over the exact
 * request. A second capable admin decides it here.
 *
 * 44 admin routes sit behind that gate — every settlement, fee waiver, top-up,
 * invoice, price change and algorithm switch. Until this page existed the queue
 * had no screen at all, so all 44 could be ASKED FOR and none could be
 * completed. The control was real and the counter-signature was unreachable.
 */
export default function ApprovalsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('PENDING');
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['approvals', filter],
    queryFn: () => fetchApprovals(filter),
    // Someone is blocked at the other end of every pending row.
    refetchInterval: 30_000,
  });

  const rows: ApprovalRow[] = data?.data ?? [];
  const pending = rows.filter((r) => r.status === 'PENDING');
  const mine = pending.filter((r) => r.isOwnRequest).length;

  return (
    <div className="mc-page">
      <p className="mc-muted text-sm mb-6">
        A money or platform action takes two people. Someone is waiting on every pending row — until it is
        decided, the action they asked for has not happened.
      </p>

      <div className="flex flex-wrap gap-2 mb-6">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className="mc-tab"
          >
            {f.charAt(0) + f.slice(1).toLowerCase()}
            {f === 'PENDING' && pending.length > 0 ? ` (${pending.length})` : ''}
          </button>
        ))}
      </div>

      {mine > 0 && filter === 'PENDING' && (
        <div className="mb-4 rounded-[var(--mc-radius)] border border-[var(--mc-line)] bg-[var(--mc-card)] p-4 text-sm">
          {mine === 1 ? 'One of these is your own request' : `${mine} of these are your own requests`} — you
          cannot sign for yourself. Someone else has to look, unless you are the only admin who can (solo approval, below).
        </div>
      )}

      {isLoading && <p className="mc-muted text-sm">Loading the queue…</p>}
      {/* [U26] A failed read is never "Nothing is waiting": someone may be. */}
      {isError && <QueryFailed error={error} what="the approvals queue" onRetry={() => void refetch()} retrying={isFetching} />}
      {!isLoading && !isError && rows.length === 0 && (
        <p className="mc-muted text-sm">
          {filter === 'PENDING' ? 'Nothing is waiting on a second signature.' : 'Nothing in this view.'}
        </p>
      )}

      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <ApprovalCard key={row.id} row={row} onDecided={() => qc.invalidateQueries({ queryKey: ['approvals'] })} />
        ))}
      </div>
    </div>
  );
}

function ApprovalCard({ row, onDecided }: { row: ApprovalRow; onDecided: () => void }) {
  const [note, setNote] = useState('');
  const [intent, setIntent] = useState<'approve' | 'reject' | null>(null);
  const blocked = blockedBecause(row);
  const urgency = urgencyOf(row);
  const left = minutesLeft(row);

  const decide = useMutation({
    mutationFn: (approve: boolean) => decideApproval(row.id, approve, note.trim()),
    onSuccess: onDecided,
  });
  // [U63] Executing replays an approved money or platform action: one click
  // used to run it. The panel names the action and the record first.
  const actions = useActionRunner(onDecided);
  const execute = () => void actions.run({
    title: `Execute: ${describeAction(row.action)}?`,
    body: (
      <>
        <p>{entityLabel(row) ? `Record ${entityLabel(row)}. ` : ''}This runs the approved request now, exactly as shown on the card. It cannot be undone from here.</p>
        {snapshotEntries(row).length > 0 ? (
          <ul>{snapshotEntries(row).map((entry) => <li key={entry.label}>{entry.label}: {entry.value}</li>)}</ul>
        ) : null}
      </>
    ),
    confirmLabel: 'Execute it',
    reason: false,
    submit: () => applyApproval(row.id),
    success: () => 'Executed.',
  });

  const problem = intent ? noteProblem(note, intent === 'approve') : null;

  return (
    <div
      className={`rounded-[var(--mc-radius)] border p-5 bg-[var(--mc-card)] ${
        urgency === 'expired' || row.status === 'EXPIRED'
          ? 'border-[var(--mc-line)] opacity-70'
          : urgency === 'soon' && row.status === 'PENDING'
            ? 'border-[var(--mc-warn)]'
            : 'border-[var(--mc-line)]'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="rounded-md bg-[var(--mc-accent)] px-2 py-0.5 text-xs font-bold text-white">{row.cls}</span>
        <span className="text-sm font-semibold">{describeAction(row.action)}</span>
        <span className="rounded-md border border-[var(--mc-line)] px-1.5 py-0.5 text-xs mc-muted">
          {row.status}
        </span>
        {row.status === 'PENDING' && (
          <span className={`ml-auto text-xs ${urgency === 'expired' ? 'mc-text-bad' : urgency === 'soon' ? 'mc-text-warn' : 'mc-muted'}`}>
            {left > 0 ? `${left} min left` : 'expired'}
          </span>
        )}
      </div>

      <p className="text-xs mc-muted mb-3">{CLASS_MEANING[row.cls] ?? row.cls}</p>

      {/* The reason is the whole point of the second person: it is what they
          are here to read, so it is the largest thing on the card. */}
      <blockquote className="border-l-2 border-[var(--mc-accent)] pl-3 mb-3">
        <p className="text-sm">{row.reason}</p>
        <p className="text-xs mc-muted mt-1">
          asked by {personWords(row.requestedByName, row.requestedBy)}
          {row.isOwnRequest ? ' (you)' : ''} · {new Date(row.createdAt).toLocaleString()}
        </p>
      </blockquote>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs mc-muted mb-3">
        <div><span className="block text-xs uppercase tracking-wide">Capability</span><code>{row.capability}</code></div>
        {entityLabel(row) && (
          <div><span className="block text-xs uppercase tracking-wide">Record</span><code>{entityLabel(row)}</code></div>
        )}
        {/* The fingerprint covers the method, route, params AND body, so an
            approved settlement cannot be re-aimed at a different beneficiary
            or amount afterwards. It is the approver's proof that what they
            sign is what happens. */}
        <div><span className="block text-xs uppercase tracking-wide">Signed over</span><code>{shortFingerprint(row.fingerprint)}</code></div>
      </div>

      {/* [DS110-13] What the approver is signing: the stored body, field by
          field. This is the same stored value `apply` replays, bound by the
          fingerprint above — nothing not shown here can execute. */}
      {snapshotEntries(row).length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs mb-3">
          {snapshotEntries(row).map((entry) => (
            <div key={entry.label} className="rounded-lg border border-[var(--mc-line)] bg-[var(--mc-card)] p-2">
              <span className="block text-xs uppercase tracking-wide mc-muted">{entry.label}</span>
              <code className="break-all mc-muted">{entry.value}</code>
            </div>
          ))}
        </div>
      )}

      {row.status === 'APPROVED' && !row.bodySnapshot && (
        <p className="text-xs mc-text-warn mb-3">
          This request predates body capture, so it cannot be executed. The requester must ask again — the
          new request stores its body and can be applied.
        </p>
      )}

      {row.decidedAt && (
        <p className="text-xs mc-muted mb-2">
          {row.status.toLowerCase()} by {personWords(row.approvedByName, row.approvedBy)} · {new Date(row.decidedAt).toLocaleString()}
          {row.decisionNote ? ` — “${row.decisionNote}”` : ''}
        </p>
      )}

      {actions.banner}
      {canApply(row) && (
        <div className="border-t border-[var(--mc-line)] pt-3 mb-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={execute}
              className="mc-btn mc-btn-primary"
            >
              Execute the approved action
            </button>
            <span className="mc-muted text-xs">
              Replays exactly the body shown above — the fingerprint check refuses anything else.
            </span>
          </div>
        </div>
      )}

      {awaitsRequester(row) && (
        <p className="text-xs mc-muted border-t border-[var(--mc-line)] pt-3 mb-3">
          Approved. Only the admin who asked can execute it.
        </p>
      )}

      {row.isOwnRequest && row.status === 'PENDING' && <SoloPanel row={row} onChanged={onDecided} />}

      {row.decidedSolo && (
        <p className="text-xs mc-muted mb-2">Approved in solo mode (the only admin, after the wait, with a sign-in code).</p>
      )}

      {blocked ? (
        // [DS1111 S4] Your own request explains itself in its solo panel while
        // pending; once decided there is nothing left for you to sign.
        blocked === 'own-request' ? null : (
          <p className="text-xs mc-muted border-t border-[var(--mc-line)] pt-3">{BLOCK_COPY[blocked]}</p>
        )
      ) : (
        <div className="border-t border-[var(--mc-line)] pt-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={NOTE_MAX}
            aria-label="Your decision note"
            placeholder="Why do you agree, or why are you refusing? Required — it is kept on the record."
            className="mc-input"
          />
          {problem && <p className="text-xs mc-text-bad mt-1">{problem}</p>}
          <div className="flex flex-wrap gap-2 mt-2">
            <button
              disabled={decide.isPending}
              onMouseEnter={() => setIntent('approve')}
              onFocus={() => setIntent('approve')}
              onClick={() => { setIntent('approve'); if (!noteProblem(note, true)) decide.mutate(true); }}
              className="mc-btn mc-btn-primary"
            >
              Approve
            </button>
            <button
              disabled={decide.isPending}
              onMouseEnter={() => setIntent('reject')}
              onFocus={() => setIntent('reject')}
              onClick={() => { setIntent('reject'); if (!noteProblem(note, false)) decide.mutate(false); }}
              className="mc-btn"
            >
              Refuse
            </button>
          </div>
          {decide.error && (
            <div className="mt-2">
              <MutationError error={decide.error} label="The decision did not record" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * [OWNER #13] Your own pending request: solo approval while you are the only
 * admin who can approve it, and Cancel. The server checks every condition again
 * (only the owner, only while alone, the wait, a fresh sign-in code, the
 * emails); this panel only shows where the request stands.
 */
function SoloPanel({ row, onChanged }: { row: ApprovalRow; onChanged: () => void }) {
  const solo = row.solo ?? null;
  const [note, setNote] = useState('');
  const [code, setCode] = useState('');
  const [askCode, setAskCode] = useState(false);

  const start = useMutation({ mutationFn: () => startSoloApproval(row.id), onSuccess: onChanged });
  // [S4] Cancelling withdraws the ask: confirmed in the panel, not one click.
  const actions = useActionRunner(onChanged);
  const cancelAsk = () => void actions.run({
    title: 'Cancel this request?',
    body: <p>{describeAction(row.action)} will not happen. To do it later, ask again and a second admin decides again.</p>,
    confirmLabel: 'Cancel the request',
    dismissLabel: 'Keep the request',
    reason: false,
    submit: () => cancelApproval(row.id),
    success: () => 'Request cancelled. Nothing happened.',
  });
  const decide = useMutation({
    mutationFn: () => decideApproval(row.id, true, note.trim()),
    onSuccess: onChanged,
    onError: (error) => { if (needsStepUp(error)) setAskCode(true); },
  });
  const send = useMutation({ mutationFn: () => sendStepUpCode() });
  const verify = useMutation({
    mutationFn: () => verifyStepUpCode(code.trim()),
    // The code is good for this one decision: send it straight away.
    onSuccess: () => { setAskCode(false); setCode(''); decide.mutate(); },
  });

  const problem = noteProblem(note, true);

  return (
    <div className="border-t border-[var(--mc-line)] pt-3 mb-3 flex flex-col gap-2 text-sm">
      {solo?.state === 'unavailable' && <p className="mc-muted text-xs">{BLOCK_COPY['own-request']} {solo.message}</p>}
      {!solo && <p className="mc-muted text-xs">{BLOCK_COPY['own-request']}</p>}

      {solo?.state === 'available' && (
        <div className="flex flex-col gap-2">
          <p className="mc-muted text-xs">{SOLO_EXPLAIN(solo.coolOffHours)}</p>
          <div>
            <button
              disabled={start.isPending}
              onClick={() => start.mutate()}
              className="mc-btn"
            >
              {start.isPending ? 'Starting…' : 'Start the wait to approve it myself'}
            </button>
          </div>
          {start.error && <MutationError error={start.error} label="Solo approval did not start" />}
        </div>
      )}

      {(solo?.state === 'waiting' || solo?.state === 'ready') && (
        <p className="font-semibold">{soloWaitCopy(solo.availableAt)}</p>
      )}
      {solo?.state === 'waiting' && (
        <p className="mc-muted text-xs">Nothing happens during the wait. If you did not ask for this, cancel it now.</p>
      )}

      {solo?.state === 'ready' && (
        <div className="flex flex-col gap-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={NOTE_MAX}
            aria-label="Why it is still right after the wait"
            placeholder="Why it is still right after the wait. Required — it is kept on the record."
            className="mc-input"
          />
          {note.length > 0 && problem && <p className="text-xs mc-text-bad">{problem}</p>}
          <div>
            <button
              disabled={decide.isPending || !!problem}
              onClick={() => decide.mutate()}
              className="mc-btn mc-btn-primary"
            >
              {decide.isPending ? 'Approving…' : 'Approve it myself'}
            </button>
          </div>
          {decide.error && !askCode && <MutationError error={decide.error} label="The solo approval did not record" />}
        </div>
      )}

      {askCode && (
        <div className="rounded-lg border border-[var(--mc-line)] bg-[var(--mc-card)] p-3 flex flex-col gap-2">
          <p className="font-semibold">Confirm it is you</p>
          <p className="mc-muted text-xs">We text a 6-digit code to the phone on your admin account. It approves this one request.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              disabled={send.isPending}
              onClick={() => send.mutate()}
              className="rounded-lg border border-[var(--mc-line)] px-3 py-1.5 text-sm disabled:opacity-40"
            >
              {send.isSuccess ? 'Send a new code' : 'Send me a code'}
            </button>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Sign-in code"
              placeholder="6-digit code"
              className="w-32 rounded-lg border border-[var(--mc-line)] bg-[var(--mc-card)] px-2 py-1.5 text-sm"
            />
            <button
              disabled={verify.isPending || code.trim().length !== 6}
              onClick={() => verify.mutate()}
              className="mc-btn mc-btn-primary"
            >
              Confirm and approve
            </button>
          </div>
          {send.isSuccess && <p className="mc-muted text-xs">Code sent.</p>}
          {send.error && <MutationError error={send.error} label="The code was not sent" />}
          {verify.error && <MutationError error={verify.error} label="That code did not work" />}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={cancelAsk}
          className="rounded-lg border border-[var(--mc-line)] px-3 py-1 text-xs mc-muted disabled:opacity-40"
        >
          Cancel this request
        </button>
      </div>
      {actions.banner}
    </div>
  );
}
