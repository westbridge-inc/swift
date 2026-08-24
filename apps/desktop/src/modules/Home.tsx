import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
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

const count = (value: number) => value.toLocaleString('en-GY');

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

function SignalRow({
  label,
  detail,
  value,
  state,
  go,
  to,
}: {
  label: string;
  detail: string;
  value: string;
  state: FeedState;
  go: (module: ModuleKey) => void;
  to: ModuleKey;
}) {
  return (
    <button className="signal-row" onClick={() => go(to)} disabled={state !== 'ready'}>
      <span className="signal-marker" aria-hidden="true" />
      <span className="signal-copy">
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

  const documentRows = Array.isArray(documents.data?.rows) ? documents.data.rows : [];
  const documentTotal = documents.data?.meta.total;
  const documentState = stateWhen(documents, Array.isArray(documents.data?.rows) && finite(documentTotal));
  const oldestDocument = documentRows[0];
  const oldest = oldestWait(oldestDocument?.createdAt);

  const slaRows = Array.isArray(stuck.data?.rows) ? stuck.data.rows : [];
  const slaState = stateWhen(stuck, Array.isArray(stuck.data?.rows) && typeof stuck.data?.truncated === 'boolean');
  const slaCount = slaRows.length;
  const slaDisplay = stuck.data?.truncated
    ? slaCount > 0 ? `${count(slaCount)}+` : 'Scan capped'
    : count(slaCount);
  const exhaustedRows = Array.isArray(live.data?.exhaustedSearches) ? live.data.exhaustedSearches : [];
  const activeOrderRows = Array.isArray(live.data?.activeOrders) ? live.data.activeOrders : [];
  const exhaustedState = stateWhen(live, Array.isArray(live.data?.exhaustedSearches));
  const activeOrdersState = stateWhen(live, Array.isArray(live.data?.activeOrders));
  const exhaustedCount = exhaustedRows.length;
  const exhaustedDisplay = exhaustedCount === 50 ? '50+' : count(exhaustedCount);
  const reportState = stateWhen(reports, finite(reports.data?.pendingTotal));
  const reportCount = reports.data?.pendingTotal ?? 0;
  const ticketState = stateWhen(tickets, finite(tickets.data?.total));
  const ticketCount = tickets.data?.total ?? 0;
  const agentState = stateWhen(agent, Array.isArray(agent.data));
  const agentRows = Array.isArray(agent.data) ? agent.data : [];
  const agentDisplay = agentRows.length === 100 ? '100+' : count(agentRows.length);
  const complianceState = stateWhen(compliance, finite(compliance.data?.unresolvedCount));
  const unresolvedCompliance = Number(compliance.data?.unresolvedCount ?? 0);
  const onRoadState = stateWhen(
    overview,
    finite(overview.data?.activeRiders) && finite(overview.data?.activeDrivers),
  );

  const fireSignals = [
    {
      label: 'Orders past SLA',
      detail: stuck.data?.truncated
        ? `At least this many in the endpoint's capped ${count(stuck.data.scanCap)}-order scan`
        : 'Delivery stages outside their live threshold',
      value: slaDisplay,
      raw: slaCount,
      incomplete: Boolean(stuck.data?.truncated),
      state: slaState,
      to: 'stuck' as const,
    },
    {
      label: 'Searches exhausted',
      detail: exhaustedCount === 50 ? 'At least this many unresolved in the last 24 hours' : 'No mover found or resolution recorded in the last 24 hours',
      value: exhaustedDisplay,
      raw: exhaustedCount,
      state: exhaustedState,
      to: 'ops' as const,
    },
    {
      label: 'Compliance violations',
      detail: 'Open findings from the compliance authority',
      value: count(unresolvedCompliance),
      raw: unresolvedCompliance,
      state: complianceState,
      to: 'compliance' as const,
    },
    {
      label: 'Content reports',
      detail: 'Pending moderation decisions',
      value: count(reportCount),
      raw: reportCount,
      state: reportState,
      to: 'moderation' as const,
    },
    {
      label: 'Support tickets',
      detail: 'Open in-app requests; email and calls are not included',
      value: count(ticketCount),
      raw: ticketCount,
      state: ticketState,
      to: 'support' as const,
    },
    {
      label: 'Agent proposals',
      detail: agentRows.length === 100 ? 'At least this many waiting; the feed is capped' : 'Machine-proposed actions waiting for a person',
      value: agentDisplay,
      raw: agentRows.length,
      state: agentState,
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
    <div className="briefing-view">
      <section className="briefing-lede">
        <div>
          <p className="eyebrow">Human attention</p>
          <h2>Live signals, source by source. No invented total.</h2>
          <p className="briefing-intro">
            The API does not deduplicate work across queues, so Mission Control shows the real source counts below instead of guessing at one headline number.
          </p>
        </div>
        <div className="briefing-live">
          <span className="live-dot" aria-hidden="true" />
          <div>
            <strong>Live while this view is open</strong>
            <small>Live orders and searches: 10s · documents and SLA: 30s · other queues: 20–60s</small>
          </div>
          <button className="icon-button" onClick={refreshAll} disabled={refreshing} aria-label="Refresh all briefing feeds">
            <span aria-hidden="true">↻</span>
          </button>
        </div>
      </section>

      <div className="briefing-primary-grid">
        <section className="briefing-panel fire-panel">
          <header className="panel-heading">
            <div>
              <p className="eyebrow">Priority</p>
              <h3>On fire right now</h3>
            </div>
            <span className="cadence-label">10–60s</span>
          </header>
          <div className="signal-list">
            {visibleFireSignals.length > 0 ? visibleFireSignals.map((signal) => (
              <SignalRow key={signal.label} {...signal} go={go} />
            )) : (
              <EmptyFeed>
                {fireFeedsComplete
                  ? 'No open items in the monitored priority feeds.'
                  : 'Priority feeds are still loading.'}
              </EmptyFeed>
            )}
          </div>
        </section>

        <section className="briefing-panel document-depth-panel">
          <header className="panel-heading">
            <div>
              <p className="eyebrow">Oldest first</p>
              <h3>Document queue</h3>
            </div>
            <span className="cadence-label">30s</span>
          </header>
          <div className="depth-body">
            <FeedValue state={documentState}>
              <span className="hero-number">{count(documentTotal ?? 0)}</span>
            </FeedValue>
            {documentState === 'ready' && (
              <p className="depth-note">
                {documentTotal === 0
                  ? 'Nobody is waiting on a document decision.'
                  : `waiting on a person${oldest ? ` · oldest submitted ${oldest} ago` : ''}`}
              </p>
            )}
            {documentState === 'error' && (
              <p className="feed-error-copy">{(documents.error as Error).message}</p>
            )}
          </div>
          <button className="primary-button" onClick={() => go('review')} disabled={documentState !== 'ready'}>
            Start triage <span aria-hidden="true">→</span>
          </button>
        </section>
      </div>

      <div className="briefing-secondary-grid">
        <section className="briefing-panel road-panel">
          <header className="panel-heading">
            <div>
              <p className="eyebrow">Operational presence</p>
              <h3>On the road now</h3>
            </div>
            <span className="cadence-label">10–30s</span>
          </header>
          <div className="road-metrics">
            <div>
              <FeedValue state={onRoadState}>
                <span className="metric-number">{count(overview.data?.activeRiders ?? 0)}</span>
              </FeedValue>
              <span>riders online</span>
            </div>
            <div>
              <FeedValue state={onRoadState}>
                <span className="metric-number">{count(overview.data?.activeDrivers ?? 0)}</span>
              </FeedValue>
              <span>taxis online</span>
            </div>
            <div>
              <FeedValue state={activeOrdersState}>
                <span className="metric-number">
                  {activeOrderRows.length === 300 ? '300+' : count(activeOrderRows.length)}
                </span>
              </FeedValue>
              <span>{activeOrderRows.length === 300 ? 'active orders · at least' : 'active orders'}</span>
            </div>
          </div>
          <button className="text-button" onClick={() => go('ops')}>Open live operations <span aria-hidden="true">→</span></button>
        </section>

        <section className="briefing-panel money-panel">
          <header className="panel-heading">
            <div>
              <p className="eyebrow">Business subscriptions only</p>
              <h3>Subscription money</h3>
            </div>
            <span className="cadence-label">60s</span>
          </header>
          <EmptyFeed>
            Effective revenue is not available from the admin API. Current aggregates ignore some waivers, custom rates and USD pricing.
          </EmptyFeed>
          <dl className="money-facts">
            <div>
              <dt>Revenue collected</dt>
              <dd className="gap-label">No partner-only source</dd>
            </div>
            <div>
              <dt>Past-due business status</dt>
              <dd>
                {pastDue.isLoading
                  ? 'Loading'
                  : pastDue.isError ? 'Unavailable' : `${count(pastDue.data?.statusCount ?? 0)} business records`}
              </dd>
            </div>
            <div>
              <dt>Effective amount due</dt>
              <dd className="gap-label">No waiver-aware source</dd>
            </div>
            <div>
              <dt>Next-week forecast</dt>
              <dd className="gap-label">No API source</dd>
            </div>
          </dl>
          <button className="text-button" onClick={() => go('money')}>Open money <span aria-hidden="true">→</span></button>
        </section>

        <section className="briefing-panel application-panel">
          <header className="panel-heading">
            <div>
              <p className="eyebrow">Funnel</p>
              <h3>Applications by stage</h3>
            </div>
          </header>
          <EmptyFeed>
            Stage totals are not available from the admin API. Document counts are not presented as applicant counts.
          </EmptyFeed>
          <button className="text-button" onClick={() => go('vendors')}>Open business records <span aria-hidden="true">→</span></button>
        </section>
      </div>
    </div>
  );
}
