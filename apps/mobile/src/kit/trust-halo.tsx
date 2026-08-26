import type { ReactNode } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { color } from '@swift/ui';

/** [design-100x Flow-8 signature] THE TRUST HALO — a segmented ring around
 *  the avatar where every lit segment is a REAL account fact (phone verified ·
 *  selfie on file · first order placed). Never decorative: unlit segments are
 *  the honest to-do list, and the host's caption names the next one.
 *  Promoted verbatim from ProfileScreen [Wave 3 part 2 deferral]. The deck
 *  caps it at 84dp — it's a profile mark, not a gauge; keep `size` ≤ 84. */
export function TrustHalo({ size, stroke, facts, children }: {
  size: number; stroke: number; facts: boolean[]; children: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const seg = c / facts.length;
  const gap = 8;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        {facts.map((on, i) => (
          <Circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={on ? color.success : color.brand[100]}
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${seg - gap} ${c - seg + gap}`}
            strokeDashoffset={-i * seg}
          />
        ))}
      </Svg>
      {children}
    </View>
  );
}
