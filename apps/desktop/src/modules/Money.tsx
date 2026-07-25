import { useQuery } from '@tanstack/react-query';
import { fetchRevenue, fetchPaymentMix } from '../lib/api';

// The money view. Swift's revenue is WEEKLY SUBSCRIPTIONS only — cash-only
// orders, zero commission, no customer markup. So the headline is subscription
// income + how many partners are paying; order value flows to vendors/riders.

const g$ = (n: number) => `G$${Math.round(n).toLocaleString()}`;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <p className="text-xs uppercase tracking-wide text-white/40">{label}</p>
      <p className="mt-1 text-2xl font-extrabold">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-white/40">{sub}</p>}
    </div>
  );
}

export default function Money() {
  const rev = useQuery({ queryKey: ['finance-revenue'], queryFn: fetchRevenue });
  const mix = useQuery({ queryKey: ['finance-payment-mix'], queryFn: fetchPaymentMix });

  if (rev.isLoading) return <p className="text-sm text-white/50">Adding it up…</p>;
  if (rev.isError) return <p className="text-sm text-[var(--swift-red)]">{(rev.error as Error).message}</p>;

  const s = rev.data!.summary;
  const byMethod: Array<{ method: string; count: number; total: number }> = mix.data?.byMethod ?? [];
  const mmgUnconfirmed: number = mix.data?.mmgUnconfirmed ?? 0;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-white/40">Revenue — weekly partner subscriptions</p>
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Active subscriptions" value={String(s.activeSubscriptions)} sub="partners paying" />
          <Stat label="This week" value={g$(s.weeklySubscriptionRevenue)} sub="subscription income" />
          <Stat label="This month" value={g$(s.monthlySubscriptionRevenue)} sub="subscription income" />
        </div>
        <p className="mt-2 text-xs text-white/40">
          Swift keeps 0% of orders — delivery fees go to riders and there's no customer markup or commission. Subscriptions are the revenue.
        </p>
      </div>

      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-white/40">How customers paid (last 30 days)</p>
        <div className="space-y-1">
          {byMethod.length === 0 && <p className="text-sm text-white/40">No completed orders yet.</p>}
          {byMethod.map((m) => (
            <div key={m.method} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-sm">
              <span className="font-semibold">{m.method.replaceAll('_', ' ')}</span>
              <span className="text-white/40">{m.count} order{m.count === 1 ? '' : 's'}</span>
              <span className="ml-auto text-white/60">{g$(m.total)} handled</span>
            </div>
          ))}
        </div>
        {mmgUnconfirmed > 0 && (
          <p className="mt-2 text-xs text-amber-300">{mmgUnconfirmed} mobile-money order(s) not yet confirmed captured — worth a look.</p>
        )}
      </div>
    </div>
  );
}
