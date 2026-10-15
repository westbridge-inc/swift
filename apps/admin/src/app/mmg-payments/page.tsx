'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import type {
  MmgCheckoutCreditedPeriod,
  MmgCheckoutSupportDetail,
  MmgCheckoutSupportMatch,
  MmgCheckoutSupportPartner,
  MmgCheckoutSupportRow,
  MmgCheckoutSupportStatus,
  MmgCheckoutTimelineEntry,
} from '@swift/types';
import {
  checkMmgFeeReversal, fetchMmgCheckout, fetchMmgCheckouts, fetchMmgFeeReversal, resolveMmgFeeReversal, reverseMmgFeePayment,
  type MmgFeeReversalRow, type MmgFeeReversalView,
} from '@/lib/api';
import { MutationError } from '@/components/MutationError';
import { REASON_MIN } from '@/lib/reason-rules';

/**
 * [MMG support lookup] Find a partner's MMG weekly-fee payment.
 *
 * One search box takes any id a partner or MMG can quote: the Swift reference
 * (ours, sent to MMG), MMG's transaction ID, MMG's own reference number, or the
 * partner's phone. The server matches it EXACTLY and records every search and
 * every opened payment. This page shows only what the server answered: no row
 * is drawn before it arrives, and an error is shown as an error, never as
 * "nothing found". Confirming a held payment is not here yet. A confirmed
 * payment can be RETURNED in full through MMG [MMG REVERSAL · owner #11].
 */
const SEARCH_HINT = 'Swift reference, MMG transaction ID, MMG reference or partner phone';

const STATUS_WORDS: Record<MmgCheckoutSupportStatus, string> = {
  OPEN: 'Open', CONFIRMING: 'Confirming', CONFIRMED: 'Confirmed', NOT_PAID: 'Not paid', EXPIRED: 'Expired', HELD: 'Held for review',
};
const STATUS_TONE: Record<MmgCheckoutSupportStatus, string> = {
  OPEN: 'bg-sky-500/15 text-sky-400',
  CONFIRMING: 'bg-amber-500/15 text-amber-400',
  CONFIRMED: 'bg-emerald-500/15 text-emerald-400',
  NOT_PAID: 'bg-white/10 text-[var(--muted)]',
  EXPIRED: 'bg-white/10 text-[var(--muted)]',
  HELD: 'bg-red-500/15 text-red-400',
};
const MATCH_WORDS: Record<MmgCheckoutSupportMatch, string> = {
  SWIFT_REFERENCE: 'Swift reference',
  MMG_TRANSACTION_ID: 'MMG transaction ID',
  MMG_CANDIDATE: "Named in MMG's reply",
  MMG_REFERENCE: 'MMG reference',
  PARTNER_PHONE: 'Partner phone',
};
const KIND_WORDS: Record<MmgCheckoutSupportPartner['kind'], string> = { VENDOR: 'Store', RIDER: 'Rider', DRIVER: 'Taxi driver', UNKNOWN: 'Partner' };
/** MMG's documented result codes (mmg-checkout-reply.ts MMG_RESULT_CODES), in plain words. */
const RESULT_WORDS: Record<string, string> = {
  '0': 'successful', '1': 'agent not registered', '2': 'payment failed', '3': 'invalid secret key',
  '4': 'merchant ID mismatch', '5': 'token decryption failed', '6': 'cancelled', '7': 'timed out',
};
const WINDOW_WORDS: Record<NonNullable<MmgCheckoutTimelineEntry['windowCheck']>, string> = {
  INSIDE: 'Inside the checkout window',
  OUTSIDE: 'Outside the checkout window',
  AFTER_REPLY: "After MMG's first reply: MMG's time may not match the zone setting",
  UNREADABLE: "MMG's date could not be read",
};
const SOURCE_WORDS: Record<MmgCheckoutTimelineEntry['source'], string> = { RETURN: 'Reply (return page)', NOTIFY: 'Reply (MMG server)', LOOKUP: 'MMG lookup' };
const PLATFORM_WORDS: Record<string, string> = { ios: 'iPhone app', android: 'Android app', web: 'Website', unknown: 'Unknown' };

const gyd = (amount: number) => `GY$${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
/** Guyana time, always: support and partners speak in it. */
const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const messageOf = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');

function StatusPill({ status }: { status: MmgCheckoutSupportStatus }) {
  return <span className={`px-2.5 py-1 rounded-full text-xs whitespace-nowrap ${STATUS_TONE[status]}`}>{STATUS_WORDS[status]}</span>;
}

/** An id on one line in the table (it is read and copied whole); allowed to wrap in the narrower detail. */
function Id({ value, empty, wrap = false }: { value: string | null; empty: string; wrap?: boolean }) {
  return value
    ? <span className={`font-mono text-xs ${wrap ? 'break-all' : 'whitespace-nowrap'}`}>{value}</span>
    : <span className="text-[var(--muted)] text-xs whitespace-nowrap">{empty}</span>;
}

type Applied = { q: string; status: MmgCheckoutSupportStatus | ''; run: number };

export default function MmgPaymentsPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<MmgCheckoutSupportStatus | ''>('');
  const [applied, setApplied] = useState<Applied>({ q: '', status: '', run: 0 });
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useInfiniteQuery({
    queryKey: ['mmg-checkouts', applied.q, applied.status, applied.run],
    queryFn: ({ pageParam }) => fetchMmgCheckouts({ q: applied.q, status: applied.status, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Every read is recorded on the server: read when asked, never on a timer or a refocus.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const rows: MmgCheckoutSupportRow[] = list.data?.pages.flatMap((page) => page.data) ?? [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setOpenId(null);
    setApplied((prev) => ({ q: q.trim(), status, run: prev.run + 1 }));
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">MMG payments</h1>
      <p className="text-[var(--muted)] text-sm mb-6">
        Find a partner&apos;s MMG weekly-fee payment by any reference they or MMG can quote. Every search and every opened payment is recorded.
      </p>

      <form onSubmit={submit} className="flex flex-col md:flex-row gap-3 mb-6" role="search" aria-label="Find an MMG payment">
        <input
          type="search"
          aria-label="Search MMG payments"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder={SEARCH_HINT}
          maxLength={64}
          className="flex-1 bg-[var(--panel)] border border-[var(--border)] rounded-lg px-4 py-2.5 text-sm placeholder:text-[var(--muted)]"
        />
        <select
          aria-label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value as MmgCheckoutSupportStatus | '')}
          className="bg-[var(--panel)] border border-[var(--border)] rounded-lg px-3 py-2.5 text-sm"
        >
          <option value="">All statuses</option>
          {(Object.keys(STATUS_WORDS) as MmgCheckoutSupportStatus[]).map((s) => <option key={s} value={s}>{STATUS_WORDS[s]}</option>)}
        </select>
        <button type="submit" className="px-5 py-2.5 rounded-lg bg-[var(--accent)] text-white text-sm font-semibold">Search</button>
      </form>

      <section aria-label="Payments" className="bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-hidden mb-6">
        {list.isPending ? (
          <p role="status" className="p-12 text-center text-[var(--muted)] text-sm">Searching…</p>
        ) : list.isError && !list.data ? (
          <div role="alert" className="p-6 text-sm text-red-400">Could not load MMG payments: {messageOf(list.error)}</div>
        ) : rows.length === 0 ? (
          <div className="p-12 flex flex-col items-center text-center">
            <Receipt size={40} className="text-[var(--muted)] mb-3" />
            <p className="text-sm text-[var(--muted)]">{applied.q ? 'No MMG payment matches that exactly.' : 'No MMG payments yet.'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[var(--muted)] text-xs">
                <tr>
                  {['Created', 'Swift reference', 'MMG transaction ID', 'MMG reference', 'Amount', 'Status', 'Partner', applied.q ? 'Matched by' : null, '']
                    .filter((h): h is string => h !== null)
                    .map((h) => <th key={h || 'open'} scope="col" className="px-4 py-3 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {rows.map((row) => (
                  <tr key={row.id} className={openId === row.id ? 'bg-white/5' : undefined}>
                    <td className="px-4 py-3 whitespace-nowrap">{when(row.createdAt)}</td>
                    <td className="px-4 py-3"><Id value={row.swiftReference} empty="—" /></td>
                    <td className="px-4 py-3"><Id value={row.mmgTransactionId} empty="Not confirmed" /></td>
                    <td className="px-4 py-3"><Id value={row.mmgTransactionReference} empty="Not known" /></td>
                    <td className="px-4 py-3 whitespace-nowrap">{gyd(row.amount)}</td>
                    <td className="px-4 py-3"><StatusPill status={row.status} /></td>
                    <td className="px-4 py-3">
                      <p className="whitespace-nowrap">{row.partner.displayName ?? '—'}</p>
                      <p className="text-xs text-[var(--muted)] whitespace-nowrap">{KIND_WORDS[row.partner.kind]}{row.partner.maskedPhone ? ` · ${row.partner.maskedPhone}` : ''}</p>
                    </td>
                    {applied.q ? <td className="px-4 py-3 text-xs">{row.matchedBy.map((m) => MATCH_WORDS[m]).join(', ')}</td> : null}
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setOpenId(row.id)}
                        aria-label={`Open payment ${row.swiftReference}`}
                        className="text-xs underline text-[var(--accent)]"
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.hasNextPage ? (
              <div className="p-4 border-t border-[var(--border)]">
                <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} className="text-sm underline disabled:opacity-50">
                  {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : null}
            {list.isFetchNextPageError ? <p role="alert" className="px-4 pb-4 text-sm text-red-400">Could not load more: {messageOf(list.error)}</p> : null}
          </div>
        )}
      </section>

      {openId ? <Detail id={openId} /> : null}
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const panel = useRef<HTMLElement | null>(null);
  const detail = useQuery({
    queryKey: ['mmg-checkout', id],
    queryFn: () => fetchMmgCheckout(id),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (detail.data) panel.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [detail.data]);
  if (detail.isPending) return <p role="status" className="text-sm text-[var(--muted)]">Opening the payment…</p>;
  if (detail.isError) return <div role="alert" className="text-sm text-red-400">Could not open this payment: {messageOf(detail.error)}</div>;
  const d: MmgCheckoutSupportDetail = detail.data.data;
  return (
    <section ref={panel} aria-label="Payment detail" className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6 space-y-6 scroll-mt-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-[var(--muted)]">Swift reference</p>
          <h2 className="font-mono text-base break-all">{d.swiftReference}</h2>
        </div>
        <StatusPill status={d.status} />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
        <div className="space-y-6">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Field label="MMG transaction ID"><Id value={d.mmgTransactionId} empty="Not confirmed" wrap /></Field>
            <Field label="MMG reference"><Id value={d.mmgTransactionReference} empty="Not known" wrap /></Field>
            <Field label="Amount">{gyd(d.amount)} {d.currencyCode}</Field>
            <Field label="Started on">{PLATFORM_WORDS[d.platform] ?? d.platform}</Field>
            <Field label="Partner">{d.partner.displayName ?? '—'} · {KIND_WORDS[d.partner.kind]}{d.partner.maskedPhone ? ` · ${d.partner.maskedPhone}` : ''}</Field>
            <Field label="Subscription"><span className="font-mono text-xs break-all">{d.partner.subscriptionId}</span></Field>
            <Field label="Created">{when(d.createdAt)}</Field>
            <Field label="MMG replied">{when(d.replyAt)}</Field>
            <Field label="Confirmed">{when(d.confirmedAt)}</Field>
            {d.reason ? <Field label="Reason (operators only)"><span className="font-mono text-xs">{d.reason}</span></Field> : null}
          </dl>
          {d.creditedPeriod ? <Credited period={d.creditedPeriod} /> : null}
          {d.status === 'CONFIRMED' ? <ReturnPanel checkoutId={d.id} amount={d.amount} currencyCode={d.currencyCode} /> : null}
        </div>
        <Timeline entries={d.timeline} truncated={d.timelineTruncated} />
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function Credited({ period }: { period: MmgCheckoutCreditedPeriod }) {
  const line = period.state === 'APPLIED'
    ? `Paid the week of ${day(period.periodStart)} to ${day(period.periodEnd)}.`
    : period.state === 'PENDING'
      ? 'Credited; being applied to the weekly fee.'
      : 'Credited and kept toward the next weekly fee.';
  return (
    <div className="rounded-lg border border-[var(--border)] p-4 text-sm">
      <p className="text-xs text-[var(--muted)] mb-1">Credited period</p>
      <p>{line}</p>
      {period.receiptNumber ? <p className="text-xs text-[var(--muted)] mt-1">Receipt {period.receiptNumber}</p> : null}
    </div>
  );
}

function Timeline({ entries, truncated }: { entries: MmgCheckoutTimelineEntry[]; truncated: boolean }) {
  return (
    <div>
      <h3 className="text-xs font-semibold tracking-widest text-[var(--muted)] mb-2">TIMELINE</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">MMG has not replied, and Swift has not looked this payment up yet.</p>
      ) : (
        <ol className="space-y-3">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`} className="border-l-2 border-[var(--border)] pl-3 text-sm">
              <p className="font-medium">{SOURCE_WORDS[e.source]} <span className="text-[var(--muted)] font-normal">· {when(e.at)}</span></p>
              <p className="text-xs text-[var(--muted)] mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                {e.resultCode !== null ? <span>Result code {e.resultCode} ({RESULT_WORDS[e.resultCode] ?? 'undocumented'})</span> : null}
                {e.transactionStatus ? <span>MMG status: {e.transactionStatus}</span> : null}
                {e.amount ? <span>Amount: {e.amount} {e.currency ?? ''}</span> : null}
                {e.mmgTransactionId ? <span>MMG transaction ID: <span className="font-mono">{e.mmgTransactionId}</span></span> : null}
                {e.mmgTransactionReference ? <span>MMG reference: <span className="font-mono">{e.mmgTransactionReference}</span></span> : null}
                {e.windowCheck ? <span>{WINDOW_WORDS[e.windowCheck]}</span> : null}
                {e.failure ? <span>Note: {e.failure}</span> : null}
              </p>
            </li>
          ))}
        </ol>
      )}
      {truncated ? <p className="text-xs text-[var(--muted)] mt-2">Showing the first records only.</p> : null}
    </div>
  );
}

/** [MMG REVERSAL] Where a return of this payment stands, in plain words. */
const RETURN_STATE_WORDS: Record<MmgFeeReversalRow['state'], string> = {
  SENDING: 'Asking MMG to return it',
  SENT: "MMG accepted; waiting for MMG's confirmation",
  REVERSED: 'Returned through MMG to the account it was paid from',
  FAILED: 'MMG refused; nothing changed',
  HELD: 'Held for a person',
};
const HELD_WORDS: Record<string, string> = {
  NO_ANSWER_FROM_MMG: 'MMG did not answer, and its records do not show a return yet',
  MMG_SAYS_ALREADY_REVERSED: 'MMG says it was already returned, but its records still show the payment',
  MMG_REFUSED_LOOKUP_UNCLEAR: "MMG refused, and its records could not be read clearly",
  NOT_PROVEN_IN_TIME: 'MMG accepted, but has not confirmed the return within a day',
  WALLET_NO_LONGER_HOLDS_IT: 'MMG returned it, but this payment has already paid for a week of the partner\'s fee',
};

/**
 * [MMG REVERSAL · owner #11] Return a whole weekly-fee payment to the partner
 * through MMG. MMG returns in full only, so the admin types the whole amount.
 * The server asks for a second admin first (or the owner's solo approval);
 * only MMG's own records then move the partner's fee balance. Anything unclear
 * is held for a person, here, with "Check with MMG".
 */
function ReturnPanel({ checkoutId, amount, currencyCode }: { checkoutId: string; amount: number; currencyCode: string }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const view = useQuery({ queryKey: ['mmg-fee-reversal', checkoutId], queryFn: () => fetchMmgFeeReversal(checkoutId), refetchOnWindowFocus: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ['mmg-fee-reversal', checkoutId] });
  const ask = useMutation({ mutationFn: () => reverseMmgFeePayment(checkoutId, Number(typed), reason.trim()), onSettled: refresh });
  const check = useMutation({ mutationFn: (id: string) => checkMmgFeeReversal(id), onSettled: refresh });
  const v = view.data?.data as MmgFeeReversalView | undefined;
  // Only the server's own answer is shown: anything else is not this panel's.
  if (!v || typeof v !== 'object' || typeof v.canReverse !== 'boolean' || !Array.isArray(v.reversals)) return null;
  const amountOk = typed.trim() !== '' && Number(typed) === amount;
  const reasonOk = reason.trim().length >= REASON_MIN;
  const queued = (ask.error as { code?: string } | null)?.code === 'APPROVAL_REQUIRED';

  return (
    <section aria-label="Return this payment" className="rounded-lg border border-[var(--border)] p-4 space-y-3 text-sm">
      <h3 className="font-semibold">Return this payment to the partner</h3>
      {v.reversals.map((r) => (
        <div key={r.id} className="rounded-md bg-[var(--bg)] p-3 space-y-1">
          <p className="font-semibold">{RETURN_STATE_WORDS[r.state]}</p>
          <p className="text-xs text-[var(--muted)]">{gyd(r.amount)} {r.currencyCode} · asked {when(r.sentAt)}{r.reversedAt ? ` · returned ${when(r.reversedAt)}` : ''}</p>
          {r.heldReason ? <p className="text-xs text-amber-400">{HELD_WORDS[r.heldReason] ?? r.heldReason}. Check the MMG statement before anything else.</p> : null}
          {r.resolution ? <p className="text-xs text-[var(--muted)]">{RESOLUTION_WORDS[r.resolution] ?? r.resolution}</p> : null}
          {r.state === 'SENT' || r.state === 'HELD' || r.state === 'SENDING' ? (
            <button
              type="button"
              disabled={check.isPending}
              onClick={() => check.mutate(r.id)}
              className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs disabled:opacity-40"
            >
              {check.isPending ? 'Checking…' : 'Check with MMG'}
            </button>
          ) : null}
        </div>
      ))}
      {check.error ? <MutationError error={check.error} label="MMG could not be checked" /> : null}
      {v.reversals.filter((r) => r.state === 'HELD').map((r) => <ResolveHeld key={`resolve-${r.id}`} reversalId={r.id} heldReason={r.heldReason} lookupStatus={r.lookupStatus} onDone={refresh} />)}
      {!v.switchedOn ? (
        <p className="text-xs text-[var(--muted)]">Returning payments is switched off on this server until MMG&apos;s answers are proven in testing.</p>
      ) : !v.canReverse ? (
        v.refusal && !v.reversals.some((r) => r.state === 'REVERSED' || r.state === 'SENT' || r.state === 'HELD' || r.state === 'SENDING')
          ? <p className="text-xs text-[var(--muted)]">{v.refusal.message}</p>
          : null
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => { e.preventDefault(); if (amountOk && reasonOk) ask.mutate(); }}
        >
          <p className="text-xs text-[var(--muted)]">
            MMG returns the whole payment ({gyd(amount)} {currencyCode}) to the partner&apos;s MMG account, and Swift deducts it from
            what the partner has paid toward weekly fees once MMG confirms. A second admin must approve it first.
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            aria-label="Why it is being returned"
            placeholder="Why it is being returned (for example: paid this week twice). Required."
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
          />
          <label className="block text-xs text-[var(--muted)]">
            Type the whole amount to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric"
              aria-label="Amount to return"
              className="mt-1 block w-40 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={ask.isPending || !amountOk || !reasonOk}
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {ask.isPending ? 'Sending…' : 'Return this payment'}
          </button>
          {queued ? (
            <p role="status" className="text-xs text-[var(--muted)]">
              Sent for a second admin&apos;s approval. Nothing has changed yet. Once approved, execute it from Approvals.
            </p>
          ) : ask.error ? <MutationError error={ask.error} label="The return did not start" /> : null}
        </form>
      )}
    </section>
  );
}

const RESOLUTION_WORDS: Record<string, string> = {
  NOT_RETURNED: 'Closed by a person: MMG shows the payment was not returned.',
  RETURNED_BY_REFERENCE: "Closed by a person: MMG's records showed the return they named.",
  RETURNED_NOT_BOOKED: 'Closed by a person: MMG returned it after the money had already paid for a week. Nothing was deducted; that week\'s fee is owed again (on the books as fee owed) and finance collects it.',
};

/**
 * [DS1112] A HELD return, closed by a person on MMG's evidence. A money action:
 * the first answer is a second admin's approval. The server reads MMG's records
 * again and refuses anything they do not show.
 */
function ResolveHeld({ reversalId, heldReason, lookupStatus, onDone }: { reversalId: string; heldReason: string | null; lookupStatus?: string | null; onDone: () => void }) {
  const [outcome, setOutcome] = useState<'NOT_RETURNED' | 'RETURNED' | 'RETURNED_NOT_BOOKED'>('NOT_RETURNED');
  // [DS1115] Only where MMG returned money that had already paid for a week.
  const moneyUsed = (heldReason ?? '').startsWith('WALLET_NO_LONGER_HOLDS_IT');
  // [Opus delta S3-N1] MMG's records no longer find the payment: no return can be booked, and it
  // cannot be "not returned" either; a person closes it on MMG's reversal reference.
  const paymentNotFound = !moneyUsed && lookupStatus === 'PAYMENT_NOT_FOUND';
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const resolve = useMutation({ mutationFn: () => resolveMmgFeeReversal(reversalId, outcome, reference.trim(), reason.trim()), onSettled: onDone });
  const ok = reference.trim().length >= 3 && reason.trim().length >= REASON_MIN;
  const queued = (resolve.error as { code?: string } | null)?.code === 'APPROVAL_REQUIRED';
  return (
    <form
      aria-label="Resolve the held return"
      className="space-y-2 rounded-md border border-[var(--border)] p-3"
      onSubmit={(e) => { e.preventDefault(); if (ok) resolve.mutate(); }}
    >
      <p className="text-xs font-semibold">Resolve it from the MMG statement</p>
      <label className="flex items-center gap-2 text-xs">
        <input type="radio" name={`outcome-${reversalId}`} checked={outcome === 'NOT_RETURNED'} onChange={() => setOutcome('NOT_RETURNED')} />
        MMG shows the payment was not returned
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="radio" name={`outcome-${reversalId}`} checked={outcome === 'RETURNED'} onChange={() => setOutcome('RETURNED')} />
        MMG shows it was returned (enter MMG&apos;s reversal reference)
      </label>
      {moneyUsed ? (
        <label className="flex items-center gap-2 text-xs">
          <input type="radio" name={`outcome-${reversalId}`} checked={outcome === 'RETURNED_NOT_BOOKED'} onChange={() => setOutcome('RETURNED_NOT_BOOKED')} />
          MMG returned it, but the money had already paid for a week (close it; that week&apos;s fee is then owed again and finance collects it)
        </label>
      ) : paymentNotFound ? (
        <label className="flex items-center gap-2 text-xs">
          <input type="radio" name={`outcome-${reversalId}`} checked={outcome === 'RETURNED_NOT_BOOKED'} onChange={() => setOutcome('RETURNED_NOT_BOOKED')} />
          MMG&apos;s records no longer find this payment, but its statement shows it returned (close it on MMG&apos;s reversal reference: while the partner&apos;s weekly-fee payments still hold the amount it is deducted once; otherwise nothing is deducted and that week&apos;s fee is owed again)
        </label>
      ) : null}
      <input
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        aria-label="MMG reference"
        placeholder={outcome === 'NOT_RETURNED' ? 'The MMG statement line or reference' : "MMG's reversal reference"}
        className="block w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
      />
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        aria-label="Why"
        placeholder="What you checked. Required."
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
      />
      <button type="submit" disabled={resolve.isPending || !ok} className="rounded-lg border border-[var(--border)] px-3 py-1 text-xs disabled:opacity-40">
        {resolve.isPending ? 'Sending…' : 'Send for approval'}
      </button>
      {queued ? (
        <p role="status" className="text-xs text-[var(--muted)]">Sent for a second admin&apos;s approval. Nothing has changed yet.</p>
      ) : resolve.error ? <MutationError error={resolve.error} label="The return was not resolved" /> : null}
    </form>
  );
}
