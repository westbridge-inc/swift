'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { getSessionPrincipal } from '@/lib/auth';
import { JOB_STATUS, formatAppointmentSlot, servicesApi } from '@/lib/service-jobs';
import { money } from '@/lib/customer';
import { useCustomerSession } from '@/components/customer-session';
import { DataUnavailable } from '@/components/data-unavailable';
import { EmptyNote } from '@/components/order-ui';

/** [W11] A customer's own requests to local pros (GET /services/jobs), newest first. */
export default function ServiceRequestsPage() {
  const { scope, epoch } = useCustomerSession();
  const jobs = useQuery({ queryKey: ['services', 'jobs', scope, epoch], queryFn: servicesApi.jobs });
  // The list also holds jobs this account does AS a pro; this page is the customer's side.
  const mine = (jobs.data ?? []).filter((job) => job.customerId === getSessionPrincipal());
  return (
    <div className="flex flex-col">
      <span className="sw-eyebrow">Services</span>
      <h1 className="sw-title mt-1">Your requests</h1>
      {jobs.isError && !jobs.data ? (
        <div className="mt-5"><DataUnavailable what="your requests" error={jobs.error} onRetry={() => void jobs.refetch()} /></div>
      ) : !jobs.data ? (
        <p role="status" className="mt-5 text-sm text-[var(--swift-muted)]">Loading your requests…</p>
      ) : mine.length === 0 ? (
        <div className="mt-5"><EmptyNote>You haven’t asked a pro for a quote yet. <Link href="/services" className="sw-link">Find a pro</Link></EmptyNote></div>
      ) : (
        <ul className="mt-5 flex flex-col gap-3">
          {mine.map((job) => (
            <li key={job.id}>
              <Link href={`/services/requests/${encodeURIComponent(job.id)}`} className="sw-card flex items-center gap-3 p-4">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold leading-[22px]">{job.description}</span>
                  <span className="block text-[13px] leading-[18px] text-[var(--swift-muted)]">
                    {JOB_STATUS[job.status] ?? job.status}
                    {job.status === 'QUOTED' && job.quoteAmount != null ? ` · ${money(job.quoteAmount)}` : ''}
                    {job.scheduledFor ? ` · ${formatAppointmentSlot(job.scheduledFor)}` : ''}
                  </span>
                </span>
                <ChevronRight size={18} aria-hidden className="text-[var(--swift-muted)]" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
