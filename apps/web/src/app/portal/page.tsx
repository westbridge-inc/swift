'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  confirmRiderSettlement, getDriverEarnings, getDriverProfile, getDriverSubscription,
  getRiderCashSettlements, getRiderProfile, getRiderSubscription, getRiderSummary,
} from '@/lib/mover-api';

const money = (n: number) => `$${Math.round(Number(n)).toLocaleString()}`;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-black/5 bg-white p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--swift-muted)]">{label}</p>
      <p className="mt-2 text-2xl font-extrabold">{value}</p>
      {sub && <p className="mt-1 text-xs text-[var(--swift-muted)]">{sub}</p>}
    </div>
  );
}

function SubscriptionCard({ title, sub }: { title: string; sub: Record<string, unknown> | null }) {
  if (!sub) return null;
  const status = String(sub['status'] ?? '');
  const good = status === 'ACTIVE' || status === 'TRIAL';
  return (
    <div className="rounded-2xl border border-black/5 bg-white p-5">
      <p className="font-bold">{title}</p>
      <p className="mt-1 text-sm">
        Status: <b className={good ? 'text-green-600' : 'text-[var(--swift-red)]'}>{status}</b>
        {status === 'TRIAL' && sub['trialEndsAt'] ? (
          <span className="text-[var(--swift-muted)]"> — free until {new Date(String(sub['trialEndsAt'])).toLocaleDateString()}</span>
        ) : null}
      </p>
      <p className="mt-0.5 text-sm text-[var(--swift-muted)]">
        {money(Number(sub['weeklyRate'] ?? 0))}/week — you keep 100% of fares, fees and tips.
        {sub['currentPeriodEnd'] ? ` Paid through ${new Date(String(sub['currentPeriodEnd'])).toLocaleDateString()}.` : ''}
      </p>
    </div>
  );
}

export default function PortalHome() {
  const queryClient = useQueryClient();
  const rider = useQuery({ queryKey: ['p-rider'], queryFn: getRiderProfile, retry: 0 });
  const driver = useQuery({ queryKey: ['p-driver'], queryFn: getDriverProfile, retry: 0 });
  const summary = useQuery({ queryKey: ['p-summary'], queryFn: getRiderSummary, enabled: !!rider.data, retry: 0 });
  const driverEarn = useQuery({ queryKey: ['p-driver-earn'], queryFn: () => getDriverEarnings(1), enabled: !!driver.data, retry: 0 });
  const riderSub = useQuery({ queryKey: ['p-rider-sub'], queryFn: getRiderSubscription, enabled: !!rider.data, retry: 0 });
  const driverSub = useQuery({ queryKey: ['p-driver-sub'], queryFn: getDriverSubscription, enabled: !!driver.data, retry: 0 });
  const settlements = useQuery({ queryKey: ['p-settlements'], queryFn: getRiderCashSettlements, enabled: !!rider.data, retry: 0 });
  const confirm = useMutation({
    mutationFn: confirmRiderSettlement,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['p-settlements'] }),
  });

  const loading = rider.isLoading || driver.isLoading;
  const isRider = !!rider.data;
  const isDriver = !!driver.data;
  const s = summary.data;
  const owedRows = settlements.data?.unsettled ?? [];

  if (loading) return <p className="text-sm text-[var(--swift-muted)]">Loading…</p>;
  if (!isRider && !isDriver) {
    return (
      <p className="rounded-2xl border border-dashed border-black/10 bg-white p-10 text-center text-sm text-[var(--swift-muted)]">
        No earner profile on this account — start driving or delivering from the Swift app.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-extrabold">Earnings</h1>

      {isRider && s && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Today" value={money(s.today.total)} sub={`${s.today.count} jobs`} />
          <Stat label="This week" value={money(s.thisWeek.total)} sub={`${s.thisWeek.count} jobs`} />
          <Stat label="This month" value={money(s.thisMonth.total)} sub={`${s.thisMonth.count} jobs`} />
          <Stat label="All time" value={money(s.allTime.total)} sub={`${s.allTime.count} jobs`} />
        </div>
      )}
      {isDriver && driverEarn.data && (
        <Stat label="Taxi earnings · all time" value={money(driverEarn.data.totalEarnings)} sub="Full history in the History tab" />
      )}

      {isRider && owedRows.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <p className="font-semibold text-amber-800">
            Stores owe you {money(settlements.data?.summary?.owed ?? 0)} in delivery fees ({settlements.data?.summary?.count ?? owedRows.length} MMG orders)
          </p>
          <p className="mt-1 text-sm text-amber-800/80">
            When a customer pays the store&apos;s MMG, your fee lands in their wallet — collect it in cash and confirm here.
          </p>
          <div className="mt-3 space-y-2">
            {owedRows.map((r) => {
              const id = String(r['id']);
              const vendorName = (r['vendor'] as { name?: string } | null)?.name ?? 'Store';
              const orderNo = (r['order'] as { orderNumber?: string } | null)?.orderNumber;
              const status = String(r['status']);
              return (
                <div key={id} className="flex items-center justify-between gap-3 rounded-lg bg-white p-3 text-sm">
                  <span>
                    #{orderNo} · {vendorName} · <b>{money(Number(r['amount']))}</b>
                    {status === 'STORE_CONFIRMED' && <span className="ml-2 text-xs text-green-600">store confirmed</span>}
                    {status === 'RIDER_CONFIRMED' && <span className="ml-2 text-xs text-amber-600">waiting on store</span>}
                  </span>
                  {status !== 'RIDER_CONFIRMED' && (
                    <button
                      onClick={() => confirm.mutate(id)}
                      disabled={confirm.isPending}
                      className="rounded-lg bg-[var(--swift-red)] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                    >
                      Fee received
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <SubscriptionCard title="Delivery subscription" sub={riderSub.data ?? null} />
        <SubscriptionCard title="Taxi subscription" sub={driverSub.data ?? null} />
      </div>

      <p className="text-xs text-[var(--swift-muted)]">
        You are paid directly — cash in hand or straight to your MMG. Swift never holds your money.
      </p>
    </div>
  );
}
