'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MutationNotice } from '@/components/mutation-notice';
import { DataUnavailable } from '@/components/data-unavailable';
import { formatMoney as money } from '@/lib/money';
import { readSettlementLedger } from '@/lib/cash-settlement-view';
import { subscriptionInGoodStanding, subscriptionLine, subscriptionStatusWord } from '@/lib/partner-fee';
import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';
import {
  confirmRiderSettlement, getDriverProfile, getDriverSubscription, getDriverSummary, getEarningsStatementPath,
  getRiderCashSettlements, getRiderProfile, getRiderSubscription, getRiderSummary, type EarningsSummary,
} from '@/lib/mover-api';

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 sw-card p-5">
      <p className="break-words text-xs font-medium  text-[var(--swift-muted)]">{label}</p>
      <p className="mt-2 break-words sw-title">{value}</p>
      {sub && <p className="mt-1 text-xs text-[var(--swift-muted)]">{sub}</p>}
    </div>
  );
}

/** [S4] "1 job", never "1 jobs". */
const jobsLabel = (n: number) => `${n} ${n === 1 ? 'job' : 'jobs'}`;

/** [Board 13a "CASH COLLECTED"] This week's cash kept from cash jobs, as the server sent it; undefined (older API, or
 *  junk) leaves the tile out — never a guessed $0. */
function cashThisWeek(s: EarningsSummary): number | undefined {
  const v = s.cashInHand?.thisWeek;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** [P36 · 13d / W3] The four windows the phone shows, for one role, and the phone's CASH COLLECTED tile (13a). */
function SummaryTiles({ s, role }: { s: EarningsSummary; role: 'rider' | 'driver' }) {
  const cash = cashThisWeek(s);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Today" value={money(s.today.total)} sub={jobsLabel(s.today.count)} />
      <Stat label="This week" value={money(s.thisWeek.total)} sub={jobsLabel(s.thisWeek.count)} />
      <Stat label="This month" value={money(s.thisMonth.total)} sub={jobsLabel(s.thisMonth.count)} />
      <Stat label="All time" value={money(s.allTime.total)} sub={jobsLabel(s.allTime.count)} />
      {cash !== undefined && (
        <Stat
          label="Cash collected"
          value={money(cash)}
          sub={role === 'driver' ? 'This week: the fares passengers paid you in cash' : 'This week, after paying stores for the goods'}
        />
      )}
    </div>
  );
}

/** [P36 · 13d "Download statement"] Opens the phone's earnings statement (a short-lived signed link) in a new tab.
 *  The tab is opened on the click itself, so a pop-up blocker allows it, and closed again if the link fails. */
function StatementButton({ role, label }: { role: 'rider' | 'driver'; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    if (busy) return;
    const tab = window.open('about:blank', '_blank');
    if (!tab) { setError('Your browser blocked the new tab. Allow pop-ups for Swift, then try again.'); return; }
    tab.opener = null;
    setBusy(true);
    setError(null);
    try {
      const path = await getEarningsStatementPath(role);
      tab.location.href = `${BROWSER_API_ORIGIN}${path}`;
    } catch {
      tab.close();
      setError('We couldn’t open your statement. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" onClick={() => void open()} disabled={busy} className="sw-btn sw-btn-md sw-btn-outline">
        {busy ? 'Opening…' : label}
      </button>
      {error ? <p role="alert" className="text-xs text-[var(--swift-red)]">{error}</p> : null}
    </div>
  );
}

function SubscriptionCard({ title, sub, isError, error, onRetry }: {
  title: string;
  sub: Record<string, unknown> | null;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  // [W-10] The card used to vanish on failure, so a mover in arrears saw
  // nothing at all where their status and weekly rate belong.
  if (isError) return <DataUnavailable what={title.toLowerCase()} error={error} onRetry={onRetry} />;
  if (!sub) return null;
  // [UI-SWEEP U18 / U46] The rate actually charged (a custom rate, not the list
  // rate), the status in words, and the trial / next-bill dates the server sends.
  return (
    <div className="sw-card p-5">
      <p className="font-bold">{title}</p>
      <Link href="/portal/weekly-fee" className="text-sm font-semibold underline">Weekly fee — view and pay</Link>
      <p className="mt-1 text-sm">
        Status: <b className={subscriptionInGoodStanding(sub) ? 'text-green-600' : 'text-[var(--swift-red)]'}>{subscriptionStatusWord(sub)}</b>
      </p>
      <p className="mt-0.5 text-sm text-[var(--swift-muted)]">
        {subscriptionLine(sub)} — you keep 100% of fares, fees and tips.
      </p>
    </div>
  );
}

export default function PortalHome() {
  const queryClient = useQueryClient();
  const rider = useQuery({ queryKey: ['p-rider'], queryFn: getRiderProfile, retry: 0 });
  const driver = useQuery({ queryKey: ['p-driver'], queryFn: getDriverProfile, retry: 0 });
  const summary = useQuery({ queryKey: ['p-summary'], queryFn: getRiderSummary, enabled: !!rider.data, retry: 0 });
  // The taxi driver's four windows; the name stays `driverEarn` (the [W-10] census checks every money read's error state).
  const driverEarn = useQuery({ queryKey: ['p-driver-summary'], queryFn: getDriverSummary, enabled: !!driver.data, retry: 0 });
  const riderSub = useQuery({ queryKey: ['p-rider-sub'], queryFn: getRiderSubscription, enabled: !!rider.data, retry: 0 });
  const driverSub = useQuery({ queryKey: ['p-driver-sub'], queryFn: getDriverSubscription, enabled: !!driver.data, retry: 0 });
  const settlements = useQuery({ queryKey: ['p-settlements'], queryFn: getRiderCashSettlements, enabled: !!rider.data, retry: 0 });
  // [W-26] see the store's half in dashboard/settings: confirming this row says
  // real cash reached the rider's hand. It names the store and the figure, and
  // takes a second deliberate step.
  const [pending, setPending] = useState<string | null>(null);
  const confirm = useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: string | number }) => confirmRiderSettlement(id, amount),
    onSettled: () => {
      setPending(null);
      queryClient.invalidateQueries({ queryKey: ['p-settlements'] });
    },
  });

  const loading = rider.isLoading || driver.isLoading;
  const isRider = !!rider.data;
  const isDriver = !!driver.data;
  const s = summary.data;
  // [U66] The ledger as the server sends it (orderNumber, vendor.name); a
  // malformed one is unavailable, never partly shown.
  const ledger = readSettlementLedger(settlements, 'vendor');

  if (loading) return <p className="text-sm text-[var(--swift-muted)]">Loading…</p>;

  // [W-10] THE WORST ONE. `isRider` is `!!rider.data`, and `soft()` made
  // `rider.data` null for ANY failure — so a 500 or a dropped connection told a
  // working mover "No earner profile on this account", i.e. that they are not a
  // driver. Absence is now only claimed when the server actually said so
  // (404/403); a failure says we could not check.
  if (rider.isError || driver.isError) {
    return (
      <DataUnavailable
        what="your earner profile"
        error={rider.error ?? driver.error}
        onRetry={() => { void rider.refetch(); void driver.refetch(); }}
      />
    );
  }
  if (!isRider && !isDriver) {
    return (
      <p className="rounded-2xl border border-dashed border-[var(--swift-border)] bg-[var(--swift-card)] p-10 text-center text-sm text-[var(--swift-muted)]">
        No earner profile on this account — start driving or delivering from the Swift app.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="sw-title">Earnings</h1>
        {/* [P36 · 13d / W3] The phone's sentence (EarningsScreen THIS WEEK hero). */}
        <p className="mt-1 text-sm font-semibold text-[var(--swift-success)]">100% yours · cash · 0% commission</p>
      </div>

      {/* [P36] A mover who both delivers and drives sees each role's own windows, named. */}
      {isRider && isDriver && <h2 className="sw-heading">Deliveries</h2>}
      {isRider && summary.isError && (
        <DataUnavailable what="your earnings" error={summary.error} onRetry={() => void summary.refetch()} />
      )}
      {isRider && s && <SummaryTiles s={s} role="rider" />}
      {isRider && <StatementButton role="rider" label={isDriver ? 'Get delivery earnings statement' : 'Get earnings statement'} />}

      {isRider && isDriver && <h2 className="sw-heading">Taxi rides</h2>}
      {isDriver && driverEarn.isError && (
        <DataUnavailable what="your taxi earnings" error={driverEarn.error} onRetry={() => void driverEarn.refetch()} />
      )}
      {isDriver && driverEarn.data && <SummaryTiles s={driverEarn.data} role="driver" />}
      {isDriver && <StatementButton role="driver" label={isRider ? 'Get taxi earnings statement' : 'Get earnings statement'} />}

      {/* [W-10] `settlements.data?.unsettled ?? []` made a failed read look
          exactly like "no store owes you anything", and the whole card — with
          the amount and the confirm buttons — simply disappeared. */}
      {isRider && ledger.state === 'unavailable' && (
        <DataUnavailable
          what="what stores owe you"
          error={settlements.error}
          onRetry={() => void settlements.refetch()}
        />
      )}
      {isRider && ledger.state === 'ready' && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <p className="font-semibold text-amber-800">
            Stores owe you {money(ledger.owed)} in delivery fees ({ledger.count} MMG orders)
          </p>
          <p className="mt-1 text-sm text-amber-800/80">
            When a customer pays the store&apos;s MMG, your fee lands in the store&apos;s MMG account — collect it in cash and confirm here.
          </p>
          <MutationNotice errors={[confirm.error]} className="mt-2" />
          <div className="mt-3 space-y-2">
            {ledger.rows.map((r) => {
              const id = r.id;
              const vendorName = r.counterparty ?? 'the store';
              return (
                <div key={id} className="flex flex-col gap-3 rounded-lg bg-[var(--swift-card)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0 break-words">
                    {r.orderNumber ? `#${r.orderNumber} · ` : ''}{r.counterparty ?? 'Store'} · <b>{money(r.amount)}</b>
                    {r.status === 'STORE_CONFIRMED' && <span className="ml-2 text-xs text-green-600">{r.counterparty ? `${r.counterparty} says they paid you.` : 'The store says they paid you.'}</span>}
                  </span>
                  {r.status !== 'RIDER_CONFIRMED' ? (
                    pending === id ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold">Received {money(r.amount)} from {vendorName}?</span>
                        <button
                          onClick={() => confirm.mutate({ id, amount: r.rawAmount })}
                          disabled={confirm.isPending}
                          className="min-h-11 rounded-lg bg-[var(--swift-red)] px-3 text-xs font-bold text-white disabled:opacity-50"
                        >
                          {confirm.isPending ? 'Confirming…' : `Yes, I received ${money(r.amount)}`}
                        </button>
                        <button onClick={() => setPending(null)} className="min-h-11 px-2 text-xs font-semibold text-[var(--swift-muted)]">Not yet</button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setPending(id)}
                        disabled={confirm.isPending}
                        className="min-h-11 shrink-0 self-start rounded-lg border border-[var(--swift-red)] px-3 text-xs font-bold text-[var(--swift-red)] disabled:opacity-50 sm:self-auto"
                      >
                        I received the cash
                      </button>
                    )
                  ) : (
                    <span className="text-xs text-[var(--swift-muted)]">You confirmed — waiting for the store to close it out.</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <SubscriptionCard
          title="Delivery subscription"
          sub={riderSub.data ?? null}
          isError={isRider && riderSub.isError}
          error={riderSub.error}
          onRetry={() => void riderSub.refetch()}
        />
        <SubscriptionCard
          title="Taxi subscription"
          sub={driverSub.data ?? null}
          isError={isDriver && driverSub.isError}
          error={driverSub.error}
          onRetry={() => void driverSub.refetch()}
        />
      </div>

      <p className="text-xs text-[var(--swift-muted)]">
        You are paid directly — cash in hand or straight to your MMG. Swift never holds your money.
      </p>
    </div>
  );
}
