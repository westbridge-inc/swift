'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchApprovals, decideApproval } from '@/lib/api';
import { MutationError } from '@/components/MutationError';
import {
  blockedBecause, BLOCK_COPY, minutesLeft, urgencyOf, describeAction,
  entityLabel, shortFingerprint, noteProblem, CLASS_MEANING, NOTE_MAX,
  type ApprovalRow,
} from '@/lib/approvals';

const FILTERS = ['PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'EXPIRED'] as const;

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
  const { data, isLoading, error } = useQuery({
    queryKey: ['approvals', filter],
    queryFn: () => fetchApprovals(filter),
    // Someone is blocked at the other end of every pending row.
    refetchInterval: 30_000,
  });

  const rows: ApprovalRow[] = data?.data ?? [];
  const pending = rows.filter((r) => r.status === 'PENDING');
  const mine = pending.filter((r) => r.isOwnRequest).length;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Approvals</h1>
      <p className="text-[var(--muted)] text-sm mb-6">
        A money or platform action takes two people. Someone is waiting on every pending row — until it is
        decided, the action they asked for has not happened.
      </p>

      <div className="flex flex-wrap gap-2 mb-6">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              filter === f
                ? 'bg-[var(--accent)] text-white font-semibold'
                : 'border border-[var(--border)] text-[var(--muted)]'
            }`}
          >
            {f.charAt(0) + f.slice(1).toLowerCase()}
            {f === 'PENDING' && pending.length > 0 ? ` (${pending.length})` : ''}
          </button>
        ))}
      </div>

      {mine > 0 && filter === 'PENDING' && (
        <div className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 text-sm">
          {mine === 1 ? 'One of these is your own request' : `${mine} of these are your own requests`} — you
          cannot sign for yourself. Someone else has to look.
        </div>
      )}

      {isLoading && <p className="text-[var(--muted)] text-sm">Loading the queue…</p>}
      {error && <p className="text-sm text-red-500">{(error as Error).message}</p>}
      {!isLoading && rows.length === 0 && (
        <p className="text-[var(--muted)] text-sm">
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

  const problem = intent ? noteProblem(note, intent === 'approve') : null;

  return (
    <div
      className={`rounded-xl border p-5 bg-[var(--panel)] ${
        urgency === 'expired' || row.status === 'EXPIRED'
          ? 'border-[var(--border)] opacity-70'
          : urgency === 'soon' && row.status === 'PENDING'
            ? 'border-amber-500/60'
            : 'border-[var(--border)]'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="rounded-md bg-[var(--accent)] px-2 py-0.5 text-xs font-bold text-white">{row.cls}</span>
        <span className="text-sm font-semibold">{describeAction(row.action)}</span>
        <span className="rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
          {row.status}
        </span>
        {row.status === 'PENDING' && (
          <span className={`ml-auto text-xs ${urgency === 'expired' ? 'text-red-500' : urgency === 'soon' ? 'text-amber-500' : 'text-[var(--muted)]'}`}>
            {left > 0 ? `${left} min left` : 'expired'}
          </span>
        )}
      </div>

      <p className="text-xs text-[var(--muted)] mb-3">{CLASS_MEANING[row.cls] ?? row.cls}</p>

      {/* The reason is the whole point of the second person: it is what they
          are here to read, so it is the largest thing on the card. */}
      <blockquote className="border-l-2 border-[var(--accent)] pl-3 mb-3">
        <p className="text-sm">{row.reason}</p>
        <p className="text-xs text-[var(--muted)] mt-1">
          asked by {row.requestedBy}
          {row.isOwnRequest ? ' (you)' : ''} · {new Date(row.createdAt).toLocaleString()}
        </p>
      </blockquote>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-[var(--muted)] mb-3">
        <div><span className="block text-[10px] uppercase tracking-wide">Capability</span><code>{row.capability}</code></div>
        {entityLabel(row) && (
          <div><span className="block text-[10px] uppercase tracking-wide">Record</span><code>{entityLabel(row)}</code></div>
        )}
        {/* The fingerprint covers the method, route, params AND body, so an
            approved settlement cannot be re-aimed at a different beneficiary
            or amount afterwards. It is the approver's proof that what they
            sign is what happens. */}
        <div><span className="block text-[10px] uppercase tracking-wide">Signed over</span><code>{shortFingerprint(row.fingerprint)}</code></div>
      </div>

      {row.decidedAt && (
        <p className="text-xs text-[var(--muted)] mb-2">
          {row.status.toLowerCase()} by {row.approvedBy} · {new Date(row.decidedAt).toLocaleString()}
          {row.decisionNote ? ` — “${row.decisionNote}”` : ''}
        </p>
      )}

      {blocked ? (
        <p className="text-xs text-[var(--muted)] border-t border-[var(--border)] pt-3">{BLOCK_COPY[blocked]}</p>
      ) : (
        <div className="border-t border-[var(--border)] pt-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={NOTE_MAX}
            placeholder="Why do you agree, or why are you refusing? Required — it is kept on the record."
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
          />
          {problem && <p className="text-xs text-red-500 mt-1">{problem}</p>}
          <div className="flex flex-wrap gap-2 mt-2">
            <button
              disabled={decide.isPending}
              onMouseEnter={() => setIntent('approve')}
              onFocus={() => setIntent('approve')}
              onClick={() => { setIntent('approve'); if (!noteProblem(note, true)) decide.mutate(true); }}
              className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              Approve
            </button>
            <button
              disabled={decide.isPending}
              onMouseEnter={() => setIntent('reject')}
              onFocus={() => setIntent('reject')}
              onClick={() => { setIntent('reject'); if (!noteProblem(note, false)) decide.mutate(false); }}
              className="rounded-lg border border-[var(--border)] px-4 py-1.5 text-sm disabled:opacity-40"
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
