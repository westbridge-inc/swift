'use client';

import { FileText } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fetchAuditLogs } from '@/lib/api';
import { humanise } from '@/lib/labels';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { gyDateTime } from '@/lib/dates';

interface AuditEntry {
  id: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string;
  ipAddress: string | null;
  createdAt: string;
}

/** "PlatformConfig" -> "Platform config". */
const entityWords = (entity: string) => humanise(entity.replace(/([a-z])([A-Z])/g, '$1_$2'));

const when = (iso: string) => gyDateTime(iso);

// [ADMIN-UI] Mission Control: the shell header is the page title; the record is
// a light list, the action in plain words (the code stays in the row's title).
export default function AuditPage() {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['audit-logs'],
    queryFn: () => fetchAuditLogs('limit=50'),
    refetchInterval: 30_000,
  });
  const entries: AuditEntry[] = data?.data ?? [];

  return (
    <div className="mc-page">
      <p className="mc-muted mb-4">
        Every recorded action — admins’ approvals, document decisions, setting changes and claim payouts, and the claims customers and partners make. Nothing here can be edited or deleted.
      </p>

      {isLoading ? (
        <div className="mc-loading" aria-busy="true">Loading the audit log…</div>
      ) : isError ? (
        <QueryFailed error={error} what="the audit log" onRetry={() => void refetch()} retrying={isFetching} />
      ) : entries.length === 0 ? (
        <div className="mc-empty">
          <FileText size={32} className="mx-auto mb-3" aria-hidden="true" />
          <p className="mc-card-title mb-1">No audit events yet</p>
          <p>Admin actions are recorded here as they happen.</p>
        </div>
      ) : (
        <ul className="mc-table-wrap mc-list-plain" aria-label="Audit log">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start gap-3 px-4 py-3">
              <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--mc-accent)]" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold" title={e.action}>
                  {humanise(e.action)} <span className="mc-muted font-normal">· {entityWords(e.entity)} <span className="mc-mono">{e.entityId}</span></span>
                </p>
                <p className="mc-muted text-xs">
                  {e.userId ? <>By account <span className="mc-mono">{e.userId}</span></> : 'By the system'}
                  {e.ipAddress ? <> · from <span className="mc-mono">{e.ipAddress}</span></> : null}
                </p>
              </div>
              <p className="mc-muted mc-numbers shrink-0 text-xs">{when(e.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
