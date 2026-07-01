import { useRef, useState } from 'react';
import { View, PanResponder } from 'react-native';
import { color } from '@swift/ui';

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
}: {
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
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

  return (
    <View
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      {...pan.panHandlers}
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
          backgroundColor: '#fff',
          borderWidth: 2,
          borderColor: color.brand[500],
          shadowColor: '#000',
          shadowOpacity: 0.18,
          shadowRadius: 4,
          shadowOffset: { width: 0, height: 2 },
          elevation: 3,
        }}
      />
    </View>
  );
}
