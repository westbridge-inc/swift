'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useActionDialog } from '@/components/mc/ReasonDialog';

/** Shared vocabulary for the drill-down pages (order/user/vendor/mover). */

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6">
      <h2 className="text-sm font-semibold text-[var(--muted)] tracking-widest mb-4">{title.toUpperCase()}</h2>
      {children}
    </div>
  );
}

export function Row({ label, value, href }: { label: string; value?: React.ReactNode; href?: string }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-[var(--muted)] shrink-0">{label}</span>
      {href ? (
        <Link href={href} className="text-right hover:text-[var(--accent)] transition-colors">
          {value}
        </Link>
      ) : (
        <span className="text-right">{value}</span>
      )}
    </div>
  );
}

// [ADMIN-UI] A status word in the Mission Control pill, coloured by what it means.
const PILL_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info'> = {
  ACTIVE: 'good', DELIVERED: 'good', COMPLETED: 'good', PAID: 'good',
  PENDING: 'warn', PENDING_APPROVAL: 'warn', PAST_DUE: 'warn',
  TRIAL: 'info',
  SUSPENDED: 'bad', BANNED: 'bad', CANCELLED: 'bad', FAILED: 'bad', EXPIRED: 'bad',
};

export function StatusPill({ value }: { value?: string | null }) {
  if (!value) return null;
  const tone = PILL_TONE[value];
  return (
    <span className={`mc-badge${tone ? ` mc-tone-${tone}` : ''}`}>
      {value.replaceAll('_', ' ')}
    </span>
  );
}


export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2 text-sm text-[var(--muted)] hover:text-white mb-4">
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
  // Confirmed in the in-page panel (owner ruling 6 Oct: no browser prompts).
  const dialog = useActionDialog();
  return (
    <button
      type="button"
      onClick={async () => {
        if (await dialog.askWith({ title: confirm, reason: false, confirmLabel: label })) onClick();
      }}
      disabled={disabled}
      className={`px-4 py-2 rounded-lg text-sm disabled:opacity-50 transition-colors ${
        danger ? 'bg-[var(--accent)] hover:bg-[var(--accent)]/80' : 'border border-[var(--border)] hover:bg-white/10'
      }`}
    >
      {label}
    </button>
  );
}
