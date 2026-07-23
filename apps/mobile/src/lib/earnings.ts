// Derivations over the mover /earnings/today payload.
//
// The two mover endpoints name today's completed-work count differently by
// server truth: GET /rider/earnings/today returns `deliveries`, GET
// /driver/earnings/today returns `ridesCompleted`. The home screen was reading
// `todayDeliveries` — a key neither endpoint has ever sent — so a rider's
// "Jobs today" stat rendered 0 forever (SWIFT-038). Read the real field names,
// and keep this in one tested place so the contract can't silently drift again.
export function moverJobsToday(earningsData: unknown): number {
  const d = earningsData as { deliveries?: unknown; ridesCompleted?: unknown } | null | undefined;
  const raw = d?.deliveries ?? d?.ridesCompleted;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
