import { useEffect, useRef, useState } from 'react';
import { Easing, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import {
  type DriverPing,
  MIN_INTERVAL_MS,
  STALE_AFTER_MS,
  isStale,
  planSweep,
  staleAgeSeconds,
} from './interpolation';

/**
 * The 6.3 hook: feed it the newest driver ping; it keeps the marker driving.
 * Position + bearing live on Reanimated shared values and reach the map as
 * `animatedProps` for a `Animated.createAnimatedComponent(MarkerAnimated)`
 * (`coordinate` + `rotation`) — the sweep runs on the UI thread, so a JS GC
 * mid-trip never stutters the car.
 *
 * Honesty (0.8): once the newest fix ages past 15s the sweep freezes where it
 * is and `stale` flips true — the screen dims the car and shows S-56
 * ("Location last updated {n}s ago") instead of gliding on fiction.
 */
export function useInterpolatedDriver(ping: DriverPing | null) {
  const lat = useSharedValue<number | null>(null);
  const lng = useSharedValue<number | null>(null);
  const bearing = useSharedValue(0);

  const lastPingRef = useRef<DriverPing | null>(null);
  const prevArrivalRef = useRef<number | null>(null);
  const observedIntervalRef = useRef<number>(4_000); // spec: raw pings run 3–5s
  const [stale, setStale] = useState(false);
  const [staleAgeS, setStaleAgeS] = useState(0);

  // New ping → plan the sweep from the currently-rendered values.
  useEffect(() => {
    if (!ping) return;
    const prev = lastPingRef.current;
    if (prev && ping.receivedAt === prev.receivedAt) return; // same fix, no-op

    // Rolling cadence measure (last gap wins — Georgetown streams are steady).
    if (prevArrivalRef.current != null) {
      const gap = ping.receivedAt - prevArrivalRef.current;
      if (gap > 250) observedIntervalRef.current = gap;
    }
    prevArrivalRef.current = ping.receivedAt;
    lastPingRef.current = ping;
    setStale(false);

    if (lat.value == null || lng.value == null) {
      // First fix: appear in place (the marker's own 300ms scale-pop is the
      // arrival moment, per 6.2) — nothing to sweep from.
      lat.value = ping.latitude;
      lng.value = ping.longitude;
      if (ping.heading != null && Number.isFinite(ping.heading)) bearing.value = ping.heading;
      return;
    }

    const plan = planSweep(
      { latitude: lat.value, longitude: lng.value, bearing: bearing.value },
      ping,
      observedIntervalRef.current,
    );
    const timing = { duration: plan.durationMs, easing: Easing.linear };
    lat.value = withTiming(ping.latitude, timing);
    lng.value = withTiming(ping.longitude, timing);
    if (plan.bearingTarget != null) {
      bearing.value = withTiming(plan.bearingTarget, { duration: Math.min(plan.durationMs, MIN_INTERVAL_MS), easing: Easing.linear });
    }
  }, [ping, lat, lng, bearing]);

  // The staleness clock — a dead feed sends nothing, so only a timer notices
  // the silence. Cheap 3s cadence, same idiom as the ActiveJob stale check.
  useEffect(() => {
    const t = setInterval(() => {
      const last = lastPingRef.current;
      if (!last) return;
      const now = Date.now();
      const s = isStale(last, now);
      setStale(s);
      if (s) setStaleAgeS(staleAgeSeconds(last, now));
    }, 3_000);
    return () => clearInterval(t);
  }, []);

  const animatedProps = useAnimatedProps(() => ({
    coordinate:
      lat.value == null || lng.value == null
        ? undefined
        : { latitude: lat.value, longitude: lng.value },
    rotation: bearing.value,
  }));

  return {
    /** Spread onto Animated.createAnimatedComponent(Marker). */
    animatedProps,
    /** Nothing rendered yet (no fix has ever landed). */
    hasFix: lastPingRef.current != null,
    /** Freeze + desaturate + S-56 when true. */
    stale,
    /** "{n}s ago" for S-56 — only meaningful while stale. */
    staleAgeS,
    /** The honesty line, exported for the screen's copy/tests. */
    staleAfterMs: STALE_AFTER_MS,
  };
}
