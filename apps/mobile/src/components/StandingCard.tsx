/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { Card, T, TonePill } from '../kit';
import { Stars } from '../kit/controls';

// ---------------------------------------------------------------------------
// Movement R — R9: the Standing module, 5-second-glance discipline.
// Big number · band chip · 13-week sparkline · "Customers mention" tag line ·
// coaching card at ATTENTION/AT_RISK. Everything it renders is DAILY-FOLDED
// server-side (RAT-G) — this component never sees a same-day rating.
// ---------------------------------------------------------------------------

export interface StandingData {
  standing: string;
  displayRating: number | null;
  ratingBucket: string;
  ratingCount: number;
  topRated: boolean;
  folded: { count: number; average: number | null };
  trend: Array<{ weekStart: string; average: number | null; count: number }>;
  topPositive: Array<{ tag: string; label: string; count: number }>;
  topNegative: Array<{ tag: string; label: string; count: number }>;
  coaching: Array<{ tag: string; label: string; line: string }>;
}

const BAND: Record<string, { label: string; tone: 'brand' | 'success' | 'error' | 'neutral' }> = {
  EXCELLENT: { label: 'Excellent', tone: 'success' },
  GOOD: { label: 'Good', tone: 'neutral' },
  ATTENTION: { label: 'Needs attention', tone: 'brand' },
  AT_RISK: { label: 'At risk', tone: 'error' },
  NEW: { label: 'New', tone: 'neutral' },
};

function tagLine(tags: StandingData['topPositive']): string {
  return tags.slice(0, 3).map((t) => `${t.label} ×${t.count}`).join(' · ');
}

export function StandingCard({ data, title = 'Your standing' }: { data: StandingData; title?: string }) {
  const band = BAND[data.standing] ?? BAND['NEW']!;
  const maxBar = 28;
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T variant="label" weight="semibold">
          {title}
        </T>
        <TonePill label={data.topRated ? 'Top rated' : band.label} tone={data.topRated ? 'success' : band.tone} />
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.xl, marginTop: space.md }}>
        <View>
          <T variant="display">{data.displayRating != null ? data.displayRating.toFixed(1) : 'New'}</T>
          {data.displayRating != null ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <Stars value={data.displayRating} size={12} />
              <T variant="caption" tone="muted">
                {data.ratingBucket}
              </T>
            </View>
          ) : (
            <T variant="caption" tone="muted">
              Ratings appear after your first few jobs
            </T>
          )}
        </View>

        {/* 13-week sparkline — the quiet trend, no axes, no noise. */}
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: maxBar }}>
          {data.trend.map((w) => (
            <View
              key={w.weekStart}
              style={{
                flex: 1,
                height: w.average != null ? Math.max(4, (w.average / 5) * maxBar) : 3,
                borderRadius: 2,
                backgroundColor: w.average != null ? color.warning : color.border.subtle,
              }}
            />
          ))}
        </View>
      </View>

      {data.topPositive.length > 0 ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.md }}>
          Customers mention: {tagLine(data.topPositive)}
        </T>
      ) : null}
      {data.topNegative.length > 0 ? (
        <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
          Watch for: {tagLine(data.topNegative)}
        </T>
      ) : null}

      {data.coaching.length > 0 ? (
        <View
          style={{
            marginTop: space.md,
            padding: space.md,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: color.border.subtle,
            gap: space.sm,
          }}
        >
          <T variant="caption" weight="semibold">
            How to move it
          </T>
          {data.coaching.map((c) => (
            <T key={c.tag} variant="caption" tone="muted">
              {c.label}: {c.line}
            </T>
          ))}
        </View>
      ) : null}
    </Card>
  );
}
