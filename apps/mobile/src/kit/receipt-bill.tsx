import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { color, space } from '@swift/ui';
import { T } from './text';

export interface ReceiptLine {
  label: string;
  /** Pass <Money> (or a formatted string) — figures must stay tabular. */
  value: ReactNode;
  /** 'discount' renders the value in success ink (e.g. "− GY$500"). */
  tone?: 'default' | 'discount' | 'muted';
}

function leaderColor(tone: ReceiptLine['tone']) {
  return tone === 'discount' ? 'success' : tone === 'muted' ? 'faint' : 'ink';
}

/**
 * ReceiptBill — the price breakdown drawn as a till receipt: dotted leaders
 * carry the eye from label to figure, and the total sits under a DOUBLE rule
 * (the accountant's "final answer" mark). Used on checkout, order detail, and
 * earnings statements so money math reads as a document, not a list.
 *
 * Every line is a fact from the server — the bill never invents, rounds, or
 * re-adds; `total` is the server's total, not a client-side sum.
 */
export function ReceiptBill({
  lines,
  totalLabel = 'Total',
  total,
  footnote,
  style,
}: {
  lines: ReadonlyArray<ReceiptLine>;
  totalLabel?: string;
  total: ReactNode;
  /** One quiet line under the rule ("Paid in cash · May 4"). */
  footnote?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={style}>
      <View style={{ gap: space.sm }}>
        {lines.map((line, i) => (
          <View
            key={`${line.label}-${i}`}
            style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.xs }}
          >
            <T
              variant="label"
              tone={line.tone === 'muted' ? 'muted' : 'ink'}
              style={{ flexShrink: 1 }}
              numberOfLines={1}
            >
              {line.label}
            </T>
            {/* The dotted leader — RN draws dotted borders reliably, so the
                leader is a hairline box, not a string of periods a screen
                reader would try to speak. */}
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{
                flex: 1,
                borderBottomWidth: 1,
                borderStyle: 'dotted',
                borderBottomColor: color.border.strong,
                marginBottom: 3,
                minWidth: space.lg,
              }}
            />
            {typeof line.value === 'string' || typeof line.value === 'number' ? (
              <T variant="numM" tone={leaderColor(line.tone)}>
                {line.value}
              </T>
            ) : (
              line.value
            )}
          </View>
        ))}
      </View>

      {/* The double till-rule: two hairlines, 2px apart. */}
      <View style={{ marginTop: space.md, gap: 2 }}>
        <View style={{ height: 1, backgroundColor: color.border.strong }} />
        <View style={{ height: 1, backgroundColor: color.border.strong }} />
      </View>

      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          marginTop: space.md,
          gap: space.md,
        }}
      >
        <T variant="bodyStrong">{totalLabel}</T>
        {typeof total === 'string' || typeof total === 'number' ? (
          <T variant="numL">{total}</T>
        ) : (
          total
        )}
      </View>

      {footnote ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          {footnote}
        </T>
      ) : null}
    </View>
  );
}
