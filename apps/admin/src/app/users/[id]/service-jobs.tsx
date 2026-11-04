'use client';

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { closeServiceJob, fetchUserServiceJobs, type AdminServiceJob } from '@/lib/api';
import type { Outcome } from '@/lib/outcome';
import { DataTable } from '@/components/mc/DataTable';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { Truncate } from '@/components/mc/Truncate';
import { gyDateTime } from '@/lib/dates';

const CLOSED = new Set(['COMPLETED', 'CANCELLED']);

function statusWords(job: AdminServiceJob): string {
  if (job.status === 'SCHEDULED') return job.providerConfirmedAt ? 'Booked' : 'Waiting for the pro';
  const words: Record<string, string> = { REQUESTED: 'Requested', QUOTED: 'Quoted', IN_PROGRESS: 'Started', COMPLETED: 'Done', CANCELLED: 'Cancelled' };
  return words[job.status] ?? job.status;
}

const fullName = (who: { firstName: string | null; lastName: string | null }) => [who.firstName, who.lastName].filter(Boolean).join(' ') || 'Unnamed';

/** The other person on a job, seen from the person this page is about. */
function otherSide(job: AdminServiceJob, userId: string) {
  return job.customer.id === userId
    ? { id: job.provider.userId, name: fullName(job.provider.user) }
    : { id: job.customer.id, name: fullName(job.customer) };
}

/** A person's service jobs, as customer or as pro. Support closes one nobody else can, with a reason. */
export function ServiceJobsCard({ userId, onResult }: { userId: string; onResult: (_outcome: Outcome | null) => void }) {
  const qc = useQueryClient();
  const dialog = useActionDialog();
  const list = useQuery({ queryKey: ['user-service-jobs', userId], queryFn: () => fetchUserServiceJobs(userId) });

  const close = async (job: AdminServiceJob) => {
    const outcome = await dialog.run({
      title: 'Close this job?',
      body: <p>Use this when neither side can close it. Both sides are told. Swift moves no money.</p>,
      confirmLabel: 'Close job',
      dismissLabel: 'Keep the job',
      reason: { hint: 'Kept on the permanent record, not shown to either side.' },
      submit: ({ reason }) => closeServiceJob(job.id, reason),
      success: () => 'The job is closed and both sides are told.',
    });
    onResult(outcome);
    if (outcome) void qc.invalidateQueries({ queryKey: ['user-service-jobs', userId] });
  };

  return (
    <section aria-labelledby="service-jobs" className="space-y-2">
      <h2 id="service-jobs" className="mc-label">Service jobs</h2>
      {list.isError ? (
        <QueryFailed error={list.error} what="this person's service jobs" onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <DataTable<AdminServiceJob>
          label="Service jobs"
          rows={list.data?.data ?? []}
          rowKey={(job) => job.id}
          empty={list.isLoading ? 'Loading…' : 'No service jobs.'}
          columns={[
            { key: 'job', header: 'Job', width: '34%', primary: true, cell: (job) => <Truncate text={job.description} /> },
            { key: 'with', header: 'With', width: '22%', cell: (job) => { const other = otherSide(job, userId); return <Link href={`/users/${other.id}`}>{other.name}</Link>; } },
            { key: 'when', header: 'Time', width: '18%', cell: (job) => (job.scheduledFor ? gyDateTime(job.scheduledFor) : 'Not set') },
            { key: 'status', header: 'Status', width: '14%', cell: (job) => <span className="mc-badge">{statusWords(job)}</span> },
            { key: 'close', header: '', width: '12%', align: 'right', cell: (job) => (CLOSED.has(job.status) ? null : <button type="button" className="mc-btn" onClick={() => void close(job)}>Close job…</button>) },
          ]}
        />
      )}
    </section>
  );
}
