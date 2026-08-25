import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  PARTNER_SUBSCRIPTION_TYPES,
  fetchAgentApprovals,
  fetchCompliance,
  fetchModerationQueue,
  fetchOpsLive,
  fetchOverview,
  fetchPartnerPastDue,
  fetchReviewQueue,
  fetchSlaBreaches,
  fetchSupport,
} from '../lib/api';

type ModuleKey =
  | 'review'
  | 'vendors'
  | 'stuck'
  | 'moderation'
  | 'support'
  | 'money'
  | 'ops'
  | 'agent'
  | 'compliance';

type FeedState = 'loading' | 'error' | 'ready';

/** Dot / left-rule colour. A tone is a meaning, never decoration:
 *  alert = someone is already hurt · warn = someone will be · calm = a fact ·
 *  good = the safe outcome. Every value is a token. */
type Tone = 'alert' | 'warn' | 'calm' | 'good';

const count = (value: number) => value.toLocaleString('en-GY');

/** Guyana dollars render G$ — never GY$, never a bare $. */
const money = (value: number) => `G$${value.toLocaleString('en-GY', { maximumFractionDigits: 2 })}`;

function stateOf(query: { isLoading: boolean; isError: boolean }): FeedState {
  if (query.isLoading) return 'loading';
  if (query.isError) return 'error';
  return 'ready';
}

function stateWhen(
  query: { isLoading: boolean; isError: boolean },
  responseIsUsable: boolean,
): FeedState {
  const state = stateOf(query);
  return state === 'ready' && !responseIsUsable ? 'error' : state;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function FeedValue({ state, children }: { state: FeedState; children: ReactNode }) {
  if (state === 'loading') return <span className="feed-value feed-value-muted">Loading</span>;
  if (state === 'error') return <span className="feed-value feed-value-error">Unavailable</span>;
  return <span className="feed-value">{children}</span>;
}

/** One row of ON FIRE RIGHT NOW: a coloured left rule, a title, and one
 *  factual line saying what is actually true behind the number. */
function SignalRow({
  label,
  detail,
  value,
  state,
  tone = 'alert',
  go,
  to,
}: {
  label: string;
  detail: string;
  value: string;
  state: FeedState;
  tone?: Tone;
  go: (module: ModuleKey) => void;
  to: ModuleKey;
}) {
  return (
    <button className={`today-fire-row today-fire-${tone}`} onClick={() => go(to)} disabled={state !== 'ready'}>
      <span className="today-fire-copy">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <FeedValue state={state}>{value}</FeedValue>
      <span className="signal-arrow" aria-hidden="true">›</span>
    </button>
  );
}

function EmptyFeed({ children }: { children: ReactNode }) {
  return <div className="empty-feed">{children}</div>;
}

/** One metric: who is affected on the left, the number in the middle, the
 *  drill-downs on the right. Every part of it comes from a server field. */
function MetricRow({
  kicker,
  who,
  value,
  valueState,
  delta,
  deltaTone,
  drills,
  go,
  to,
}: {
  kicker: string;
  who: string;
  value: string;
  valueState: FeedState;
  delta: string | null;
  deltaTone?: Tone;
  drills: Array<{ label: string; value: string; state: FeedState; tone: Tone; to: ModuleKey }>;
  go: (module: ModuleKey) => void;
  to: ModuleKey;
}) {
  return (
    <div className="today-row">
      <button className="today-open" onClick={() => go(to)}>
        <span className="today-kicker">{kicker}</span>
        <span className="today-who">{who}</span>
      </button>
      <div className="today-mid">
        <FeedValue state={valueState}>
          <span className="today-figure">{value}</span>
        </FeedValue>
        {delta ? (
          <p className={deltaTone ? `today-delta today-delta-${deltaTone}` : 'today-delta'}>{delta}</p>
        ) : null}
      </div>
      <div className="today-drills">
        {drills.map((drill) => (
          <button
            key={drill.label}
            className="today-drill"
            onClick={() => go(drill.to)}
            disabled={drill.state !== 'ready'}
          >
            <span className={`today-dot today-dot-${drill.tone}`} aria-hidden="true" />
            <span className="today-drill-label">{drill.label}</span>
            <FeedValue state={drill.state}>
              <span className="today-drill-value">{drill.value}</span>
            </FeedValue>
          </button>
        ))}
      </div>
    </div>
  );
}

function oldestWait(iso?: string): string | null {
  if (!iso) return null;
  const submitted = new Date(iso).getTime();
  if (!Number.isFinite(submitted)) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - submitted) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** How far past its threshold the worst live order is, from worstOverMs. */
function overtime(ms: unknown): string | null {
  if (!finite(ms) || ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function clockLabel(iso?: string): string | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleTimeString('en-GY', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function startOfLocalDay(): number {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The compliance overview is an untyped admin payload; these are the shapes
 *  this screen reads out of it (schema: ComplianceAuditRun / Violation / Case). */
interface ComplianceRun {
  startedAt?: string;
  moversChecked?: number;
  violations?: number;
  trigger?: string;
}
interface ComplianceViolationRow {
  reason?: string;
}

/** Chrome is paper. Every colour below is a --swift token; there is no raw hex
 *  and no brand slab — maroon is spent on exactly one primary CTA. */
const TODAY_CSS = `
.today-view { color: var(--swift-ink); }

.today-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 34px;
  border-bottom: 2px solid var(--swift-deep);
  padding: 0 2px 20px;
}
.today-headline { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }
.today-title {
  margin: 0;
  font-family: "Bricolage", sans-serif;
  font-size: clamp(32px, 4vw, 56px);
  font-weight: 800;
  letter-spacing: -0.05em;
  line-height: 0.94;
}
.today-pill {
  border-radius: 999px;
  padding: 7px 15px;
  background: var(--swift-soft);
  color: var(--swift-deep);
  font-size: 13px;
  font-weight: 600;
}
.today-pill-muted { background: var(--swift-sunken); color: var(--swift-secondary); }
.today-pill-error { background: var(--swift-error-soft); color: var(--swift-error-deep); }
.today-live { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; color: var(--swift-muted); font-size: 12px; }
.today-source { max-width: 720px; margin: 7px 0 0; color: var(--swift-secondary); font-size: 12px; }
.today-actions { display: flex; align-items: center; gap: 10px; }

.today-row {
  display: grid;
  grid-template-columns: minmax(180px, 0.95fr) minmax(190px, 0.85fr) minmax(0, 1.3fr);
  align-items: center;
  gap: 24px;
  border-bottom: 1px solid var(--swift-line);
  padding: 22px 2px;
}
.today-open {
  display: grid;
  gap: 4px;
  min-width: 0;
  border-radius: 8px;
  padding: 4px 6px 4px 0;
  background: none;
  text-align: left;
}
.today-kicker {
  color: var(--swift-deep);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
}
.today-who { color: var(--swift-secondary); font-size: 12.5px; line-height: 1.35; }
.today-mid { display: grid; gap: 5px; min-width: 0; }
.today-mid .feed-value { display: block; }
.today-figure {
  display: block;
  color: var(--swift-ink);
  font-family: "Bricolage", sans-serif;
  font-size: clamp(36px, 4.2vw, 58px);
  font-weight: 800;
  letter-spacing: -0.05em;
  line-height: 0.92;
  font-variant-numeric: tabular-nums;
}
.today-delta { margin: 0; color: var(--swift-secondary); font-size: 12px; line-height: 1.35; }
.today-delta-good { color: var(--swift-success); }
.today-delta-warn { color: var(--swift-warning); }
.today-delta-alert { color: var(--swift-error-deep); }

.today-drills { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 16px; min-width: 0; }
.today-drill {
  display: grid;
  grid-template-columns: 7px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-width: 0;
  border-radius: 8px;
  padding: 7px 9px;
  background: none;
  text-align: left;
}
.today-drill:hover:not(:disabled) { background: var(--swift-sunken); }
.today-drill:disabled { opacity: 0.68; }
.today-dot { width: 7px; height: 7px; border-radius: 999px; }
.today-dot-alert { background: var(--swift-error); }
.today-dot-warn { background: var(--swift-warning); }
.today-dot-calm { background: var(--swift-info); }
.today-dot-good { background: var(--swift-success); }
.today-drill-label {
  overflow: hidden;
  color: var(--swift-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.today-drill-value { font-family: "Bricolage", sans-serif; font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }

.today-fire { margin-top: 30px; }
.today-fire-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.today-fire-title { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }
.today-fire-list { display: grid; margin-top: 10px; }
.today-fire-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 12px;
  align-items: center;
  gap: 14px;
  border-bottom: 1px solid var(--swift-line);
  border-left: 3px solid var(--swift-line-strong);
  padding: 13px 12px;
  background: none;
  text-align: left;
}
.today-fire-row:hover:not(:disabled) { background: var(--swift-sunken); }
.today-fire-row:disabled { opacity: 0.68; }
.today-fire-alert { border-left-color: var(--swift-error); }
.today-fire-warn { border-left-color: var(--swift-warning); }
.today-fire-calm { border-left-color: var(--swift-info); }
.today-fire-good { border-left-color: var(--swift-success); }
.today-fire-copy { display: grid; gap: 2px; min-width: 0; }
.today-fire-copy strong { font-size: 13px; font-weight: 600; }
.today-fire-copy small { color: var(--swift-secondary); font-size: 11.5px; }
.today-fire .empty-feed { margin-top: 10px; }

.today-gaps { max-width: 900px; margin: 22px 0 0; color: var(--swift-secondary); font-size: 11.5px; line-height: 1.55; }
.today-gaps strong { color: var(--swift-warning); font-weight: 600; }

@media (max-width: 1220px) {
  .today-head { align-items: flex-start; flex-direction: column; gap: 16px; }
  .today-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px 24px; }
  .today-drills { grid-column: span 2; grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;

export default function Home({ go }: { go: (module: ModuleKey) => void }) {
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: fetchOverview,
    refetchInterval: 30_000,
  });
  const documents = useQuery({
    queryKey: ['review-queue', 'briefing'],
    queryFn: () => fetchReviewQueue('PENDING'),
    refetchInterval: 30_000,
  });
  const live = useQuery({
    queryKey: ['ops-live', 'briefing'],
    queryFn: fetchOpsLive,
    refetchInterval: 10_000,
  });
  const stuck = useQuery({
    queryKey: ['sla-breaches'],
    queryFn: fetchSlaBreaches,
    refetchInterval: 30_000,
  });
  const reports = useQuery({
    queryKey: ['moderation', 'PENDING'],
    queryFn: () => fetchModerationQueue('PENDING'),
    refetchInterval: 60_000,
  });
  const tickets = useQuery({
    queryKey: ['support', 'OPEN'],
    queryFn: () => fetchSupport('OPEN'),
    refetchInterval: 60_000,
  });
  const agent = useQuery({
    queryKey: ['agent-approvals'],
    queryFn: fetchAgentApprovals,
    refetchInterval: 20_000,
  });
  const compliance = useQuery({
    queryKey: ['compliance'],
    queryFn: fetchCompliance,
    refetchInterval: 60_000,
  });
  const pastDue = useQuery({
    queryKey: ['partner-past-due'],
    queryFn: fetchPartnerPastDue,
    refetchInterval: 60_000,
  });

  // ── Documents: people who cannot work until someone looks ────────────────
  const documentRows = Array.isArray(documents.data?.rows) ? documents.data.rows : [];
  const documentTotal = documents.data?.meta.total;
  const documentState = stateWhen(documents, Array.isArray(documents.data?.rows) && finite(documentTotal));
  const oldestDocument = documentRows[0];
  const oldest = oldestWait(oldestDocument?.createdAt);
  // The queue is served oldest-first, so every document past 24h sits at the
  // front of page one: if the page still contains newer rows the count is the
  // whole queue's, and only an all-overdue page can be hiding more.
  const overdueDocuments = documentRows.filter((row) => {
    const submitted = new Date(row.createdAt).getTime();
    return Number.isFinite(submitted) && Date.now() - submitted >= DAY_MS;
  }).length;
  const overdueIsExact =
    overdueDocuments < documentRows.length || (finite(documentTotal) && documentRows.length >= documentTotal);
  const overdueDisplay = overdueIsExact ? count(overdueDocuments) : `${count(overdueDocuments)}+`;

  // ── Money: the weekly partner subscriptions, the only money Swift keeps ──
  const subscriptionBreakdown = Array.isArray(overview.data?.subscriptionBreakdown)
    ? overview.data.subscriptionBreakdown
    : [];
  const partnerSubscriptions = subscriptionBreakdown.filter((row) =>
    (PARTNER_SUBSCRIPTION_TYPES as readonly string[]).includes(row.type),
  );
  const partnerWeekly = partnerSubscriptions.reduce((sum, row) => sum + row.weeklyRevenue, 0);
  const payingPartners = partnerSubscriptions.reduce((sum, row) => sum + row.count, 0);
  const moneyState = stateWhen(
    overview,
    Array.isArray(overview.data?.subscriptionBreakdown) &&
      partnerSubscriptions.every((row) => finite(row.weeklyRevenue) && finite(row.count)),
  );
  const pastDueState = stateWhen(pastDue, finite(pastDue.data?.statusCount));
  const pastDueCount = pastDue.data?.statusCount ?? 0;

  // ── On the road: right now, this minute ──────────────────────────────────
  const slaRows = Array.isArray(stuck.data?.rows) ? stuck.data.rows : [];
  const slaState = stateWhen(stuck, Array.isArray(stuck.data?.rows) && typeof stuck.data?.truncated === 'boolean');
  const slaCount = slaRows.length;
  const slaDisplay = stuck.data?.truncated
    ? slaCount > 0 ? `${count(slaCount)}+` : 'Scan capped'
    : count(slaCount);
  const worstOvertime = overtime(slaRows[0]?.worstOverMs);
  const exhaustedRows = Array.isArray(live.data?.exhaustedSearches) ? live.data.exhaustedSearches : [];
  const activeOrderRows = Array.isArray(live.data?.activeOrders) ? live.data.activeOrders : [];
  const exhaustedState = stateWhen(live, Array.isArray(live.data?.exhaustedSearches));
  const activeOrdersState = stateWhen(live, Array.isArray(live.data?.activeOrders));
  const exhaustedCount = exhaustedRows.length;
  const exhaustedDisplay = exhaustedCount === 50 ? '50+' : count(exhaustedCount);
  const onRoadState = stateWhen(
    overview,
    finite(overview.data?.activeRiders) && finite(overview.data?.activeDrivers),
  );
  const activeRiders = overview.data?.activeRiders ?? 0;
  const activeDrivers = overview.data?.activeDrivers ?? 0;
  const completedTodayState = stateWhen(overview, finite(overview.data?.todayCompletedOrders));
  const completedToday = overview.data?.todayCompletedOrders ?? 0;
  const pendingVendorsState = stateWhen(overview, finite(overview.data?.alerts?.pendingVendors));
  const pendingVendors = overview.data?.alerts?.pendingVendors ?? 0;

  // ── Other human queues ───────────────────────────────────────────────────
  const reportState = stateWhen(reports, finite(reports.data?.pendingTotal));
  const reportCount = reports.data?.pendingTotal ?? 0;
  const ticketState = stateWhen(tickets, finite(tickets.data?.total));
  const ticketCount = tickets.data?.total ?? 0;
  const agentState = stateWhen(agent, Array.isArray(agent.data));
  const agentRows = Array.isArray(agent.data) ? agent.data : [];
  const agentDisplay = agentRows.length === 100 ? '100+' : count(agentRows.length);

  // ── Compliance: the liability shield, checked daily ──────────────────────
  const complianceRuns: ComplianceRun[] = Array.isArray(compliance.data?.runs) ? compliance.data.runs : [];
  const complianceViolations: ComplianceViolationRow[] = Array.isArray(compliance.data?.openViolations)
    ? compliance.data.openViolations
    : [];
  const complianceReviewQueue: unknown[] = Array.isArray(compliance.data?.reviewQueue)
    ? compliance.data.reviewQueue
    : [];
  const complianceState = stateWhen(compliance, finite(compliance.data?.unresolvedCount));
  const complianceShapeState = stateWhen(
    compliance,
    finite(compliance.data?.unresolvedCount) &&
      Array.isArray(compliance.data?.runs) &&
      Array.isArray(compliance.data?.openViolations) &&
      Array.isArray(compliance.data?.reviewQueue),
  );
  const unresolvedCompliance = Number(compliance.data?.unresolvedCount ?? 0);
  const latestRun = complianceRuns[0];
  const latestRunAt = clockLabel(latestRun?.startedAt);
  const latestRunForcedOffline = finite(latestRun?.violations) ? latestRun.violations : null;
  // The endpoint keeps the last 30 runs; only today's are summed, and the sum
  // is marked incomplete if that 30-run window itself starts today.
  const runsToday = complianceRuns.filter((run) => {
    const startedAt = new Date(run.startedAt ?? '').getTime();
    return Number.isFinite(startedAt) && startedAt >= startOfLocalDay();
  });
  const moversCheckedToday = runsToday.reduce(
    (sum, run) => sum + (finite(run.moversChecked) ? run.moversChecked : 0),
    0,
  );
  const runWindowFull = complianceRuns.length === 30;
  const moversCheckedDisplay =
    runWindowFull && runsToday.length === complianceRuns.length
      ? `${count(moversCheckedToday)}+`
      : count(moversCheckedToday);
  const runsKeptDisplay = runWindowFull ? '30+' : count(complianceRuns.length);
  const reviewQueueDisplay =
    complianceReviewQueue.length === 100 ? '100+' : count(complianceReviewQueue.length);
  const insuranceViolations = complianceViolations.filter(
    (violation) => String(violation.reason ?? '').toLowerCase() === 'insurance',
  ).length;
  const insuranceDisplay =
    complianceViolations.length === 100 ? `${count(insuranceViolations)}+` : count(insuranceViolations);

  // ── The headline pill ────────────────────────────────────────────────────
  // Six queues, six different tables, every one an exact server total — the
  // capped feeds (SLA scan, exhausted searches, agent proposals) are deliberately
  // left out rather than added in as an under-count.
  const attentionFeeds = [
    { state: documentState, value: documentTotal ?? 0 },
    { state: pendingVendorsState, value: pendingVendors },
    { state: reportState, value: reportCount },
    { state: ticketState, value: ticketCount },
    { state: complianceState, value: unresolvedCompliance },
    { state: pastDueState, value: pastDueCount },
  ];
  const attentionReady = attentionFeeds.every((feed) => feed.state === 'ready');
  const attentionErrored = attentionFeeds.some((feed) => feed.state === 'error');
  const attentionTotal = attentionFeeds.reduce((sum, feed) => sum + feed.value, 0);

  const now = new Date();
  const dateTitle = `${now.toLocaleDateString('en-GY', { weekday: 'long' })}, ${now.toLocaleDateString('en-GY', {
    day: 'numeric',
    month: 'long',
  })}`;

  const fireSignals = [
    {
      label: 'SLA breach',
      detail: stuck.data?.truncated
        ? `At least this many in the endpoint's capped ${count(stuck.data.scanCap)}-order scan`
        : worstOvertime
          ? `Deliveries outside their live threshold · worst is ${worstOvertime} over`
          : 'Delivery stages outside their live threshold',
      value: slaDisplay,
      raw: slaCount,
      incomplete: Boolean(stuck.data?.truncated),
      state: slaState,
      tone: 'alert' as const,
      to: 'stuck' as const,
    },
    {
      label: 'Past due',
      detail: 'Business subscriptions the server marks PAST_DUE — these partners lose service next',
      value: count(pastDueCount),
      raw: pastDueCount,
      state: pastDueState,
      tone: 'warn' as const,
      to: 'money' as const,
    },
    {
      label: 'Insurance gate',
      detail: complianceViolations.length === 100
        ? 'Movers held off the road on insurance, counted in the capped 100-violation feed'
        : 'Movers held off the road because their insurance failed the gate',
      value: insuranceDisplay,
      raw: insuranceViolations,
      state: complianceShapeState,
      tone: 'alert' as const,
      to: 'compliance' as const,
    },
    {
      label: 'Forced offline',
      detail: latestRunAt
        ? `Unresolved violations · last audit ran ${latestRunAt} and forced ${
            latestRunForcedOffline === null ? 'an unreported number' : count(latestRunForcedOffline)
          } offline`
        : 'Unresolved violations from the compliance authority',
      value: count(unresolvedCompliance),
      raw: unresolvedCompliance,
      state: complianceState,
      tone: 'alert' as const,
      to: 'compliance' as const,
    },
    {
      label: 'Nobody accepted',
      detail: exhaustedCount === 50
        ? 'At least this many unresolved in the last 24 hours'
        : 'No mover found or resolution recorded in the last 24 hours',
      value: exhaustedDisplay,
      raw: exhaustedCount,
      state: exhaustedState,
      tone: 'alert' as const,
      to: 'ops' as const,
    },
    {
      label: 'Content reports',
      detail: 'Pending moderation decisions',
      value: count(reportCount),
      raw: reportCount,
      state: reportState,
      tone: 'warn' as const,
      to: 'moderation' as const,
    },
    {
      label: 'Support tickets',
      detail: 'Open in-app requests; email and calls are not included',
      value: count(ticketCount),
      raw: ticketCount,
      state: ticketState,
      tone: 'warn' as const,
      to: 'support' as const,
    },
    {
      label: 'Agent proposals',
      detail: agentRows.length === 100
        ? 'At least this many waiting; the feed is capped'
        : 'Machine-proposed actions waiting for a person',
      value: agentDisplay,
      raw: agentRows.length,
      state: agentState,
      tone: 'calm' as const,
      to: 'agent' as const,
    },
  ];
  const visibleFireSignals = fireSignals.filter((signal) =>
    signal.state !== 'ready' || signal.raw > 0 || ('incomplete' in signal && signal.incomplete),
  );
  const fireFeedsComplete = fireSignals.every((signal) => signal.state === 'ready');

  const refreshAll = () => {
    void Promise.all([
      overview.refetch(), documents.refetch(), live.refetch(), stuck.refetch(), reports.refetch(),
      tickets.refetch(), agent.refetch(), compliance.refetch(), pastDue.refetch(),
    ]);
  };
  const refreshing = [overview, documents, live, stuck, reports, tickets, agent, compliance, pastDue]
    .some((query) => query.isFetching);

  return (
    <div className="briefing-view today-view">
      <style>{TODAY_CSS}</style>

      <section className="today-head">
        <div>
          <div className="today-headline">
            <h2 className="today-title">{dateTitle}</h2>
            {attentionReady ? (
              <span className="today-pill">{count(attentionTotal)} items need a human</span>
            ) : attentionErrored ? (
              <span className="today-pill today-pill-error">A queue did not answer — no total</span>
            ) : (
              <span className="today-pill today-pill-muted">Counting the queues</span>
            )}
          </div>
          <p className="today-live">
            <span className="live-dot" aria-hidden="true" />
            Live · 10–60s refresh
          </p>
          <p className="today-source">
            The pill adds six exact server totals — documents, businesses awaiting approval, content
            reports, support tickets, unresolved compliance violations, past-due partner subscriptions.
            Capped feeds are left out of it rather than counted short.
          </p>
        </div>
        <div className="today-actions">
          <button
            className="icon-button"
            onClick={refreshAll}
            disabled={refreshing}
            aria-label="Refresh all briefing feeds"
          >
            <span aria-hidden="true">↻</span>
          </button>
          <button className="primary-button" onClick={() => go('review')} disabled={documentState !== 'ready'}>
            Start triage <span aria-hidden="true">→</span>
          </button>
        </div>
      </section>

      <div className="today-metrics">
        <MetricRow
          kicker="Documents"
          who="People who cannot work until you look"
          value={count(documentTotal ?? 0)}
          valueState={documentState}
          delta={
            documentState !== 'ready'
              ? documentState === 'error'
                ? (documents.error as Error | null)?.message ?? null
                : null
              : documentTotal === 0
                ? 'Nobody is waiting on a document decision'
                : oldest
                  ? `Oldest submitted ${oldest} ago`
                  : 'Waiting on a person'
          }
          deltaTone={documentState === 'error' ? 'alert' : documentTotal === 0 ? 'good' : 'warn'}
          drills={[
            {
              // Not called an "SLA breach": the API publishes no document SLA.
              // This is the honest fact behind it — how many have waited a day.
              label: 'Waiting over 24h',
              value: overdueDisplay,
              state: documentState,
              tone: 'alert',
              to: 'review',
            },
            {
              label: 'Businesses awaiting approval',
              value: count(pendingVendors),
              state: pendingVendorsState,
              tone: 'warn',
              to: 'vendors',
            },
          ]}
          go={go}
          to="review"
        />

        <MetricRow
          kicker="Money"
          who="Weekly partner subscriptions — the only money Swift keeps"
          value={money(partnerWeekly)}
          valueState={moneyState}
          delta={
            moneyState === 'ready'
              ? 'List rate on active partner subscriptions · waivers, custom rates and non-GYD pricing are not applied'
              : null
          }
          deltaTone="warn"
          drills={[
            {
              label: 'Paying partners',
              value: count(payingPartners),
              state: moneyState,
              tone: 'calm',
              to: 'money',
            },
            {
              label: 'Past due',
              value: count(pastDueCount),
              state: pastDueState,
              tone: 'alert',
              to: 'money',
            },
          ]}
          go={go}
          to="money"
        />

        <MetricRow
          kicker="On the road"
          who="Right now, this minute"
          value={count(activeRiders + activeDrivers)}
          valueState={onRoadState}
          delta={onRoadState === 'ready' ? `${count(activeRiders)} riders · ${count(activeDrivers)} taxis` : null}
          drills={[
            {
              label: 'Orders in flight',
              value: activeOrderRows.length === 300 ? '300+' : count(activeOrderRows.length),
              state: activeOrdersState,
              tone: 'calm',
              to: 'ops',
            },
            {
              label: 'Past SLA',
              value: slaDisplay,
              state: slaState,
              tone: 'alert',
              to: 'stuck',
            },
            {
              label: 'Nobody accepted',
              value: exhaustedDisplay,
              state: exhaustedState,
              tone: 'warn',
              to: 'ops',
            },
            {
              label: 'Completed today',
              value: count(completedToday),
              state: completedTodayState,
              tone: 'good',
              to: 'ops',
            },
          ]}
          go={go}
          to="ops"
        />

        <MetricRow
          kicker="Compliance"
          who="The liability shield, checked daily"
          value={count(unresolvedCompliance)}
          valueState={complianceState}
          delta={
            complianceShapeState !== 'ready'
              ? null
              : latestRunAt === null
                ? 'No audit run recorded yet'
                : latestRunForcedOffline === null
                  ? `Last audit ran at ${latestRunAt}`
                  : `${count(latestRunForcedOffline)} forced offline at ${latestRunAt}`
          }
          deltaTone={latestRunForcedOffline ? 'warn' : 'good'}
          drills={[
            {
              label: 'Re-verification due',
              value: reviewQueueDisplay,
              state: complianceShapeState,
              tone: 'warn',
              to: 'compliance',
            },
            {
              label: 'Movers checked today',
              value: moversCheckedDisplay,
              state: complianceShapeState,
              tone: 'calm',
              to: 'compliance',
            },
            {
              label: 'Audit runs kept',
              value: runsKeptDisplay,
              state: complianceShapeState,
              tone: 'good',
              to: 'compliance',
            },
          ]}
          go={go}
          to="compliance"
        />
      </div>

      <section className="today-fire">
        <div className="today-fire-head">
          <h3 className="today-fire-title">On fire right now</h3>
          <span className="cadence-label">10–60s</span>
        </div>
        <div className="today-fire-list">
          {visibleFireSignals.length > 0 ? visibleFireSignals.map((signal) => (
            <SignalRow
              key={signal.label}
              label={signal.label}
              detail={signal.detail}
              value={signal.value}
              state={signal.state}
              tone={signal.tone}
              go={go}
              to={signal.to}
            />
          )) : (
            <EmptyFeed>
              {fireFeedsComplete
                ? 'No open items in the monitored priority feeds.'
                : 'Priority feeds are still loading.'}
            </EmptyFeed>
          )}
        </div>
      </section>

      <p className="today-gaps">
        <strong>Not shown, because the admin API exposes no source:</strong> documents submitted since
        yesterday, re-submissions, documents approved today, documents blocked on insurance, documents
        lapsing in 30 days, week-over-week revenue, next-week subscription forecast, churn this month,
        collected (waiver-aware) revenue, and applications by funnel stage. Mission Control leaves an
        operations number out rather than invent it.
      </p>
    </div>
  );
}
