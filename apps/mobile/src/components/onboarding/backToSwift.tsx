/** @jsxImportSource react */
import React from 'react';
import { BackHandler, PanResponder, Platform, type PanResponderGestureState, type ViewProps } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Screen } from '../../kit';
import { useRoleSwitch } from '../RoleSwitcherSheet';

// ---------------------------------------------------------------------------
// [Owner, 1 Oct] "here you cant go back once you pick store".
//
// Picking "Swift Business" or "Swift Driver" opens that sign-up as the ROOT of
// the app — there is no screen behind it — so iOS had no swipe-back, Android's
// back button closed the app, and `intent` is remembered, so the next launch
// opened the same screen. The way back is now the same in all three places:
// the header's "‹ Swift", Android's back (button or gesture) and a swipe from
// the left edge on iPhone each run `leave`, which is the role switcher's own
// move to the customer app (useRoleSwitch → switch-role CUSTOMER). It touches
// nothing else: the store, the saved vehicle and every uploaded document stay
// on the server, and the sign-up is one "Earn with Swift" away.
// ---------------------------------------------------------------------------

/** Leave a partner sign-up for ordering in Swift, through the switcher's authority path. */
export function useBackToSwift(current: 'vendor' | 'mover') {
  const { switchTo, switching } = useRoleSwitch(current);
  // A back press, a swipe and a tap can land together; the first one runs.
  const inFlight = React.useRef(false);
  const leave = React.useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    void switchTo('customer').finally(() => {
      inFlight.current = false;
    });
  }, [switchTo]);
  return { leave, leaving: switching };
}

/** Where an iOS back swipe may start: the left edge, as the system's own does. */
export const EDGE_SWIPE_START = 24;

/** A drag that began at the left edge and is moving right — not a scroll. */
export function edgeBackSwipeStarts(gesture: Pick<PanResponderGestureState, 'moveX' | 'dx' | 'dy'>): boolean {
  const startX = gesture.moveX - gesture.dx;
  return startX <= EDGE_SWIPE_START && gesture.dx > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 2;
}

/** Let go far enough, or fast enough, to mean "back". */
export function edgeBackSwipeCompletes(gesture: Pick<PanResponderGestureState, 'dx' | 'vx'>): boolean {
  return gesture.dx >= 100 || (gesture.dx >= 40 && gesture.vx >= 0.5);
}

/**
 * Android's back and the iOS edge swipe run `onBack` while this screen is the
 * focused one; anything opened on top of it (Get help, an appeal) keeps its
 * own back. Returns the swipe's handlers for the screen's root view. Off
 * (`enabled` false), the screen keeps the platform's own back.
 */
export function useBackToSwiftGestures(onBack: () => void, enabled = true): ViewProps {
  const latest = React.useRef(onBack);
  React.useEffect(() => {
    latest.current = onBack;
  }, [onBack]);

  useFocusEffect(
    React.useCallback(() => {
      if (!enabled) return undefined;
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        latest.current();
        return true;
      });
      return () => subscription.remove();
    }, [enabled]),
  );

  // Android's edge gesture IS its back press (above). iOS offers no system
  // back here — there is no screen behind — so the app takes the swipe. The
  // capture phase claims only a rightward drag from the edge: taps and scrolls
  // below never see it.
  const edgeSwipe = React.useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) => edgeBackSwipeStarts(gesture),
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: (_event, gesture) => {
          if (edgeBackSwipeCompletes(gesture)) latest.current();
        },
      }),
    [],
  );
  return enabled && Platform.OS === 'ios' ? edgeSwipe.panHandlers : {};
}

/** The kit's Screen, for a partner sign-up: Android's back and the iOS edge swipe go back to Swift. */
export function BackToSwiftScreen({ onBack, children, ...rest }: React.ComponentProps<typeof Screen> & { onBack: () => void }) {
  const gestures = useBackToSwiftGestures(onBack);
  return (
    <Screen {...rest} {...gestures}>
      {children}
    </Screen>
  );
}
