// ---------------------------------------------------------------------------
// [SPEED 30 Oct · owner] Insights opened again never blanks to a spinner.
//
// The overview keeps polling while the Insights tab is hidden; its 7/30-day
// revenue series is re-read only once the tab is drawn again. Until then the
// two disagree (revenueBehindAnalytics), and the screen used to swap its whole
// page for a spinner. Now it keeps showing the last PAIR that agreed — never a
// new overview over an old series — and says it is checking for the latest.
// The very first read of a range still loads normally (there is no pair yet).
// ---------------------------------------------------------------------------

export interface InsightsPair { days: number; analytics: unknown; revenue: unknown }

export function insightsHeldView(
  held: InsightsPair | null,
  now: { days: number; analytics: unknown; revenue: unknown; behind: boolean; revenueFailed: boolean },
): { held: InsightsPair | null; checking: InsightsPair | null } {
  if (!now.behind && now.analytics !== undefined && now.revenue !== undefined) {
    return { held: { days: now.days, analytics: now.analytics, revenue: now.revenue }, checking: null };
  }
  if (now.behind && !now.revenueFailed && held && held.days === now.days) return { held, checking: held };
  return { held, checking: null };
}
