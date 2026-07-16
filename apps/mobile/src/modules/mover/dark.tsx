import React from 'react';
import { View, type ViewStyle } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { T } from '../../kit';

/**
 * The earner app's dark surface language (dashboard plan Phase B): near-black
 * cards on a dark map, ONE accent — Swift red. The customer app stays light;
 * the earner works at night and lives on the map, so the map leads.
 */
export const dk = {
  bg: '#0C0C0E',
  card: '#17171B',
  cardSoft: '#212127',
  line: 'rgba(255,255,255,0.08)',
  text: '#FFFFFF',
  muted: 'rgba(255,255,255,0.55)',
  faint: 'rgba(255,255,255,0.35)',
  accent: color.brand[500],
  success: '#2FBF71',
  warning: '#F5A623',
} as const;

export function DCard({ style, children }: { style?: ViewStyle; children: React.ReactNode }) {
  return (
    <View style={[{ backgroundColor: dk.card, borderRadius: 16, borderWidth: 1, borderColor: dk.line, padding: 16 }, style]}>
      {children}
    </View>
  );
}

/** Reference-style stat chip: value on top, label under, optional icon. */
export function DStat({
  icon,
  value,
  label,
  flex = 1,
}: {
  icon?: keyof typeof MaterialCommunityIcons.glyphMap;
  value: string;
  label: string;
  flex?: number;
}) {
  return (
    <View style={{ flex, backgroundColor: dk.cardSoft, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center' }}>
      {icon ? <MaterialCommunityIcons name={icon} size={14} color={dk.muted} style={{ marginBottom: 2 }} /> : null}
      <T variant="body" weight="bold" numberOfLines={1} style={{ color: dk.text }}>
        {value}
      </T>
      <T variant="caption" numberOfLines={1} style={{ color: dk.muted, marginTop: 1 }}>
        {label}
      </T>
    </View>
  );
}

/** 7-day earnings bars (the reference's Finance chart, distilled). */
export function DWeekBars({ days }: { days: Array<{ label: string; total: number; isToday: boolean }> }) {
  const max = Math.max(1, ...days.map((d) => d.total));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, height: 92 }}>
      {days.map((d, i) => {
        const h = Math.max(6, Math.round((d.total / max) * 64));
        return (
          <View key={i} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
            {d.total > 0 ? (
              <T variant="caption" numberOfLines={1} style={{ color: d.isToday ? dk.text : dk.faint, fontSize: 9, marginBottom: 3 }}>
                {d.total >= 1000 ? `${Math.round(d.total / 1000)}k` : String(Math.round(d.total))}
              </T>
            ) : null}
            <View
              style={{
                alignSelf: 'stretch',
                height: h,
                borderRadius: 6,
                backgroundColor: d.isToday ? dk.accent : 'rgba(232,25,44,0.35)',
              }}
            />
            <T variant="caption" style={{ color: d.isToday ? dk.text : dk.faint, fontSize: 10, marginTop: 4 }}>
              {d.label}
            </T>
          </View>
        );
      })}
    </View>
  );
}
