'use client';

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { site } from '@/site.config';
import { DataUnavailable } from '@/components/data-unavailable';
import { accountApi, type SupportCategory } from './account-api';
import { documentLabel } from '@/lib/partner-documents';
import { AccountFrame, buttonClass, fieldClass, useAccountQuery } from './account-frame';

const categories: { value: SupportCategory; label: string }[] = [
  { value: 'ORDER_ISSUE', label: 'Order issue' }, { value: 'PAYMENT', label: 'Payment' },
  { value: 'SAFETY', label: 'Safety' }, { value: 'MOVER', label: 'Rider / driver' },
  { value: 'VENDOR', label: 'Store' }, { value: 'ACCOUNT', label: 'Account' }, { value: 'OTHER', label: 'Something else' },
];

/** [DOCS-1] A partner's question about one of their documents. */
export type HelpTopic = Extract<SupportCategory, 'VENDOR' | 'MOVER'>;

export function Help({ orderId = '', topic, document }: { orderId?: string; topic?: HelpTopic; document?: string }) {
  const tickets = useAccountQuery('support', accountApi.tickets);
  const [category, setCategory] = useState<SupportCategory>(orderId ? 'ORDER_ISSUE' : topic ?? 'OTHER');
  const [order, setOrder] = useState(orderId);
  const [subject, setSubject] = useState(document ? `About my ${documentLabel(document)} review` : '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || subject.trim().length < 3 || message.trim().length < 5) return;
    sending.current = true; setBusy(true); setError(null); setSent(false);
    try {
      await accountApi.createTicket({ category, subject: subject.trim(), message: message.trim(), ...(order.trim() ? { orderId: order.trim() } : {}) });
      setSubject(''); setMessage(''); setSent(true); await tickets.refetch();
    } catch (e) { setError((e as Error).message); }
    finally { sending.current = false; setBusy(false); }
  }
  return <AccountFrame title="Help">
    <p>Tell us what happened. Track your request and our reply here.</p>
    <div className="flex flex-wrap gap-4 text-[var(--swift-red)] underline"><a href={`mailto:${site.supportEmail}`}>Email support</a><Link href="/faq">Frequently asked questions</Link><Link href="/account/safety">Safety</Link></div>
    <form onSubmit={submit} className="space-y-4 sw-card p-5">
      <fieldset disabled={busy} className="space-y-4">
        <label className="block space-y-1"><span>Topic</span><select className={fieldClass} value={category} onChange={(e) => setCategory(e.target.value as SupportCategory)}>{categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
        <label className="block space-y-1"><span>Order ID (optional)</span><input className={fieldClass} maxLength={64} value={order} onChange={(e) => setOrder(e.target.value)} /></label>
        <Link href="/orders" className="inline-block text-sm underline">Find your order</Link>
        <label className="block space-y-1"><span>Short summary</span><input className={fieldClass} required minLength={3} maxLength={120} value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
        <label className="block space-y-1"><span>What happened?</span><textarea className={fieldClass} required minLength={5} maxLength={2000} rows={5} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {sent && <p role="status">We’ve got it. Track your request below.</p>}
      <button className={buttonClass} disabled={busy || subject.trim().length < 3 || message.trim().length < 5}>{busy ? 'Sending…' : 'Send request'}</button>
    </form>
    <section className="space-y-3" aria-label="Your requests"><h2 className="font-bold">Your requests</h2>
      {tickets.isError ? <DataUnavailable what="your support requests" error={tickets.error} onRetry={() => void tickets.refetch()} />
        : !tickets.data ? <p role="status">Loading requests…</p>
        : tickets.data.length === 0 ? <p>No requests yet.</p>
        : <ul className="space-y-3">{tickets.data.map((ticket) => <li key={ticket.id} className="sw-card p-4"><h3 className="font-bold">{ticket.subject}</h3><p>{ticket.status === 'RESOLVED' ? 'Resolved' : ticket.status === 'IN_PROGRESS' ? 'In progress' : 'Open'}</p>{ticket.adminNote && <p>Swift: {ticket.adminNote}</p>}</li>)}</ul>}
    </section>
  </AccountFrame>;
}
