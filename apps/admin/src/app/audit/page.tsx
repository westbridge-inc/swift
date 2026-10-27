'use client';

import { useState } from 'react';
import { FileText } from 'lucide-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchAuditLogs } from '@/lib/api';
import { humanise } from '@/lib/labels';
import { describeAction } from '@/lib/approvals';
import { QueryFailed } from '@/components/mc/QueryFailed';

interface AuditEntry {
  id: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string;
  ipAddress: string | null;
  createdAt: string;
  /** [ADMIN-AUDIT S3-5] The account's name (null: not an account of this market any more). */
  actorName?: string | null;
  /** The reason the person stated, as recorded; null when none was. */
  reason?: string | null;
}

/** [ADMIN-AUDIT S3-5] "ADMIN PUT /subscriptions/:id/waive-fee" is a route: say it as the approvals queue does. */
const actionWords = (action: string) => {
  const route = /^ADMIN (GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(action);
  // Rows written by the request hook carry the mount point (/api/v1/admin/…): the words name the route itself.
  return route ? describeAction(`${route[1]} ${(route[2] ?? '').replace(/^\/api\/v1(\/admin)?(?=\/)/, '')}`) : humanise(action);
};

/** A Guyana calendar day as the server's instant bounds (Guyana is UTC-4 all year). */
const dayStart = (ymd: string) => `${ymd}T00:00:00.000-04:00`;
const dayEnd = (ymd: string) => `${ymd}T23:59:59.999-04:00`;
const LIMIT = 50;
type Filters = { action: string; entity: string; from: string; to: string };
const NO_FILTERS: Filters = { action: '', entity: '', from: '', to: '' };

/** "PlatformConfig" -> "Platform config". */
const entityWords = (entity: string) => humanise(entity.replace(/([a-z])([A-Z])/g, '$1_$2'));

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// [ADMIN-UI] Mission Control: the shell header is the page title; the record is
// a light list, the action in plain words (the code stays in the row's title).
export default function AuditPage() {
  // [ADMIN-AUDIT S3-5] The server pages and filters; the page asks it to (it used to show the last 50, unfiltered).
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const query = new URLSearchParams({ limit: String(LIMIT), page: String(page) });
  if (filters.action.trim()) query.set('action', filters.action.trim());
  if (filters.entity.trim()) query.set('entity', filters.entity.trim());
  if (filters.from) query.set('dateFrom', dayStart(filters.from));
  if (filters.to) query.set('dateTo', dayEnd(filters.to));
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['audit-logs', page, filters],
    queryFn: () => fetchAuditLogs(query.toString()),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  const entries: AuditEntry[] = data?.data ?? [];
  const meta = data?.meta as { total?: number; totalPages?: number; hasNext?: boolean; hasPrev?: boolean } | undefined;
  const filtered = Object.values(filters).some((v) => v.trim() !== '');
  const show = (e: React.FormEvent) => { e.preventDefault(); setFilters(draft); setPage(1); };

  return (
    <div className="mc-page">
      <p className="mc-muted mb-4">
        Every recorded action — admins’ approvals, document decisions, setting changes and claim payouts, and the claims customers and partners make. Nothing here can be edited or deleted.
      </p>

      <form className="mc-card mb-4 flex flex-wrap items-end gap-3" onSubmit={show} aria-label="Filter the audit log">
        <label className="text-xs">What happened<input className="mc-input block" aria-label="What happened" placeholder="e.g. waive, approve" value={draft.action} maxLength={100} onChange={(e) => setDraft({ ...draft, action: e.target.value })} /></label>
        <label className="text-xs">Record<input className="mc-input block" aria-label="Record" placeholder="e.g. subscriptions, Vendor" value={draft.entity} maxLength={100} onChange={(e) => setDraft({ ...draft, entity: e.target.value })} /></label>
        <label className="text-xs">From<input type="date" className="mc-input block" aria-label="From" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label>
        <label className="text-xs">To<input type="date" className="mc-input block" aria-label="To" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label>
        <button type="submit" className="mc-btn mc-btn-primary">Show</button>
        {filtered && <button type="button" className="mc-btn" onClick={() => { setDraft(NO_FILTERS); setFilters(NO_FILTERS); setPage(1); }}>Clear</button>}
      </form>

      {isLoading ? (
        <div className="mc-loading" aria-busy="true">Loading the audit log…</div>
      ) : isError ? (
        <QueryFailed error={error} what="the audit log" onRetry={() => void refetch()} retrying={isFetching} />
      ) : entries.length === 0 ? (
        <div className="mc-empty">
          <FileText size={32} className="mx-auto mb-3" aria-hidden="true" />
          <p className="mc-card-title mb-1">{filtered ? 'No audit events match these filters' : 'No audit events yet'}</p>
          <p>{filtered ? 'Change or clear the filters to see more.' : 'Admin actions are recorded here as they happen.'}</p>
        </div>
      ) : (
        <ul className="mc-table-wrap mc-list-plain" aria-label="Audit log">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start gap-3 px-4 py-3">
              <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--mc-accent)]" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold" title={e.action}>
                  {actionWords(e.action)} <span className="mc-muted font-normal">· {entityWords(e.entity)} <span className="mc-mono">{e.entityId}</span></span>
                </p>
                {/* [ADMIN-AUDIT S3-5] the why: the reason the person stated, as recorded */}
                {e.reason ? <p className="text-sm">“{e.reason}”</p> : null}
                <p className="mc-muted text-xs">
                  {e.actorName ? <>By {e.actorName}</>
                    : !e.userId ? 'By the system'
                    : e.actorName === null ? <>By an account not found here <span className="mc-mono">{e.userId}</span></>
                    : <>By account <span className="mc-mono">{e.userId}</span></>}
                  {e.ipAddress ? <> · from <span className="mc-mono">{e.ipAddress}</span></> : null}
                </p>
              </div>
              <p className="mc-muted mc-numbers shrink-0 text-xs">{when(e.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}
      {meta && (meta.total ?? 0) > 0 && (
        <nav className="mt-3 flex items-center gap-3 text-sm" aria-label="Audit log pages">
          <button type="button" className="mc-btn" aria-label="Previous page" disabled={!meta.hasPrev || isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
          <span className="mc-muted">{meta.total} events · page {page} of {Math.max(1, meta.totalPages ?? 1)}</span>
          <button type="button" className="mc-btn" aria-label="Next page" disabled={!meta.hasNext || isFetching} onClick={() => setPage((p) => p + 1)}>Next</button>
        </nav>
      )}
    </div>
  );
}
