/**
 * Shared status → pill class map for the admin tables, so every entity
 * (orders, vendors, riders, drivers, verification…) colours its status the
 * same way: green = good/terminal-success, red = bad/blocked, brand-red =
 * pending/needs-attention, grey = neutral. Brand red is #E8192C.
 */
export function statusClass(s: string) {
  const x = (s || '').toUpperCase();
  if (['DELIVERED', 'COMPLETED', 'APPROVED', 'ACTIVE', 'VERIFIED', 'ONLINE', 'PAID'].includes(x)) {
    return 'bg-green-500/15 text-green-400';
  }
  if (['CANCELLED', 'REFUNDED', 'FAILED', 'REJECTED', 'SUSPENDED', 'OFFLINE', 'OVERDUE'].includes(x)) {
    return 'bg-red-500/15 text-red-400';
  }
  if (['PENDING', 'PLACED', 'REVIEW', 'IN_REVIEW', 'UNVERIFIED'].includes(x)) {
    return 'bg-[#E8192C]/15 text-[#E8192C]';
  }
  return 'bg-white/10 text-[#8E8E93]';
}
