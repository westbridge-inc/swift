'use client';

import { useId, useState } from 'react';
import { broadcastNotification } from '@/lib/api';
import { useActionRunner } from '@/components/mc/useActionRunner';

const AUDIENCES = [
  { value: '', label: 'Everyone (all active users)' },
  { value: 'CUSTOMER', label: 'Customers' },
  { value: 'MOVER', label: 'Movers (riders + drivers)' },
  { value: 'VENDOR_OWNER', label: 'Vendor owners' },
];

export default function BroadcastPage() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [role, setRole] = useState('');
  const [category, setCategory] = useState<'service' | 'marketing'>('service');
  const ids = useId();

  // [MC-PR3b] One panel replaces the browser confirm + prompt pair: it shows
  // what will land on the phones, says it cannot be recalled, asks why, and
  // keeps the answer — "sent for a second admin's approval" (a broadcast is a
  // platform action) or the refusal — on screen. The draft is cleared once it
  // has gone, so it is not sent twice.
  const actions = useActionRunner(() => { setTitle(''); setBody(''); });
  const audience = AUDIENCES.find((a) => a.value === role)?.label ?? 'Everyone';
  const canSend = title.trim().length > 0 && body.trim().length > 0;
  const send = () => {
    const message = { title: title.trim(), body: body.trim(), category, ...(role ? { role } : {}) };
    void actions.run({
      title: `Send this to ${audience}?`,
      body: (
        <>
          <p><b>{message.title}</b><br />{message.body}</p>
          <p>{category === 'marketing' ? 'Marketing: only people who said yes receive it. ' : 'Service notice: everyone in the audience receives it. '}Once it is sent it cannot be recalled. A second admin approves it first.</p>
        </>
      ),
      confirmLabel: 'Send broadcast',
      submit: ({ reason }) => broadcastNotification(message, reason),
      success: (res: any) => `Delivered to ${Number(res?.data?.sent ?? 0).toLocaleString()} users.`,
    });
  };

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-1">Broadcast</h1>
      <p className="text-[var(--muted)] text-sm mb-6">
        Push + in-app announcement to a whole audience. It lands on real phones — read it twice.
      </p>
      {actions.banner}

      <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6 space-y-4">
        <div>
          <label htmlFor={`${ids}-aud`} className="block text-xs text-[var(--muted)] mb-1.5">Audience</label>
          <select
            id={`${ids}-aud`}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full bg-[var(--panel-2)] text-white px-3 py-2 rounded-lg text-sm border border-[var(--border)] focus:border-[var(--accent)] focus:outline-none"
          >
            {AUDIENCES.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${ids}-pur`} className="block text-xs text-[var(--muted)] mb-1.5">Purpose</label>
          <select
            id={`${ids}-pur`}
            value={category}
            onChange={(e) => setCategory(e.target.value as 'service' | 'marketing')}
            className="w-full bg-[var(--panel-2)] text-white px-3 py-2 rounded-lg text-sm border border-[var(--border)] focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="service">Service notice — operational, goes to everyone</option>
            <option value="marketing">Marketing — offers/promos, ONLY to people who said yes</option>
          </select>
          <p className="text-[11px] text-[var(--muted)] mt-1">
            Marketing sends pass through the consent ledger: anyone who withdrew, or never opted in, is skipped.
          </p>
        </div>
        <div>
          <label htmlFor={`${ids}-tit`} className="block text-xs text-[var(--muted)] mb-1.5">Title (max 150)</label>
          <input
            id={`${ids}-tit`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={150}
            placeholder="e.g. Service update for Georgetown"
            className="w-full bg-[var(--panel-2)] text-white px-3 py-2 rounded-lg text-sm border border-[var(--border)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor={`${ids}-msg`} className="block text-xs text-[var(--muted)] mb-1.5">Message (max 1000)</label>
          <textarea
            id={`${ids}-msg`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={1000}
            rows={5}
            placeholder="What do they need to know?"
            className="w-full bg-[var(--panel-2)] text-white px-3 py-2 rounded-lg text-sm border border-[var(--border)] focus:border-[var(--accent)] focus:outline-none resize-none"
          />
        </div>

        {/* What it will look like on the phone */}
        {(title.trim() || body.trim()) && (
          <div className="rounded-lg bg-black/30 border border-[var(--border)] p-4">
            <p className="text-[10px] text-[var(--muted)] tracking-widest mb-2">PREVIEW</p>
            <div className="rounded-xl bg-[var(--panel-2)] p-3">
              <p className="text-sm font-semibold">{title.trim() || 'Title'}</p>
              <p className="text-xs text-[var(--muted)] mt-0.5 whitespace-pre-wrap">{body.trim() || 'Message'}</p>
            </div>
          </div>
        )}

        <button
          onClick={send}
          disabled={!canSend}
          className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[var(--accent)] hover:bg-[var(--accent)]/80 disabled:opacity-50 transition-colors"
        >
          {`Send to ${audience}…`}
        </button>
      </div>
    </div>
  );
}
