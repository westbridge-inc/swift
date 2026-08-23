import { useQuery } from '@tanstack/react-query';
import {
  fetchOverview, fetchRevenue, fetchSlaBreaches, fetchModerationQueue, fetchSupport,
} from '../lib/api';

// Command Home — the founder's briefing at a glance. Revenue, live operations,
// and everything that needs a human, composed from the real admin APIs. Built
// to the bar of an enterprise ops console: dense, hierarchical, colour-coded,
// every number real and every alert a click from the thing it's about.

type ModuleKey = 'review' | 'vendors' | 'stuck' | 'moderation' | 'support' | 'money' | 'ops';

const g$ = (n: number | undefined) => `G$${Math.round(n ?? 0).toLocaleString()}`;
const num = (n: number | undefined) => (n ?? 0).toLocaleString();

// A tiny dependency-free bar sparkline for a 30-ish point series.
function Sparkline({ data, className = '' }: { data: number[]; className?: string }) {
  if (!data.length) return null;
  const max = Math.max(1, ...data);
  const w = 100, h = 28, gap = 1;
  const bw = (w - gap * (data.length - 1)) / data.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={`h-8 w-full ${className}`}>
      {data.map((v, i) => {
        const bh = Math.max(1, (v / max) * h);
        return <rect key={i} x={i * (bw + gap)} y={h - bh} width={bw} height={bh} rx={0.5} className="fill-[var(--swift-red)]/70" />;
      })}
    </svg>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'red' | 'green' | 'amber' }) {
  const ring = accent === 'red' ? 'border-[var(--swift-red)]/40' : accent === 'amber' ? 'border-amber-500/40' : accent === 'green' ? 'border-green-500/30' : 'border-neutral-200';
  return (
    <div className={`rounded-2xl border ${ring} bg-white p-4`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="mt-1 text-3xl font-extrabold tabular-nums leading-none">{value}</p>
      {sub && <p className="mt-1.5 text-xs text-neutral-500">{sub}</p>}
    </div>
  );
}

function OpStat({ label, value, tone }: { label: string; value: number; tone: 'ok' | 'warn' | 'bad' }) {
  const dot = tone === 'bad' ? 'bg-[var(--swift-red)]' : tone === 'warn' ? 'bg-amber-400' : 'bg-green-400';
  const val = tone === 'bad' ? 'text-[var(--swift-red)]' : tone === 'warn' ? 'text-amber-700' : 'text-neutral-900';
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-neutral-200 bg-neutral-50 px-3.5 py-3">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="text-sm text-neutral-600">{label}</span>
      <span className={`ml-auto text-lg font-bold tabular-nums ${val}`}>{num(value)}</span>
    </div>
  );
}

function Attention({ label, count, go, to }: { label: string; count: number; go: (m: ModuleKey) => void; to: ModuleKey }) {
  const hot = count > 0;
  return (
    <button
      onClick={() => go(to)}
      className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${hot ? 'border-[var(--swift-red)]/30 bg-[var(--swift-red)]/[0.06] hover:bg-[var(--swift-red)]/10' : 'border-neutral-200 bg-neutral-50 hover:bg-neutral-100'}`}
    >
      <span className={`grid h-7 min-w-7 place-items-center rounded-lg px-1.5 text-sm font-bold tabular-nums ${hot ? 'bg-[var(--swift-red)] text-white' : 'bg-neutral-100 text-neutral-500'}`}>{count}</span>
      <span className="text-sm text-neutral-700">{label}</span>
      <span className="ml-auto text-neutral-400">›</span>
    </button>
  );
}

export default function Home({ go }: { go: (m: ModuleKey) => void }) {
  const overview = useQuery({ queryKey: ['overview'], queryFn: fetchOverview, refetchInterval: 30_000 });
  const revenue = useQuery({ queryKey: ['finance-revenue'], queryFn: fetchRevenue, refetchInterval: 60_000 });
  const stuck = useQuery({ queryKey: ['sla-breaches'], queryFn: fetchSlaBreaches, refetchInterval: 30_000 });
  const reports = useQuery({ queryKey: ['moderation', 'PENDING'], queryFn: () => fetchModerationQueue('PENDING'), refetchInterval: 60_000 });
  const tickets = useQuery({ queryKey: ['support', 'OPEN'], queryFn: () => fetchSupport('OPEN'), refetchInterval: 60_000 });

  if (overview.isLoading) return <p className="text-sm text-neutral-400">Loading the briefing…</p>;
  if (overview.isError) {
    return (
      <div className="rounded-2xl border border-neutral-200 bg-neutral-100 p-8 text-center">
        <p className="text-sm text-neutral-600">Could not reach the admin API.</p>
        <p className="mt-1 text-xs text-neutral-400">{(overview.error as Error).message}</p>
        <button onClick={() => overview.refetch()} className="mt-4 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold">Try again</button>
      </div>
    );
  }

  const d = overview.data;
  const a = d.alerts ?? {};
  const rev = revenue.data?.summary;
  const daily = (revenue.data?.dailyRevenue ?? []).map((r) => Number(r.order_count) || 0);
  const stuckCount = stuck.data?.rows.length ?? 0;
  const reportsPending = reports.data?.pendingTotal ?? 0;
  const ticketsOpen = tickets.data?.total ?? 0;
  const onRoad = (d.activeRiders ?? 0) + (d.activeDrivers ?? 0);

  const attentionTotal = (a.pendingVendors ?? 0) + (a.pastDueSubs ?? 0) + (a.unassignedOrders ?? 0) + stuckCount + reportsPending + ticketsOpen;
  // [WR-023] The secondary feeds default to 0 on failure — with one of them
  // down, a green "All systems normal" is a guess, not a fact. Degrade the
  // claim whenever a feed is unreachable.
  const degraded = stuck.isError || reports.isError || tickets.isError || revenue.isError;
  const allClear = attentionTotal === 0 && !degraded;

  return (
    <div className="space-y-6">
      {/* status line */}
      <div className="flex items-center gap-3">
        <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${allClear ? 'bg-green-100 text-green-700' : degraded && attentionTotal === 0 ? 'bg-amber-100 text-amber-700' : 'bg-[var(--swift-red)]/15 text-[var(--swift-red)]'}`}>
          <span className={`h-2 w-2 rounded-full ${allClear ? 'bg-green-400' : degraded && attentionTotal === 0 ? 'bg-amber-400' : 'bg-[var(--swift-red)] animate-pulse'}`} />
          {allClear
            ? 'All systems normal'
            : attentionTotal === 0
              ? 'Partial picture — some feeds unreachable'
              : `${attentionTotal}${degraded ? '+' : ''} item${attentionTotal === 1 && !degraded ? '' : 's'} need attention${degraded ? ' (some feeds unreachable)' : ''}`}
        </span>
        <span className="text-xs text-neutral-400">Live · refreshes every 30s · ⌘K to search</span>
      </div>

      {/* revenue hero + KPIs */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-2xl border border-neutral-200 bg-gradient-to-br from-[var(--swift-red)]/[0.08] to-transparent p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Revenue · weekly subscriptions</p>
          <p className="mt-1 text-4xl font-extrabold tabular-nums leading-none">{g$(rev?.weeklySubscriptionRevenue ?? d.revenue?.weeklySubscriptionRevenue)}</p>
          <div className="mt-2 flex items-baseline gap-3 text-xs text-neutral-500">
            <span>{g$(rev?.monthlySubscriptionRevenue)} / mo</span>
            <span>·</span>
            <span>{num(rev?.activeSubscriptions)} paying partners</span>
          </div>
          <div className="mt-3"><Sparkline data={daily} /></div>
          <p className="mt-1 text-[11px] text-neutral-400">Orders/day · last 30 days. Swift keeps 0% of orders — subscriptions are the revenue.</p>
        </div>
        <Kpi label="Orders today" value={num(d.todayOrders)} sub={`${num(d.todayCompletedOrders)} completed · ${g$(d.revenue?.todayTotal)} handled`} />
        <Kpi label="On the road now" value={num(onRoad)} sub={`${num(d.activeRiders)} riders · ${num(d.activeDrivers)} taxis`} accent={onRoad === 0 ? 'amber' : undefined} />
      </div>

      <div className="grid grid-cols-4 gap-4">
        <Kpi label="New signups today" value={num(d.todayNewUsers)} sub={`${num(d.totalUsers)} total`} />
        <Kpi label="Active vendors" value={num(d.activeVendors)} sub={`of ${num(d.totalVendors)}`} />
        <Kpi label="Value handled today" value={g$(d.revenue?.todayTotal)} sub="cash + mobile-money through the platform" />
        <Kpi label="Delivery fees today" value={g$(d.revenue?.todayDeliveryFees)} sub="paid to riders (not platform)" />
      </div>

      {/* live operations */}
      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-neutral-400">Live operations</p>
        <div className="grid grid-cols-4 gap-3">
          <OpStat label="On the road" value={onRoad} tone={onRoad > 0 ? 'ok' : 'warn'} />
          <OpStat label="Unassigned orders" value={a.unassignedOrders ?? 0} tone={(a.unassignedOrders ?? 0) > 0 ? 'warn' : 'ok'} />
          <OpStat label="Past SLA (stuck)" value={stuckCount} tone={stuckCount > 0 ? 'bad' : 'ok'} />
          <OpStat label="Past-due subs" value={a.pastDueSubs ?? 0} tone={(a.pastDueSubs ?? 0) > 0 ? 'bad' : 'ok'} />
        </div>
      </div>

      {/* needs attention — drill-down */}
      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-neutral-400">Needs attention</p>
        {attentionTotal === 0 && degraded ? (
          <p className="rounded-xl border border-dashed border-amber-300 bg-amber-50 px-4 py-6 text-center text-sm text-amber-700">
            Some feeds are unreachable — the quiet board may be incomplete. Counts return as the feeds recover.
          </p>
        ) : attentionTotal === 0 ? (
          <p className="rounded-xl border border-dashed border-neutral-200 px-4 py-6 text-center text-sm text-neutral-400">Nothing on fire. The agent and the auto-sweeps are keeping up. 🎉</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Attention label="Vendors awaiting review" count={a.pendingVendors ?? 0} go={go} to="review" />
            <Attention label="Orders stuck past SLA" count={stuckCount} go={go} to="stuck" />
            <Attention label="Content reports to moderate" count={reportsPending} go={go} to="moderation" />
            <Attention label="Support tickets open" count={ticketsOpen} go={go} to="support" />
            <Attention label="Orders needing a mover" count={a.unassignedOrders ?? 0} go={go} to="ops" />
            <Attention label="Past-due subscriptions" count={a.pastDueSubs ?? 0} go={go} to="vendors" />
          </div>
        )}
      </div>
    </div>
  );
}
