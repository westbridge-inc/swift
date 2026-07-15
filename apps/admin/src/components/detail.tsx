'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

/** Shared vocabulary for the drill-down pages (order/user/vendor/mover). */

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-6">
      <h2 className="text-sm font-semibold text-[#8E8E93] tracking-widest mb-4">{title.toUpperCase()}</h2>
      {children}
    </div>
  );
}

export function Row({ label, value, href }: { label: string; value?: React.ReactNode; href?: string }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-[#8E8E93] shrink-0">{label}</span>
      {href ? (
        <Link href={href} className="text-right hover:text-[#E8192C] transition-colors">
          {value}
        </Link>
      ) : (
        <span className="text-right">{value}</span>
      )}
    </div>
  );
}

const PILL: Record<string, string> = {
  ACTIVE: 'bg-emerald-500/15 text-emerald-400',
  DELIVERED: 'bg-emerald-500/15 text-emerald-400',
  COMPLETED: 'bg-emerald-500/15 text-emerald-400',
  PAID: 'bg-emerald-500/15 text-emerald-400',
  PENDING: 'bg-amber-500/15 text-amber-400',
  PENDING_APPROVAL: 'bg-amber-500/15 text-amber-400',
  PAST_DUE: 'bg-amber-500/15 text-amber-400',
  TRIAL: 'bg-sky-500/15 text-sky-400',
  SUSPENDED: 'bg-red-500/15 text-red-400',
  BANNED: 'bg-red-500/15 text-red-400',
  CANCELLED: 'bg-red-500/15 text-red-400',
  FAILED: 'bg-red-500/15 text-red-400',
  EXPIRED: 'bg-red-500/15 text-red-400',
};

export function StatusPill({ value }: { value?: string | null }) {
  if (!value) return null;
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs ${PILL[value] ?? 'bg-white/10 text-[#8E8E93]'}`}>
      {value.replaceAll('_', ' ')}
    </span>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2 text-sm text-[#8E8E93] hover:text-white mb-4">
      <ArrowLeft size={16} /> {label}
    </Link>
  );
}

export const gyd = (n: unknown) => `$${Number(n || 0).toLocaleString()}`;

/** Confirm-then-mutate button used by the action bars. */
export function ActionButton({
  label,
  confirm,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  confirm: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={() => {
        if (window.confirm(confirm)) onClick();
      }}
      disabled={disabled}
      className={`px-4 py-2 rounded-lg text-sm disabled:opacity-50 transition-colors ${
        danger ? 'bg-[#E8192C] hover:bg-[#E8192C]/80' : 'border border-[#38383A] hover:bg-white/10'
      }`}
    >
      {label}
    </button>
  );
}
