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
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { gyDate, gyDateTime } from '@/lib/dates';

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
  ok: 'mc-muted',
  watch: 'mc-text-warn',
  bad: 'mc-text-bad',
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
    <div className="mc-page">
      {kpis.isError ? (
        // A failed read is never "No figures yet": the rail's health is unknown.
        <QueryFailed error={kpis.error} what="the cash rail figures" onRetry={() => void kpis.refetch()} retrying={kpis.isFetching} className="mb-6" />
      ) : kpis.isLoading ? (
        <p className="text-sm mb-6 mc-muted">Loading…</p>
      ) : (
        <p className={`text-sm mb-6 ${TONE[health.state]}`}>{health.line}</p>
      )}

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
            type="button"
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className="mc-tab"
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'unmatched' && (
        <Unmatched rows={rows} loading={unmatched.isLoading} error={unmatched.error}
          onRetry={() => void unmatched.refetch()} retrying={unmatched.isFetching} />
      )}
      {tab === 'collections' && <Collections />}
      {tab === 'batches' && <Batches />}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'bad' }) {
  return (
    <div className="bg-[var(--mc-card)] rounded-[var(--mc-radius)] p-5 border border-[var(--mc-line)]">
      <p className="mc-muted text-sm">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${tone === 'bad' ? 'mc-text-bad' : ''}`}>{value}</p>
    </div>
  );
}

function Outcome({ outcome }: { outcome: MoneyActionOutcome }) {
  if (outcome.kind === 'error') return <p className="text-xs mc-text-bad mt-2">{outcome.message}</p>;
  return (
    <p className={`text-xs mt-2 ${outcome.kind === 'queued' ? 'mc-text-warn' : 'mc-muted'}`}>
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

function Unmatched({ rows, loading, error, onRetry, retrying }: {
  rows: UnmatchedPayment[]; loading: boolean; error: unknown; onRetry: () => void; retrying: boolean;
}) {
  if (loading) return <p className="mc-muted text-sm">Loading the queue…</p>;
  // [U64] A failed read says so, with Retry: never the raw transport text alone.
  if (error) return <QueryFailed error={error} what="the unmatched payments" onRetry={onRetry} retrying={retrying} />;
  if (rows.length === 0) {
    return <p className="mc-muted text-sm">Every payment reached an account. Nothing is held.</p>;
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
  const [note, setNote] = useState('');
  const [noteOutcome, setNoteOutcome] = useState<MoneyActionOutcome | null>(null);
  // [U08] Attach and Flag are C4: the first answer is a second admin's approval.
  // Once one is queued the card is LOCKED; every further press used to file
  // another approval for the same payment.
  const [queued, setQueued] = useState<null | 'attach' | 'flag'>(null);
  const remedy = remedyFor(row);
  const age = ageOf(row);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['unmatched'] });
    qc.invalidateQueries({ queryKey: ['cash-kpis'] });
  };
  const actions = useActionRunner(refresh);
  const subject = `${gyd(row.amount)} paid with ${formatSan(row.sanRaw)}`;

  const attach = async () => {
    const target = subscriptionId.trim();
    const outcome = await actions.run({
      title: `Attach ${gyd(row.amount)} to subscription ${target}?`,
      body: <p>The payment ({subject}) is credited to that subscription once a second admin approves. Check the id against the partner&apos;s record first.</p>,
      confirmLabel: 'Attach payment',
      reason: { label: 'Why this subscription', hint: 'Kept on the record and read by the second admin.' },
      submit: ({ reason }) => attachAgentPayment(row.id, target, reason),
      success: () => 'Attached. The partner is credited.',
    });
    if (outcome?.tone === 'queued') setQueued('attach');
  };
  const flag = async () => {
    const outcome = await actions.run({
      title: `Flag ${gyd(row.amount)} for refund?`,
      body: <p>The payment ({subject}) goes back to the person who paid it once a second admin approves.</p>,
      confirmLabel: 'Flag for refund',
      reason: { label: 'Why it goes back', hint: 'Kept on the record and read by the second admin.' },
      submit: ({ reason }) => flagAgentPaymentRefund(row.id, reason),
      success: () => 'Flagged for refund.',
    });
    if (outcome?.tone === 'queued') setQueued('flag');
  };
  const addNote = useMutation({
    mutationFn: () => noteAgentPayment(row.id, note.trim()),
    onSuccess: () => { setNoteOutcome({ kind: 'done', message: 'Note added.' }); setNote(''); refresh(); },
    onError: (e: unknown) => setNoteOutcome(outcomeOfThrown(e)),
  });

  return (
    <div className={`rounded-[var(--mc-radius)] border p-5 bg-[var(--mc-card)] ${age === 'breached' ? 'border-[var(--mc-bad)]' : age === 'aging' ? 'border-[var(--mc-warn)]' : 'border-[var(--mc-line)]'}`}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-lg font-bold">{gyd(row.amount)}</span>
        <code className="text-sm">{formatSan(row.sanRaw)}</code>
        <span className="rounded-md border border-[var(--mc-line)] px-1.5 py-0.5 text-xs mc-muted">
          {row.channel.replaceAll('_', ' ').toLowerCase()}
        </span>
        <span className={`ml-auto text-xs ${age === 'breached' ? 'mc-text-bad' : age === 'aging' ? 'mc-text-warn' : 'mc-muted'}`}>
          {row.hoursOld}h held{age === 'breached' ? ' — past SLA' : ''}
        </span>
      </div>

      {/* The server's own reading of what went wrong, then what fixes it.
          Different questions: an operator working a queue needs the second. */}
      <p className="text-sm mb-1">{row.diagnosis}</p>
      <p className="text-xs mc-muted mb-3">{REMEDY_COPY[remedy]}</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mc-muted mb-3">
        {row.payerMsisdn && <div><span className="block text-xs uppercase tracking-wide">Paid from</span><code>{row.payerMsisdn}</code></div>}
        {row.mmgTxnId && <div><span className="block text-xs uppercase tracking-wide">MMG txn</span><code>{row.mmgTxnId}</code></div>}
        {row.agentRef && <div><span className="block text-xs uppercase tracking-wide">Agent</span><code>{row.agentRef}</code></div>}
        <div><span className="block text-xs uppercase tracking-wide">Paid at</span>{gyDateTime(row.paidAt)}</div>
      </div>

      <div className="border-t border-[var(--mc-line)] pt-3 flex flex-col gap-2">
        {actions.banner}
        {queued ? (
          <p role="status" className="text-xs mc-text-warn">
            {queued === 'attach' ? 'Attaching' : 'Refund-flagging'} this payment is waiting for a second admin&apos;s approval. Nothing has moved yet.
            Do not ask again: once approved, apply it from <Link href="/approvals" className="underline">Approvals</Link>.
          </p>
        ) : null}

        {attachable(row) ? (
          <div className="flex flex-wrap gap-2">
            <input
              value={subscriptionId}
              onChange={(e) => setSubscriptionId(e.target.value)}
              disabled={queued !== null}
              aria-label="Subscription id to credit"
              placeholder="Subscription id to credit"
              className="min-w-0 flex-1 rounded-lg border border-[var(--mc-line)] bg-[var(--mc-card)] px-2 py-1.5 text-sm outline-none"
            />
            <button
              type="button"
              disabled={queued !== null || !subscriptionId.trim()}
              onClick={() => void attach()}
              className="mc-btn mc-btn-primary"
            >
              Attach
            </button>
          </div>
        ) : (
          // Not a disabled button: a control that exists and cannot be used
          // invites someone to find a way. This says why there is none.
          <p className="mc-muted text-xs">
            This cannot be attached — {remedy === 'refund' ? 'the money belongs to nobody, so it goes back.' : 'the diagnosis is not one of the known ones. Look at the raw record first.'}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={queued !== null}
            onClick={() => void flag()}
            className="mc-btn"
          >
            Flag for refund
          </button>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Note on this payment"
            placeholder="Note (applies immediately)"
            className="min-w-0 flex-1 rounded-lg border border-[var(--mc-line)] bg-[var(--mc-card)] px-2 py-1.5 text-sm outline-none"
          />
          <button
            type="button"
            disabled={addNote.isPending || note.trim().length < 2}
            onClick={() => addNote.mutate()}
            className="rounded-lg border border-[var(--mc-line)] px-3 py-1.5 text-sm disabled:opacity-40"
          >
            {addNote.isPending ? 'Adding…' : 'Add note'}
          </button>
        </div>

        <p className="mc-muted text-xs">Attaching and refund-flagging move money: each asks why, and a second admin approves it.</p>
        {noteOutcome && <Outcome outcome={noteOutcome} />}
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
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className="mc-tab"
          >
            {TAB_COPY[t].label}
          </button>
        ))}
      </div>
      <p className="text-xs mc-muted mb-4">{TAB_COPY[tab].meaning}</p>

      {q.isLoading && <p className="mc-muted text-sm">Loading…</p>}
      {/* [U27] A failed read is never "Nobody in this list". */}
      {q.isError && <QueryFailed error={q.error} what="this collections list" onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {!q.isLoading && !q.isError && rows.length === 0 && <p className="mc-muted text-sm">Nobody in this list.</p>}

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
    <div className="rounded-[var(--mc-radius)] border border-[var(--mc-line)] bg-[var(--mc-card)] p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm mb-2">
        <span className="font-semibold">{String(row['type'] ?? 'Partner')}</span>
        <code className="text-xs">{id.slice(0, 12)}…</code>
        <span className="rounded-md border border-[var(--mc-line)] px-1.5 py-0.5 text-xs mc-muted">
          {String(row['status'] ?? '')}
        </span>
        {row['nextBillingDate'] ? (
          <span className="ml-auto text-xs mc-muted">
            due {gyDate(String(row['nextBillingDate']))}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as ContactOutcome)}
          aria-label="What happened on this contact"
          className="rounded-lg border border-[var(--mc-line)] bg-[var(--mc-card)] px-2 py-1.5 text-xs"
        >
          <option value="">What happened…</option>
          {CONTACT_OUTCOMES.map((o) => <option key={o} value={o}>{o.replaceAll('_', ' ').toLowerCase()}</option>)}
        </select>
        {outcome === 'PROMISED' && (
          <input
            type="date"
            aria-label="Date they promised to pay"
            value={promisedDate}
            onChange={(e) => setPromisedDate(e.target.value)}
            className="rounded-lg border border-[var(--mc-line)] bg-[var(--mc-card)] px-2 py-1.5 text-xs"
          />
        )}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-label="Note on this contact"
          placeholder="Note"
          className="min-w-0 flex-1 rounded-lg border border-[var(--mc-line)] bg-[var(--mc-card)] px-2 py-1.5 text-xs outline-none"
        />
        <button
          type="button"
          disabled={problem !== null || log.isPending}
          onClick={() => log.mutate()}
          className="rounded-lg border border-[var(--mc-line)] px-3 py-1.5 text-xs disabled:opacity-40"
        >
          {log.isPending ? 'Logging…' : 'Log contact'}
        </button>
      </div>
      {outcome && problem && <p className="text-xs mc-text-warn mt-1">{problem}</p>}
      {error && <p className="text-xs mc-text-bad mt-1">{error}</p>}
    </div>
  );
}

function Batches() {
  const q = useQuery({ queryKey: ['settlement-batches'], queryFn: fetchSettlementBatches });
  const d = q.data?.data;
  const batches: Array<Record<string, unknown>> = d?.batches ?? [];

  if (q.isLoading) return <p className="mc-muted text-sm">Loading…</p>;
  // [U64] A failed read says so, with Retry.
  if (q.isError) return <QueryFailed error={q.error} what="the settlement batches" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  if (d && d.configured === false) {
    // An honest empty state. "No batches" would read as "everything settled".
    return (
      <p className="mc-muted text-sm">
        Bank reconciliation is not configured, so no batches are being built. This list is empty because nothing is
        looking — not because everything has settled.
      </p>
    );
  }
  if (batches.length === 0) return <p className="mc-muted text-sm">No settlement batches yet.</p>;

  return (
    <div className="overflow-x-auto rounded-[var(--mc-radius)] border border-[var(--mc-line)]">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="bg-[var(--mc-card)] mc-muted text-xs uppercase tracking-wide">
            <th className="text-left px-4 py-2">Period</th>
            <th className="text-left px-4 py-2">Gross</th>
            <th className="text-left px-4 py-2">Status</th>
            <th className="text-left px-4 py-2">Deposit</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={String(b['id'])} className="border-t border-[var(--mc-line)]">
              <td className="px-4 py-2">{gyDate(String(b['periodStart']))}</td>
              <td className="px-4 py-2 tabular-nums">{gyd(Number(b['grossGyd'] ?? 0))}</td>
              <td className="px-4 py-2">{String(b['status'] ?? '')}</td>
              <td className="px-4 py-2">
                {b['depositConfirmedAt'] ? gyDate(String(b['depositConfirmedAt'])) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
