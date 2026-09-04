'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchUnmatchedPayments, fetchCashKpis, fetchCollections, fetchSettlementBatches,
  attachAgentPayment, flagAgentPaymentRefund, noteAgentPayment, recordCollectionContact,
} from '@/lib/api';
import {
  remedyFor, attachable, ageOf, formatSan, gyd, railHealth, outcomeOfThrown,
  contactProblem, REMEDY_COPY, TAB_COPY, COLLECTION_TABS, CONTACT_OUTCOMES,
  type UnmatchedPayment, type CashKpis, type CollectionTab, type ContactOutcome,
  type MoneyActionOutcome,
} from '@/lib/cashRail';

/**
 * [SAN spec Part 4] The agent-cash rail.
 *
 * Partners pay their weekly fee IN CASH at an MMG agent, quoting their SAN.
 * Money that resolves to nobody is HELD as UNMATCHED — never rejected, because
 * rejecting it would mean a partner paid and Swift has no record of the money.
 *
 * Sixteen routes ran this rail with no screen. The unmatched queue is the sharp
 * end: every row in it is a person who paid and is being treated as unpaid, and
 * with nothing able to attach a payment the queue could only grow.
 *
 * Every write here is C4 (money) and answers 202 APPROVAL_REQUIRED — a second
 * admin decides it in /approvals. That is shown as QUEUED, never as an error:
 * an operator who reads it as failure retries, and every retry files another
 * approval for the same payment.
 */
type Tab = 'unmatched' | 'collections' | 'batches';

const TONE: Record<'ok' | 'watch' | 'bad', string> = {
  ok: 'text-[var(--muted)]',
  watch: 'text-amber-500',
  bad: 'text-red-500',
};

export default function CashPage() {
  const [tab, setTab] = useState<Tab>('unmatched');
  const kpis = useQuery({ queryKey: ['cash-kpis'], queryFn: () => fetchCashKpis(30) });
  const unmatched = useQuery({
    queryKey: ['unmatched'],
    queryFn: fetchUnmatchedPayments,
    refetchInterval: 60_000,
  });

  const k: CashKpis | null = kpis.data?.data ?? null;
  const rows: UnmatchedPayment[] = unmatched.data?.data ?? [];
  const health = railHealth(k);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Cash rail</h1>
      <p className={`text-sm mb-6 ${TONE[health.state]}`}>{health.line}</p>

      {k && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Stat label="Unmatched now" value={String(k.unmatched.depth)} tone={k.unmatched.depth > 0 ? 'bad' : 'ok'} />
          <Stat label="Oldest unmatched" value={k.unmatched.oldestHours > 0 ? `${k.unmatched.oldestHours}h` : '—'} tone={k.unmatched.oldestHours >= 24 ? 'bad' : 'ok'} />
          <Stat label={`Collected (${k.windowDays}d)`} value={gyd(k.channelMix.reduce((n, c) => n + c.totalGyd, 0))} tone="ok" />
          <Stat
            label="Promises kept"
            value={k.collections.promiseKeptRate === null ? '—' : `${Math.round(k.collections.promiseKeptRate * 100)}%`}
            tone="ok"
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-6">
        {([
          ['unmatched', `Unmatched${rows.length ? ` (${rows.length})` : ''}`],
          ['collections', 'Collections'],
          ['batches', 'Settlement batches'],
        ] as Array<[Tab, string]>).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              tab === key ? 'bg-[var(--accent)] text-white font-semibold' : 'border border-[var(--border)] text-[var(--muted)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'unmatched' && <Unmatched rows={rows} loading={unmatched.isLoading} error={unmatched.error} />}
      {tab === 'collections' && <Collections />}
      {tab === 'batches' && <Batches />}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'bad' }) {
  return (
    <div className="bg-[var(--panel)] rounded-xl p-5 border border-[var(--border)]">
      <p className="text-[var(--muted)] text-sm">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${tone === 'bad' ? 'text-red-500' : ''}`}>{value}</p>
    </div>
  );
}

function Outcome({ outcome }: { outcome: MoneyActionOutcome }) {
  if (outcome.kind === 'error') return <p className="text-xs text-red-500 mt-2">{outcome.message}</p>;
  return (
    <p className={`text-xs mt-2 ${outcome.kind === 'queued' ? 'text-amber-500' : 'text-[var(--muted)]'}`}>
      {outcome.message}
      {outcome.approvalId && (
        <>
          {' '}
          <Link href="/approvals" className="underline">
            Open the approvals queue
          </Link>
        </>
      )}
    </p>
  );
}

function Unmatched({ rows, loading, error }: { rows: UnmatchedPayment[]; loading: boolean; error: unknown }) {
  if (loading) return <p className="text-[var(--muted)] text-sm">Loading the queue…</p>;
  if (error) return <p className="text-sm text-red-500">{(error as Error).message}</p>;
  if (rows.length === 0) {
    return <p className="text-[var(--muted)] text-sm">Every payment reached an account. Nothing is held.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => <UnmatchedCard key={row.id} row={row} />)}
    </div>
  );
}

function UnmatchedCard({ row }: { row: UnmatchedPayment }) {
  const qc = useQueryClient();
  const [subscriptionId, setSubscriptionId] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<MoneyActionOutcome | null>(null);
  const remedy = remedyFor(row);
  const age = ageOf(row);

  const done = () => {
    setOutcome({ kind: 'done', message: 'Recorded.' });
    qc.invalidateQueries({ queryKey: ['unmatched'] });
    qc.invalidateQueries({ queryKey: ['cash-kpis'] });
  };
  // A money write answers 202 APPROVAL_REQUIRED, which apiFetch THROWS. The
  // error path is therefore where "queued" is recognised, not the success path.
  const onErr = (e: unknown) => setOutcome(outcomeOfThrown(e));

  const attach = useMutation({
    mutationFn: () => attachAgentPayment(row.id, subscriptionId.trim(), reason.trim()),
    onSuccess: done, onError: onErr,
  });
  const flag = useMutation({
    mutationFn: () => flagAgentPaymentRefund(row.id, reason.trim()),
    onSuccess: done, onError: onErr,
  });
  const addNote = useMutation({
    mutationFn: () => noteAgentPayment(row.id, note.trim()),
    onSuccess: done, onError: onErr,
  });

  const busy = attach.isPending || flag.isPending || addNote.isPending;
  const reasonMissing = reason.trim().length < 5;

  return (
    <div className={`rounded-xl border p-5 bg-[var(--panel)] ${age === 'breached' ? 'border-red-500/60' : age === 'aging' ? 'border-amber-500/50' : 'border-[var(--border)]'}`}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-lg font-bold">{gyd(row.amount)}</span>
        <code className="text-sm">{formatSan(row.sanRaw)}</code>
        <span className="rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
          {row.channel.replaceAll('_', ' ').toLowerCase()}
        </span>
        <span className={`ml-auto text-xs ${age === 'breached' ? 'text-red-500' : age === 'aging' ? 'text-amber-500' : 'text-[var(--muted)]'}`}>
          {row.hoursOld}h held{age === 'breached' ? ' — past SLA' : ''}
        </span>
      </div>

      {/* The server's own reading of what went wrong, then what fixes it.
          Different questions: an operator working a queue needs the second. */}
      <p className="text-sm mb-1">{row.diagnosis}</p>
      <p className="text-xs text-[var(--muted)] mb-3">{REMEDY_COPY[remedy]}</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-[var(--muted)] mb-3">
        {row.payerMsisdn && <div><span className="block text-[10px] uppercase tracking-wide">Paid from</span><code>{row.payerMsisdn}</code></div>}
        {row.mmgTxnId && <div><span className="block text-[10px] uppercase tracking-wide">MMG txn</span><code>{row.mmgTxnId}</code></div>}
        {row.agentRef && <div><span className="block text-[10px] uppercase tracking-wide">Agent</span><code>{row.agentRef}</code></div>}
        <div><span className="block text-[10px] uppercase tracking-wide">Paid at</span>{new Date(row.paidAt).toLocaleString()}</div>
      </div>

      <div className="border-t border-[var(--border)] pt-3 flex flex-col gap-2">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why — kept on the record, and read by the second admin"
          className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
        />

        {attachable(row) ? (
          <div className="flex flex-wrap gap-2">
            <input
              value={subscriptionId}
              onChange={(e) => setSubscriptionId(e.target.value)}
              placeholder="Subscription id to credit"
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
            />
            <button
              disabled={busy || reasonMissing || !subscriptionId.trim()}
              onClick={() => attach.mutate()}
              className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              Attach
            </button>
          </div>
        ) : (
          // Not a disabled button: a control that exists and cannot be used
          // invites someone to find a way. This says why there is none.
          <p className="text-xs text-[var(--muted)]">
            This cannot be attached — {remedy === 'refund' ? 'the money belongs to nobody, so it goes back.' : 'the diagnosis is not one of the known ones. Look at the raw record first.'}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            disabled={busy || reasonMissing}
            onClick={() => flag.mutate()}
            className="rounded-lg border border-[var(--border)] px-4 py-1.5 text-sm disabled:opacity-40"
          >
            Flag for refund
          </button>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (applies immediately)"
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
          />
          <button
            disabled={busy || note.trim().length < 2}
            onClick={() => addNote.mutate()}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Add note
          </button>
        </div>

        {reasonMissing && <p className="text-xs text-[var(--muted)]">Attaching and refund-flagging move money, so both need a stated reason.</p>}
        {outcome && <Outcome outcome={outcome} />}
      </div>
    </div>
  );
}

function Collections() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<CollectionTab>('due72');
  const q = useQuery({ queryKey: ['collections', tab], queryFn: () => fetchCollections(tab) });
  const rows: Array<Record<string, unknown>> = q.data?.data ?? [];

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        {COLLECTION_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-2.5 py-1 rounded-lg text-xs ${tab === t ? 'bg-neutral-800 text-white' : 'border border-[var(--border)]'}`}
          >
            {TAB_COPY[t].label}
          </button>
        ))}
      </div>
      <p className="text-xs text-[var(--muted)] mb-4">{TAB_COPY[tab].meaning}</p>

      {q.isLoading && <p className="text-[var(--muted)] text-sm">Loading…</p>}
      {q.error && <p className="text-sm text-red-500">{(q.error as Error).message}</p>}
      {!q.isLoading && rows.length === 0 && <p className="text-[var(--muted)] text-sm">Nobody in this list.</p>}

      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <CollectionRow key={String(r['id'])} row={r} onLogged={() => qc.invalidateQueries({ queryKey: ['collections'] })} />
        ))}
      </div>
    </div>
  );
}

function CollectionRow({ row, onLogged }: { row: Record<string, unknown>; onLogged: () => void }) {
  const [outcome, setOutcome] = useState<ContactOutcome | ''>('');
  const [promisedDate, setPromisedDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = String(row['id'] ?? '');

  const log = useMutation({
    mutationFn: () =>
      recordCollectionContact(id, {
        outcome: outcome as string,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(promisedDate ? { promisedDate } : {}),
      }),
    onSuccess: () => { setError(null); setOutcome(''); setPromisedDate(''); setNote(''); onLogged(); },
    onError: (e) => setError((e as Error).message),
  });

  const problem = contactProblem(outcome, promisedDate);
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm mb-2">
        <span className="font-semibold">{String(row['type'] ?? 'Partner')}</span>
        <code className="text-xs">{id.slice(0, 12)}…</code>
        <span className="rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
          {String(row['status'] ?? '')}
        </span>
        {row['nextBillingDate'] ? (
          <span className="ml-auto text-xs text-[var(--muted)]">
            due {new Date(String(row['nextBillingDate'])).toLocaleDateString()}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as ContactOutcome)}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs"
        >
          <option value="">What happened…</option>
          {CONTACT_OUTCOMES.map((o) => <option key={o} value={o}>{o.replaceAll('_', ' ').toLowerCase()}</option>)}
        </select>
        {outcome === 'PROMISED' && (
          <input
            type="date"
            value={promisedDate}
            onChange={(e) => setPromisedDate(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs"
          />
        )}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note"
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]"
        />
        <button
          disabled={problem !== null || log.isPending}
          onClick={() => log.mutate()}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs disabled:opacity-40"
        >
          Log the call
        </button>
      </div>
      {outcome && problem && <p className="text-xs text-amber-500 mt-1">{problem}</p>}
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  );
}

function Batches() {
  const q = useQuery({ queryKey: ['settlement-batches'], queryFn: fetchSettlementBatches });
  const d = q.data?.data;
  const batches: Array<Record<string, unknown>> = d?.batches ?? [];

  if (q.isLoading) return <p className="text-[var(--muted)] text-sm">Loading…</p>;
  if (q.error) return <p className="text-sm text-red-500">{(q.error as Error).message}</p>;
  if (d && d.configured === false) {
    // An honest empty state. "No batches" would read as "everything settled".
    return (
      <p className="text-[var(--muted)] text-sm">
        Bank reconciliation is not configured, so no batches are being built. This list is empty because nothing is
        looking — not because everything has settled.
      </p>
    );
  }
  if (batches.length === 0) return <p className="text-[var(--muted)] text-sm">No settlement batches yet.</p>;

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="bg-[var(--panel)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <th className="text-left px-4 py-2">Period</th>
            <th className="text-left px-4 py-2">Gross</th>
            <th className="text-left px-4 py-2">Status</th>
            <th className="text-left px-4 py-2">Deposit</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={String(b['id'])} className="border-t border-[var(--border)]">
              <td className="px-4 py-2">{new Date(String(b['periodStart'])).toLocaleDateString()}</td>
              <td className="px-4 py-2 tabular-nums">{gyd(Number(b['grossGyd'] ?? 0))}</td>
              <td className="px-4 py-2">{String(b['status'] ?? '')}</td>
              <td className="px-4 py-2">
                {b['depositConfirmedAt'] ? new Date(String(b['depositConfirmedAt'])).toLocaleDateString() : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
