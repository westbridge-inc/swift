import { View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { color, radius, space, withAlpha } from '@swift/ui';
import { T, type TP } from './text';

// ---------------------------------------------------------------------------
// [Wave 3 · Design Standard §02] The three smallest words in the vocabulary —
// the highest-frequency elements in the decks, absent from the kit until now.
// ---------------------------------------------------------------------------

/**
 * Eyebrow — the uppercase micro label above a section or number. The `micro`
 * step already carries the treatment (11/14, +0.6 tracking, uppercase); this
 * wrapper carries the LAW: **an eyebrow states something factual** — "From
 * your orders", "Open now", "THIS WEEK". An eyebrow used as decoration is a
 * bug, not a style choice.
 */
export function Eyebrow({ children, tone = 'faint', style, ...rest }: TP) {
  return (
    <T variant="micro" tone={tone} style={style} {...rest}>
      {children}
    </T>
  );
}

type StateTone = 'success' | 'warning' | 'error' | 'neutral' | 'brand';

const STATE_SURFACE: Record<StateTone, { bg: string; fg: string }> = {
  success: { bg: withAlpha(color.success, 0.12), fg: color.success },
  warning: { bg: withAlpha(color.warning, 0.14), fg: color.warning },
  error: { bg: withAlpha(color.error, 0.12), fg: color.error },
  neutral: { bg: color.surface.subtle, fg: color.text.secondary },
  brand: { bg: color.brand[50], fg: color.brand[600] },
};

/**
 * StatePill — status as a WORD: "Verified", "Pending review", "SOLD OUT",
 * "1 STEP LEFT". The label is REQUIRED by type: there is deliberately no
 * colour-only variant, because colour is the second signal, never the first
 * (Design Standard §05 ③ — no status anywhere is carried by colour alone).
 */
export function StatePill({
  label,
  tone = 'neutral',
  style,
}: {
  label: string;
  tone?: StateTone;
  style?: StyleProp<ViewStyle>;
}) {
  const s = STATE_SURFACE[tone];
  return (
    <View
      style={[
        {
          alignSelf: 'flex-start',
          borderRadius: radius.full,
          backgroundColor: s.bg,
          paddingHorizontal: space.sm + 2,
          paddingVertical: 3,
        },
        style,
      ]}
    >
      <T variant="micro" weight="semibold" style={{ color: s.fg }}>
        {label}
      </T>
    </View>
  );
}

/**
 * StatusDot — the calm band's grammar: an 8px dot, one coloured WORD, one
 * plain sentence. "● Active — your store is open and taking orders." The dot
 * and the word share a tone; the sentence stays ink so the state never shouts
 * past its own explanation.
 */
export function StatusDot({
  tone = 'success',
  word,
  sentence,
  style,
  wordStyle,
}: {
  tone?: StateTone;
  word: string;
  sentence?: string;
  style?: StyleProp<ViewStyle>;
  wordStyle?: StyleProp<TextStyle>;
}) {
  const fg = STATE_SURFACE[tone].fg;
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.sm }, style]}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: fg }} />
      <T variant="label" weight="semibold" style={[{ color: fg }, wordStyle]}>
        {word}
      </T>
      {sentence ? (
        <T variant="label" tone="muted" numberOfLines={2} style={{ flexShrink: 1 }}>
          {sentence}
        </T>
      ) : null}
    </View>
  );
}
