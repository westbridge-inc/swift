import { View } from 'react-native';
import { color, space } from '@swift/ui';

/**
 * Multi-step progress indicator — a row of bars, filled brand up to and
 * including the current step. For the country → phone → OTP → role
 * onboarding. `step` is 0-based; `total` is the number of steps.
 *
 * [DRIFT-09] Kit port of components/ui/step-progress, same API.
 */
export function StepProgress({ step, total }: { step: number; total: number }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: total, now: step + 1 }}
      style={{ flexDirection: 'row', gap: space.xs + 2 }}
    >
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
