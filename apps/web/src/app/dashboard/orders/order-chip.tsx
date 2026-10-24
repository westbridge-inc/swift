'use client';

import { MMG_DISPUTE_NOTICE } from '@/lib/mmg-dispute';
import { vendorStatusLabel } from '@/lib/vendor-order-view';

// Shared by the order board (page.tsx) and the order window (order-detail.tsx).

export function timeAgo(iso?: string) {
  if (!iso) return '';
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

export function statusChip(s: string, paused = false) {
  const done = ['DELIVERED', 'COMPLETED'].includes(s);
  const dead = s === 'CANCELLED';
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ${
        paused ? 'bg-amber-100 text-amber-800' : done ? 'bg-green-100 text-green-700' : dead ? 'bg-black/5 text-[var(--swift-muted)]' : 'bg-[var(--swift-red)]/10 text-[var(--swift-red)]'
      }`}
    >
      {/* [U45] The phone's words (vendor/shared.tsx OrderStatusPill), never a status code. */}
      {paused ? MMG_DISPUTE_NOTICE.title : vendorStatusLabel(s)}
    </span>
  );
}
