import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';
import { motion, radius, space } from '@swift/ui';
import { T } from './text';

/**
 * CalmRadar — the "searching" moment: two slow rings breathing out of a
 * centerpiece (promoted from TaxiScreen's SearchingCard [Wave 3 part 2]).
 * The rings are AMBIENCE for a server-owned pending state and nothing more —
 * no fake nearby cars, no elapsed-time theatre, no wait-time promises the
 * server didn't make. Reduce-motion collapses them to two static halos.
 *
 * `ink` colours the rings (pass the vertical's tint ink); `center` is the
 * anchor mark (a tinted pin, an avatar). Copy is caller-supplied facts.
 */
export function CalmRadar({
  ink,
  center,
  title,
  caption,
}: {
  ink: string;
  center: ReactNode;
  title?: string;
  caption?: string;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: motion.duration.moment,
        easing: Easing.bezier(...motion.easing.decelerate),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [pulse, reduceMotion]);

  const ringStyle = (inner: boolean) => ({
    position: 'absolute' as const,
    width: space['5xl'] * 2,
    height: space['5xl'] * 2,
    borderRadius: radius.full,
    borderWidth: inner ? StyleSheet.hairlineWidth : space.xs / 2,
    borderColor: ink,
    opacity: reduceMotion
      ? inner ? 0.18 : 0.1
      : pulse.interpolate({ inputRange: [0, 1], outputRange: inner ? [0.28, 0] : [0.18, 0] }),
    transform: [{
      scale: reduceMotion
        ? inner ? 0.72 : 1
        : pulse.interpolate({ inputRange: [0, 1], outputRange: inner ? [0.42, 0.86] : [0.68, 1.18] }),
    }],
  });

  return (
    <View style={{ alignItems: 'center', paddingVertical: space.xl }}>
      <View style={{ width: space['5xl'] * 2, height: space['5xl'] * 2, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View style={ringStyle(false)} />
        <Animated.View style={ringStyle(true)} />
        {center}
      </View>
      {title ? (
        <T variant="title" style={{ marginTop: space.md }}>
          {title}
        </T>
      ) : null}
      {caption ? (
        <T variant="caption" tone="muted" center style={{ marginTop: space.xs }}>
          {caption}
        </T>
      ) : null}
    </View>
  );
}
