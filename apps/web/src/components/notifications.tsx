'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { getNotifications } from '@/lib/partner-api';
import { DataUnavailable } from './data-unavailable';

export function Notifications() {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['web-notifications', page], queryFn: () => getNotifications(page) });
  return <section className="max-w-3xl space-y-6"><div className="flex items-center gap-3"><Bell size={24} aria-hidden /><h1 className="sw-title">Notifications</h1></div>
    {q.isLoading && <div role="status" className="sw-empty"><span className="sw-skeleton h-24 w-full" />Loading notifications…</div>}
    {q.isError && <DataUnavailable what="your notifications" error={q.error} onRetry={() => void q.refetch()} />}
    {q.data && <>
      {q.data.rows.length === 0 ? <div className="sw-empty"><h2 className="sw-heading">You’re all caught up</h2><p className="sw-caption">Updates from Swift will appear here.</p></div> : <ul className="divide-y divide-[var(--swift-border)]">{q.data.rows.map(n => <li key={n.id} className="py-5">
        <div className="flex items-start gap-3">{!n.isRead && <span className="mt-2 h-2 w-2 flex-none rounded-full bg-[var(--swift-red)]" aria-label="Unread" />}<div><h2 className="sw-label">{n.title}</h2><p className="mt-1 whitespace-pre-wrap text-[15px] leading-[22px]">{n.body}</p><p className="sw-caption mt-2">{new Date(n.createdAt).toLocaleString('en-GB', { timeZone: 'America/Guyana' })}</p></div></div>
      </li>)}</ul>}
      <div className="flex items-center gap-3"><button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="sw-btn sw-btn-md sw-btn-outline">Previous</button><span className="sw-caption">Page {page}</span><button disabled={page * 20 >= q.data.total} onClick={() => setPage(p => p + 1)} className="sw-btn sw-btn-md sw-btn-outline">Next</button></div>
    </>}
  </section>;
}
