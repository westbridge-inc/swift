'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
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
import { fetchMmgCheckout, fetchMmgCheckouts } from '@/lib/api';
import { HeldFeePayments } from '@/components/mc/HeldFeePayments';

/**
 * [MMG support lookup] Find a partner's MMG weekly-fee payment.
 *
 * One search box takes any id a partner or MMG can quote: the Swift reference
 * (ours, sent to MMG), MMG's transaction ID, MMG's own reference number, or the
 * partner's phone. The server matches it EXACTLY and records every search and
 * every opened payment. This page shows only what the server answered: no row
 * is drawn before it arrives, and an error is shown as an error, never as
 * "nothing found". [MC-AD3] Held payments waiting for a decision are listed
 * above the search, each decided on the provider's record (HeldFeePayments).
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

      <HeldFeePayments />

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
