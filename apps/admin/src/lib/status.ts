/**
 * Shared status → pill class map for the admin tables, so every entity
 * (orders, vendors, riders, drivers, verification…) colours its status the
 * same way: green = good/terminal-success, red = bad/blocked, brand maroon =
 * pending/needs-attention, grey = neutral. The maroon pill is the admin's
 * brand fill (globals.css --accent-deep, the @swift/ui brand maroon; "fills,
 * with white text") with a FIXED white text, never --text: light Mission
 * Control surfaces re-point --text to the dark ink, which on maroon is about
 * 2:1. White on the maroon is about 8:1 on every surface. The old bright red
 * is not Swift's colour.
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
    return 'bg-[var(--accent-deep)] text-white';
  }
  return 'bg-white/10 text-[#8E8E93]';
}
