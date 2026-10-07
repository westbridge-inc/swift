'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import {
  BOOKING_HOURS, JOB_STATUS, ON_SITE, formatAppointmentSlot, serviceJobScheduleSelection, servicesApi, upcomingAppointmentDays,
  type ServiceJob,
} from '@/lib/service-jobs';
import { money } from '@/lib/customer';
import { useCustomerSession } from '@/components/customer-session';
import { DataUnavailable } from '@/components/data-unavailable';

/**
 * [W11] One request to a local pro, the customer's side — the app's job card
 * (ServiceJobsScreen): the quote, accepting it by booking a time, cancelling
 * before it is booked, and rating the work once it is done. Talking to the pro
 * happens in the app's chat; the emergency numbers are on the page whenever
 * someone is coming or on site.
 */
export default function ServiceRequestPage() {
  const { id } = useParams<{ id: string }>();
  const { scope, epoch } = useCustomerSession();
  const queryClient = useQueryClient();
  const key = ['services', 'job', scope, epoch, id] as const;
  const job = useQuery({ queryKey: key, queryFn: () => servicesApi.job(id) });
  const settle = (next: ServiceJob) => {
    queryClient.setQueryData(key, next);
    void queryClient.invalidateQueries({ queryKey: ['services', 'jobs'] });
  };

  if (job.isError && !job.data) return <DataUnavailable what="this request" error={job.error} onRetry={() => void job.refetch()} />;
  if (!job.data) return <p role="status" className="text-sm text-[var(--swift-muted)]">Loading this request…</p>;
  const view = job.data;
  return (
    <div className="flex max-w-[640px] flex-col">
      <span className="sw-eyebrow">Service request</span>
      <h1 className="sw-title mt-1">{JOB_STATUS[view.status] ?? view.status}</h1>
      <p className="sw-card mt-4 whitespace-pre-line p-4 text-[15px] leading-[22px]">{view.description}</p>

      {view.status === 'REQUESTED' ? <p className="sw-caption mt-3">The pro has your request and will reply with a price.</p> : null}
      {view.status === 'QUOTED' && view.quoteAmount != null ? (
        <div className="sw-card mt-3 p-4">
          <p className="sw-money-lg">{money(view.quoteAmount)}</p>
          <p className="sw-caption mt-1">Cash on completion — accept by booking a time.</p>
          <BookTime job={view} onBooked={settle} />
        </div>
      ) : null}
      {view.status === 'SCHEDULED' ? (
        <div className="sw-card mt-3 p-4">
          <p className="text-[15px] font-semibold leading-[22px]">Booked for {view.scheduledFor ? formatAppointmentSlot(view.scheduledFor) : '—'}</p>
          <p className="sw-caption mt-1">
            {view.quoteAmount != null ? `Agreed price ${money(view.quoteAmount)} · cash on completion. ` : ''}
            {view.providerConfirmedAt ? 'The pro confirmed the time.' : 'Waiting for the pro to confirm the time.'}
          </p>
        </div>
      ) : null}
      {view.status === 'COMPLETED' ? <RateWork job={view} /> : null}

      {ON_SITE.has(view.status) ? (
        <div className="mt-3 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-4 text-sm">
          <p className="font-semibold text-[var(--swift-error)]">Emergency?</p>
          <p className="mt-1 text-[var(--swift-muted)]">Call for help straight away. Swift’s emergency button, which alerts Swift’s team, is in the Swift app.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <a href="tel:911" className="rounded-full bg-[var(--swift-error)] px-4 py-2 text-sm font-semibold text-[var(--swift-white)]">Police 911</a>
            <a href="tel:913" className="rounded-full border border-[var(--swift-error)] px-4 py-2 text-sm font-semibold text-[var(--swift-error)]">Ambulance 913</a>
          </div>
        </div>
      ) : null}

      {['REQUESTED', 'QUOTED'].includes(view.status) ? <CancelRequest job={view} onCancelled={settle} /> : null}
      {!['COMPLETED', 'CANCELLED'].includes(view.status) ? (
        <p className="sw-caption mt-4">To talk to the pro, use the job chat in the Swift app.</p>
      ) : null}
      <Link href="/services/requests" className="sw-link mt-6">All your requests</Link>
    </div>
  );
}

function BookTime({ job, onBooked }: { job: ServiceJob; onBooked: (_job: ServiceJob) => void }) {
  const days = upcomingAppointmentDays();
  const [day, setDay] = useState(days[0]!.key);
  const [time, setTime] = useState('09:00');
  const [past, setPast] = useState(false);
  const book = useMutation({ mutationFn: (scheduledFor: string) => servicesApi.schedule(job.id, scheduledFor), onSuccess: onBooked });
  const confirm = () => {
    const { scheduledFor, isPast } = serviceJobScheduleSelection(day, time);
    setPast(isPast);
    if (!isPast) book.mutate(scheduledFor);
  };
  return (
    <div className="mt-4">
      <fieldset>
        <legend className="sw-field-label">Pick a day</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {days.map((option) => (
            <button key={option.key} type="button" aria-pressed={option.key === day} onClick={() => setDay(option.key)} className="sw-chip">{option.label}</button>
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-4">
        <legend className="sw-field-label">Pick a time</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {BOOKING_HOURS.map((hour) => (
            <button key={hour} type="button" aria-pressed={hour === time} onClick={() => setTime(hour)} className="sw-chip">{hour}</button>
          ))}
        </div>
      </fieldset>
      {past ? <p role="alert" className="sw-note sw-note-error mt-3">That time has already passed today — pick a later one.</p> : null}
      {book.isError ? <p role="alert" className="sw-note sw-note-error mt-3">{(book.error as Error).message}</p> : null}
      <button type="button" onClick={confirm} disabled={book.isPending} className="sw-btn sw-btn-block mt-4">
        {book.isPending ? 'Booking…' : `Accept and book — ${days.find((option) => option.key === day)?.label ?? ''} ${time}`}
      </button>
    </div>
  );
}

function CancelRequest({ job, onCancelled }: { job: ServiceJob; onCancelled: (_job: ServiceJob) => void }) {
  const [asking, setAsking] = useState(false);
  const cancel = useMutation({ mutationFn: () => servicesApi.cancel(job.id), onSuccess: onCancelled });
  if (!asking) return <button type="button" onClick={() => setAsking(true)} className="sw-btn sw-btn-md sw-btn-outline mt-4 self-start">Cancel request</button>;
  return (
    <div role="group" aria-label="Cancel this request?" className="sw-card mt-4 p-4">
      <p className="text-[15px] font-semibold leading-[22px]">Cancel this request?</p>
      <p className="sw-caption mt-1">The pro is told no visit is happening.</p>
      {cancel.isError ? <p role="alert" className="sw-note sw-note-error mt-3">{(cancel.error as Error).message}</p> : null}
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending} className="sw-btn sw-btn-sm sw-btn-ink">{cancel.isPending ? 'Cancelling…' : 'Yes, cancel'}</button>
        <button type="button" onClick={() => setAsking(false)} className="sw-btn sw-btn-sm sw-btn-outline">Keep it</button>
      </div>
    </div>
  );
}

function RateWork({ job }: { job: ServiceJob }) {
  const [score, setScore] = useState(0);
  const rate = useMutation({ mutationFn: (value: number) => servicesApi.rate(job.id, value) });
  return (
    <div className="sw-card mt-3 p-4">
      <p className="text-[15px] font-semibold leading-[22px]">How did the job go?</p>
      <div role="radiogroup" aria-label="Rate the work" className="mt-2 flex gap-1">
        {[1, 2, 3, 4, 5].map((value) => (
          <button key={value} type="button" role="radio" aria-checked={score === value} aria-label={`${value} star${value === 1 ? '' : 's'}`}
            disabled={rate.isPending || rate.isSuccess}
            onClick={() => { setScore(value); rate.mutate(value); }}
            className="grid h-11 w-11 place-items-center rounded-full">
            <Star size={24} aria-hidden className={value <= score ? 'fill-[var(--swift-star)] text-[var(--swift-star)]' : 'text-[var(--swift-border-strong)]'} />
          </button>
        ))}
      </div>
      {rate.isSuccess ? <p role="status" className="mt-2 text-sm font-semibold text-[var(--swift-success)]">Thanks — your rating is saved.</p> : null}
      {rate.isError ? <p role="alert" className="sw-note sw-note-error mt-2">{(rate.error as Error).message}</p> : null}
    </div>
  );
}
