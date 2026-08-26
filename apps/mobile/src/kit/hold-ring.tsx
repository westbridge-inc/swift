/** @jsxImportSource react */
import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { color, motion, space } from '@swift/ui';
import { haptic } from '../lib/haptics';
import { holdRingWindow } from './hold-window';
import { T } from './text';

// Promoted verbatim from DeliveryScreen [Wave 3 part 2] — the component was
// born there but the moment is platform-wide (any held order on any rail).
// Its pure decision seams live in ./hold-window so the honesty matrix stays
// testable without a native harness.

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const RING_SIZE = space['5xl'] * 2;
const RING_STROKE = space.xs + space.xs / 2;
const RING_CENTER = RING_SIZE / 2;
const RING_R = (RING_SIZE - RING_STROKE) / 2;
const RING_C = 2 * Math.PI * RING_R;

/** THE HOLD RING (design-100× Part 5 moment 1): the cancellation window as
 *  a draining ring — brand stroke on a brand track, mm:ss in displayXl
 *  tabular at its center, server-timestamped, one linear sweep per second.
 *  At 0:30 the ring, digits and copy shift to warning and the warn haptic
 *  fires once. The ticking is information, not decoration. No fake movement:
 *  when the window ends the order refetches and the timeline takes over. */
export function HoldRing({
  holdExpiresAt,
  placedAt,
  releaseLead,
  cancellationCaption,
  onExpire,
  hidden,
}: {
  holdExpiresAt?: string | null;
  placedAt?: string | null;
  releaseLead: string;
  cancellationCaption: string;
  onExpire: () => void;
  /** A cancelled order keeps its future holdExpiresAt — never show a live
   *  "you can still cancel" ring over the cancelled banner. REQUIRED. */
  hidden: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [appIsActive, setAppIsActive] = useState(
    () => AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
  );
  const warned = useRef(false);
  const expired = useRef(false);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const hiddenForClock = hidden || !appIsActive;
  const serverWindow = holdRingWindow(holdExpiresAt, placedAt, now, hiddenForClock);
  const remainingMs = serverWindow?.remainingMs ?? 0;
  const remaining = Math.ceil(remainingMs / 1000);
  const active = serverWindow != null;
  const warn = active && remainingMs <= 30_000;

  const progress = useSharedValue(serverWindow?.progress ?? 0);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const isActive = state === 'active';
      setAppIsActive(isActive);
      if (isActive) setNow(Date.now());
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    warned.current = false;
    expired.current = false;
    const windowAtReset = holdRingWindow(holdExpiresAt, placedAt, Date.now(), hiddenForClock);
    progress.value = windowAtReset?.progress ?? 0;
  }, [hiddenForClock, holdExpiresAt, placedAt, progress]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      const currentNow = Date.now();
      const next = holdRingWindow(holdExpiresAt, placedAt, currentNow, hiddenForClock);
      setNow(currentNow);
      progress.value = withTiming(next?.progress ?? 0, {
        duration: motion.duration.moment,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.System,
      });
      if (!next && !expired.current) {
        expired.current = true;
        onExpireRef.current();
      }
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, hiddenForClock, holdExpiresAt, placedAt]);

  useEffect(() => {
    if (warn && !warned.current) {
      warned.current = true;
      haptic.warn();
      AccessibilityInfo.announceForAccessibility(
        `Closing soon. Cancel now if you’ve changed your mind. ${cancellationCaption}`,
      );
    }
  }, [cancellationCaption, warn]);

  const ringProps = useAnimatedProps(() => ({
    strokeDashoffset: RING_C * (1 - progress.value),
  }));

  if (!active) return null;
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  const hue = warn ? color.warning : color.brand[500];

  return (
    <View
      accessible
      accessibilityLabel={`${remaining <= 0 ? 'Hold closing' : `${Math.floor(remaining / 60)} minutes ${remaining % 60} seconds remaining`}. ${releaseLead} when the countdown closes.${warn ? ' Closing soon. Cancel now if you’ve changed your mind.' : ''} ${cancellationCaption}`}
      style={{ alignItems: 'center', paddingVertical: space.md, marginBottom: space.md }}
    >
      <View style={{ width: RING_SIZE, height: RING_SIZE, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} style={{ position: 'absolute' }}>
          <Circle cx={RING_CENTER} cy={RING_CENTER} r={RING_R} stroke={color.brand[100]} strokeWidth={RING_STROKE} fill="none" />
          <AnimatedCircle
            cx={RING_CENTER}
            cy={RING_CENTER}
            r={RING_R}
            stroke={hue}
            strokeWidth={RING_STROKE}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${RING_C}`}
            animatedProps={ringProps}
            transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
          />
        </Svg>
        <T variant="displayXl" style={{ color: hue }}>
          {mm}:{String(ss).padStart(2, '0')}
        </T>
      </View>
      <T variant="bodyStrong" center style={{ marginTop: space.md }}>
        {releaseLead} in {mm}:{String(ss).padStart(2, '0')}.
      </T>
      {warn ? (
        <T variant="label" tone="warning" center style={{ marginTop: space.xs }}>
          Closing soon — cancel now if you’ve changed your mind.
        </T>
      ) : null}
      <T variant="caption" tone="muted" center style={{ marginTop: space.xs }}>
        {cancellationCaption}
      </T>
    </View>
  );
}
