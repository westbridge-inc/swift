'use client';

import { FileText } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fetchAuditLogs } from '@/lib/api';

interface AuditEntry {
  id: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string;
  ipAddress: string | null;
  createdAt: string;
}

export default function AuditPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs'],
    queryFn: () => fetchAuditLogs('limit=50'),
    refetchInterval: 30_000,
  });
  const entries: AuditEntry[] = data?.data ?? [];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Audit Log</h1>
      <p className="text-[#8E8E93] text-sm mb-6">
        Every admin action — vendor approvals, document reviews, config changes, claim payouts — append-only.
      </p>

      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-[#8E8E93] text-sm">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="p-12 flex flex-col items-center justify-center text-center">
            <FileText size={48} className="text-[#8E8E93] mb-4" />
            <h2 className="text-lg font-semibold mb-2">No audit events yet</h2>
            <p className="text-[#8E8E93] text-sm max-w-md">
              Admin actions are recorded here as they happen.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#38383A]">
            {entries.map((e) => (
              <div key={e.id} className="flex items-center gap-4 p-4">
                <div className="w-2 h-2 rounded-full bg-[#E8192C] shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">
                    {e.action} <span className="text-[#8E8E93] font-normal">· {e.entity} {e.entityId}</span>
                  </p>
                  <p className="text-xs text-[#8E8E93]">
                    {e.userId ? `by ${e.userId}` : 'system'}
                    {e.ipAddress ? ` · ${e.ipAddress}` : ''}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-[#8E8E93]">{new Date(e.createdAt).toLocaleString()}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
