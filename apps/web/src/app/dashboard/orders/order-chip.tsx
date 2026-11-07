'use client';

import { Bike, User } from 'lucide-react';
import { MMG_DISPUTE_NOTICE } from '@/lib/mmg-dispute';
import { vendorStatusLabel } from '@/lib/vendor-order-view';
import type { VendorOrder } from '@/lib/vendor-api';
// The app's own words and rule (plain file, imported as is).
import { BOARD_NAME_WORDS, boardNames } from '../../../../../mobile/src/modules/vendor/storeHandover';

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

/**
 * [STORE-LINK+NAMES · owner 30 Oct 21:47Z] Who the order is for, and who carries it, readable on the
 * board card itself (the phone's BoardNames): the customer's first name and, once assigned, the
 * rider's first name. Never a last name, a phone number or an address. Nothing when no name came.
 */
export function BoardNames({ order }: { order: Pick<VendorOrder, 'customer' | 'rider'> }) {
  const { customer, rider } = boardNames(order);
  if (!customer && !rider) return null;
  return (
    <p data-testid="board-names" className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[15px] font-semibold text-[var(--swift-ink)]">
      {customer && <span className="inline-flex min-w-0 items-center gap-1.5 break-words"><User size={15} aria-hidden="true" className="shrink-0 text-[var(--swift-muted)]" />{BOARD_NAME_WORDS.customer(customer)}</span>}
      {rider && <span className="inline-flex min-w-0 items-center gap-1.5 break-words"><Bike size={15} aria-hidden="true" className="shrink-0 text-[var(--swift-muted)]" />{BOARD_NAME_WORDS.rider(rider)}</span>}
    </p>
  );
}
