'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { broadcastNotification } from '@/lib/api';

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
  const [lastSent, setLastSent] = useState<number | null>(null);

  const send = useMutation({
    mutationFn: () => broadcastNotification({ title: title.trim(), body: body.trim(), category, ...(role ? { role } : {}) }),
    onSuccess: (res: any) => {
      setLastSent(res?.data?.sent ?? 0);
      setTitle('');
      setBody('');
    },
  });

  const audience = AUDIENCES.find((a) => a.value === role)?.label ?? 'Everyone';
  const canSend = title.trim().length > 0 && body.trim().length > 0 && !send.isPending;

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-1">Broadcast</h1>
      <p className="text-[#8E8E93] text-sm mb-6">
        Push + in-app announcement to a whole audience. It lands on real phones — read it twice.
      </p>

      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-6 space-y-4">
        <div>
          <label className="block text-xs text-[#8E8E93] mb-1.5">Audience</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full bg-[#2C2C2E] text-white px-3 py-2 rounded-lg text-sm border border-[#38383A] focus:border-[#E8192C] focus:outline-none"
          >
            {AUDIENCES.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-[#8E8E93] mb-1.5">Purpose</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as 'service' | 'marketing')}
            className="w-full bg-[#2C2C2E] text-white px-3 py-2 rounded-lg text-sm border border-[#38383A] focus:border-[#E8192C] focus:outline-none"
          >
            <option value="service">Service notice — operational, goes to everyone</option>
            <option value="marketing">Marketing — offers/promos, ONLY to people who said yes</option>
          </select>
          <p className="text-[11px] text-[#8E8E93] mt-1">
            Marketing sends pass through the consent ledger: anyone who withdrew, or never opted in, is skipped.
          </p>
        </div>
        <div>
          <label className="block text-xs text-[#8E8E93] mb-1.5">Title (max 150)</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={150}
            placeholder="e.g. Service update for Georgetown"
            className="w-full bg-[#2C2C2E] text-white px-3 py-2 rounded-lg text-sm border border-[#38383A] focus:border-[#E8192C] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-[#8E8E93] mb-1.5">Message (max 1000)</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={1000}
            rows={5}
            placeholder="What do they need to know?"
            className="w-full bg-[#2C2C2E] text-white px-3 py-2 rounded-lg text-sm border border-[#38383A] focus:border-[#E8192C] focus:outline-none resize-none"
          />
        </div>

        {/* What it will look like on the phone */}
        {(title.trim() || body.trim()) && (
          <div className="rounded-lg bg-black/30 border border-[#38383A] p-4">
            <p className="text-[10px] text-[#8E8E93] tracking-widest mb-2">PREVIEW</p>
            <div className="rounded-xl bg-[#2C2C2E] p-3">
              <p className="text-sm font-semibold">{title.trim() || 'Title'}</p>
              <p className="text-xs text-[#8E8E93] mt-0.5 whitespace-pre-wrap">{body.trim() || 'Message'}</p>
            </div>
          </div>
        )}

        <button
          onClick={() => {
            if (window.confirm(`Send this to ${audience}? This cannot be recalled.`)) send.mutate();
          }}
          disabled={!canSend}
          className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[#E8192C] hover:bg-[#E8192C]/80 disabled:opacity-50 transition-colors"
        >
          {send.isPending ? 'Sending…' : `Send to ${audience}`}
        </button>

        {lastSent != null && (
          <p className="text-sm text-emerald-400 text-center">Delivered to {lastSent.toLocaleString()} users.</p>
        )}
        {send.isError && <p className="text-sm text-red-400 text-center">Send failed — try again.</p>}
      </div>
    </div>
  );
}
