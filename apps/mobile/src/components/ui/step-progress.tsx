import { View } from 'react-native';
import { color } from '@swift/ui';

/**
 * Multi-step progress indicator — a row of bars, filled brand-red up to and
 * including the current step. For the country → phone → OTP → role onboarding.
 * `step` is 0-based; `total` is the number of steps.
 */
export function StepProgress({ step, total }: { step: number; total: number }) {
  return (
    <View className="flex-row" style={{ gap: 6 }}>
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          style={{
            height: 4,
            flex: 1,
            borderRadius: 2,
            backgroundColor: i <= step ? color.brand[500] : color.border.subtle,
          }}
        />
      ))}
    </View>
  );
}
