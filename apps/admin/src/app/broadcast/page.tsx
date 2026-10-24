'use client';

import { useState } from 'react';
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
  // [U05] A broadcast is a platform action: the first answer is 202 "sent for a
  // second admin's approval". It used to read as "Send failed — try again", and
  // trying again filed a second approval (both approved = everyone gets it
  // twice). The panel shows the real answer; the draft is cleared once it went
  // through or was queued, so nothing is left to press twice.
  const actions = useActionRunner(() => { setTitle(''); setBody(''); });

  const audience = AUDIENCES.find((a) => a.value === role)?.label ?? 'Everyone';
  const canSend = title.trim().length > 0 && body.trim().length > 0;
  const send = () => {
    const draft = { title: title.trim(), body: body.trim(), category, ...(role ? { role } : {}) };
    void actions.run({
      title: `Send this to ${audience}?`,
      body: (
        <>
          <p><strong>{draft.title}</strong></p>
          <p className="whitespace-pre-wrap">{draft.body}</p>
          <p>It lands on real phones and cannot be recalled. A second admin must approve it before it is sent.</p>
        </>
      ),
      confirmLabel: `Send to ${audience}`,
      submit: ({ reason }) => broadcastNotification(draft, reason),
      success: (res: any) => `Delivered to ${Number(res?.data?.sent ?? 0).toLocaleString()} users.`,
    });
  };

  return (
    <div className="mc-page">
      <div className="max-w-2xl">
        <p className="mc-muted mb-4">
          A notification and an in-app announcement to a whole audience. It lands on real phones — read it twice.
        </p>

        {actions.banner}
        <div className="mc-card space-y-4">
          <div className="mc-field">
            <label htmlFor="broadcast-audience">Audience</label>
            <select id="broadcast-audience" value={role} onChange={(e) => setRole(e.target.value)} className="mc-input">
              {AUDIENCES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="mc-field">
            <label htmlFor="broadcast-purpose">Purpose</label>
            <select
              id="broadcast-purpose"
              value={category}
              onChange={(e) => setCategory(e.target.value as 'service' | 'marketing')}
              className="mc-input"
            >
              <option value="service">Service notice — operational, goes to everyone</option>
              <option value="marketing">Marketing — offers/promos, ONLY to people who said yes</option>
            </select>
            <p className="mc-field-hint">
              A marketing message only goes to people who said yes to offers: anyone who withdrew, or never agreed, is skipped.
            </p>
          </div>
          <div className="mc-field">
            <label htmlFor="broadcast-title">Title (max 150)</label>
            <input
              id="broadcast-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={150}
              placeholder="e.g. Service update for Georgetown"
              className="mc-input"
            />
          </div>
          <div className="mc-field">
            <label htmlFor="broadcast-message">Message (max 1000)</label>
            <textarea
              id="broadcast-message"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={1000}
              rows={5}
              placeholder="What do they need to know?"
              className="mc-input"
            />
          </div>

          {/* What it will look like on the phone */}
          {(title.trim() || body.trim()) && (
            <div className="rounded-[var(--mc-radius)] bg-[var(--mc-surface)] p-4">
              <p className="mc-label mb-2">Preview on the phone</p>
              <div className="rounded-[var(--mc-radius)] border border-[var(--mc-line)] bg-[var(--mc-card)] p-3 shadow-sm">
                <p className="font-semibold">{title.trim() || 'Title'}</p>
                <p className="mc-muted mt-0.5 whitespace-pre-wrap text-xs">{body.trim() || 'Message'}</p>
              </div>
            </div>
          )}

          <button type="button" onClick={send} disabled={!canSend} className="mc-btn mc-btn-primary w-full">
            {`Send to ${audience}`}
          </button>
        </div>
      </div>
    </div>
  );
}
