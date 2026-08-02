import { useEffect, useRef, useCallback } from 'react';
import { Dimensions, type View } from 'react-native';

// IAB-aligned viewability (spec §12.1): ≥50% of the unit on screen for ≥1
// continuous second → VIEWABLE_IMPRESSION, once. Home is a plain ScrollView
// (no viewability callbacks), so the unit measures itself twice a second while
// armed and stops the moment it fires — cheap, honest, battery-aware.

const CHECK_MS = 500;
const REQUIRED_CONSECUTIVE = 2; // 2 × 500 ms = the 1 s dwell

export function useAdViewability(opts: {
  enabled: boolean;
  onViewable: () => void;
  /** Extra visibility gate, e.g. "this slide is the current one" (AdBar). */
  isActive?: () => boolean;
  /** Called on every check with the current visibility — drives video
   *  play/pause (§13.1) without a second measuring loop. */
  onVisibility?: (visibleFraction: number) => void;
  /** Keep measuring after the viewable fired (for onVisibility consumers). */
  keepMeasuring?: boolean;
}) {
  const ref = useRef<View>(null);
  const fired = useRef(false);
  const streak = useRef(0);

  const { enabled, onViewable, isActive, onVisibility, keepMeasuring } = opts;
  const cbs = useRef({ onViewable, isActive, onVisibility });
  cbs.current = { onViewable, isActive, onVisibility };

  const check = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    node.measureInWindow((x, y, w, h) => {
      if (w <= 0 || h <= 0) return;
      const win = Dimensions.get('window');
      const visW = Math.max(0, Math.min(x + w, win.width) - Math.max(x, 0));
      const visH = Math.max(0, Math.min(y + h, win.height) - Math.max(y, 0));
      const fraction = (visW * visH) / (w * h);
      cbs.current.onVisibility?.(fraction);
      if (fired.current) return;
      const active = cbs.current.isActive ? cbs.current.isActive() : true;
      if (fraction >= 0.5 && active) {
        streak.current += 1;
        if (streak.current >= REQUIRED_CONSECUTIVE) {
          fired.current = true;
          cbs.current.onViewable();
        }
      } else {
        streak.current = 0;
      }
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (fired.current && !keepMeasuring) {
        clearInterval(timer);
        return;
      }
      check();
    }, CHECK_MS);
    return () => clearInterval(timer);
  }, [enabled, keepMeasuring, check]);

  /** Reset the once-latch (AdBar reuses one hook per slide change). */
  const reset = useCallback(() => {
    fired.current = false;
    streak.current = 0;
  }, []);

  return { ref, reset };
}
