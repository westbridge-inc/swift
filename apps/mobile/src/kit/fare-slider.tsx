import { useRef, useState } from 'react';
import { View, PanResponder } from 'react-native';
import { shadow, color } from '@swift/ui';
import { fareStep } from './fare-step';

/**
 * A capped price slider — a bar with a draggable circle. The driver slides between
 * `min` (a floor) and `max` (the market rate Swift computed); the max is the cap, so
 * they can charge less to be competitive but never overcharge. PanResponder-based, so
 * no native slider dependency / rebuild. Reads latest props via a ref to avoid the
 * classic stale-closure on the gesture handlers.
 */
export function FareSlider({
  min,
  max,
  value,
  onChange,
  currencyLabel = 'dollars',
  secondsLeft,
}: {
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  /** [F-027-08] Spoken currency name. Hardcoding "Guyanese dollars" in a
   *  reusable control contradicts the multi-country contract — every market
   *  would have heard the wrong currency. */
  currencyLabel?: string;
  /** [F-027-08] Seconds of server authority left on this offer, if any. The
   *  deadline was a 4dp visual bar and nothing else, so a screen-reader user
   *  was never told the offer was expiring underneath them. */
  secondsLeft?: number;
}) {
  const [w, setW] = useState(0);
  const ref = useRef({ w, min, max, onChange });
  ref.current = { w, min, max, onChange };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => move(e.nativeEvent.locationX),
      onPanResponderMove: (e) => move(e.nativeEvent.locationX),
    }),
  ).current;

  function move(locationX: number) {
    const s = ref.current;
    if (s.w <= 0 || s.max <= s.min) return;
    const pct = Math.max(0, Math.min(1, locationX / s.w));
    s.onChange(Math.round(s.min + pct * (s.max - s.min)));
  }

  const pct = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 1;

  // [F-242] A PanResponder is invisible to assistive tech: drag is the only
  // way to move it, and a screen reader announced nothing at all — so a blind
  // driver could not set a fare. `adjustable` + accessibilityValue makes the
  // current price readable, and the increment/decrement actions give a
  // gesture-free way to change it.
  //
  // [F-027-08] The step was 1% of the band, which is only "a sane number of
  // swipes" if you never counted them. The offer card opens at the market
  // maximum and allows lowering to 60%, so the floor was ~100 decrement
  // actions away — inside an offer whose server authority expires in 20
  // seconds, or 12 on express. A sighted drag crosses that instantly; the
  // assistive path could not traverse it at all. The control was reachable
  // and unusable, which is the harder failure to notice.
  //
  // The step policy lives in ./fare-step so the "is it actually traversable
  // before the offer expires" property can be asserted without React Native.
  const step = fareStep(min, max);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));

  return (
    <View
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      {...pan.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Your fare"
      accessibilityHint={`Swipe up or down to change your fare between ${min} and ${max} ${currencyLabel}. Each swipe moves it by ${step}.`}
      accessibilityValue={{
        min,
        max,
        now: value,
        text: secondsLeft != null
          ? `${value} ${currencyLabel}. ${secondsLeft} seconds left to accept.`
          : `${value} ${currencyLabel}`,
      }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'increment') onChange(clamp(value + step));
        if (e.nativeEvent.actionName === 'decrement') onChange(clamp(value - step));
      }}
      style={{ height: 44, justifyContent: 'center' }}
    >
      {/* track */}
      <View style={{ height: 8, borderRadius: 4, backgroundColor: color.surface.subtle }} />
      {/* filled portion */}
      <View
        style={{ position: 'absolute', left: 0, height: 8, borderRadius: 4, width: Math.max(0, Math.min(w, pct * w)), backgroundColor: color.brand[500] }}
      />
      {/* thumb */}
      <View
        style={{
          position: 'absolute',
          left: Math.max(0, Math.min(w - 28, pct * w - 14)),
          height: 28,
          width: 28,
          borderRadius: 14,
          backgroundColor: color.white,
          borderWidth: 2,
          borderColor: color.brand[500],
          boxShadow: shadow.card,
          elevation: 3,
        }}
      />
    </View>
  );
}
