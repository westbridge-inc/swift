import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { insightsHeldView } from './insightsHeldView';

// [SPEED 30 Oct · owner] Insights opened again after an overview poll keeps the last figures that
// agreed, says it is checking, and never mixes a new overview with an old revenue series.
const overview1 = { today: { revenue: 1000 } };
const overview2 = { today: { revenue: 1500 } };
const series1 = { daily: [{ date: '2026-10-29', revenue: 1000 }] };

describe('Insights: the last agreeing figures while the series catches up', () => {
  it('first read of a range: nothing held, so the screen loads normally', () => {
    expect(insightsHeldView(null, { days: 14, analytics: overview1, revenue: undefined, behind: false, revenueFailed: false })).toEqual({ held: null, checking: null });
    expect(insightsHeldView(null, { days: 14, analytics: overview2, revenue: series1, behind: true, revenueFailed: false })).toEqual({ held: null, checking: null });
  });

  it('agreeing figures are remembered; a newer overview over the old series shows the remembered pair, checking', () => {
    const first = insightsHeldView(null, { days: 14, analytics: overview1, revenue: series1, behind: false, revenueFailed: false });
    expect(first.checking).toBeNull();
    const back = insightsHeldView(first.held, { days: 14, analytics: overview2, revenue: series1, behind: true, revenueFailed: false });
    expect(back.checking).toEqual({ days: 14, analytics: overview1, revenue: series1 });
  });

  it('another range, or a failed series read, never shows the remembered pair', () => {
    const { held } = insightsHeldView(null, { days: 14, analytics: overview1, revenue: series1, behind: false, revenueFailed: false });
    expect(insightsHeldView(held, { days: 60, analytics: overview2, revenue: series1, behind: true, revenueFailed: false }).checking).toBeNull();
    expect(insightsHeldView(held, { days: 14, analytics: overview2, revenue: series1, behind: true, revenueFailed: true }).checking).toBeNull();
  });

  it('the screen draws the held pair instead of a spinner, with the checking words', () => {
    const screen = readFileSync(new URL('../modules/vendor/screens/VendorInsightsScreen.tsx', import.meta.url), 'utf8');
    expect(screen).toContain("(revenueBehindAnalytics && !revenueQ.isError && !checking)");
    expect(screen).toContain('const a: any = (checking ? checking.analytics : q.data) ?? {};');
    expect(screen).toContain('reconciledRevenueDays(checking ? checking.revenue : revenueQ.data, a, requestedDays)');
    expect(screen).toMatch(/checking \? \([\s\S]{0,120}Checking for the latest…/);
  });
});
