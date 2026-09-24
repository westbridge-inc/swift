import { useCallback, useEffect, useState } from 'react';
import { secondsUntil } from '../lib/otpCooldown';

/**
 * A live whole-second countdown toward a wall-clock deadline. It counts a
 * deadline, not ticks: iOS pauses JS timers while the person is in Messages
 * reading their code, and a decremented counter would come back still showing
 * time the server has already let pass. `start` re-aims it (a fresh send, or
 * the server's own figure after a refusal).
 */
export function useCountdown(initialSeconds = 0): { secondsLeft: number; start: (seconds: number) => void } {
  const [deadline, setDeadline] = useState(() => Date.now() + initialSeconds * 1000);
  const [now, setNow] = useState(() => Date.now());
  const secondsLeft = secondsUntil(deadline, now);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    // Wake exactly when the whole-second figure next changes.
    const t = setTimeout(() => setNow(Date.now()), (deadline - now) % 1000 || 1000);
    return () => clearTimeout(t);
  }, [deadline, now, secondsLeft]);

  const start = useCallback((seconds: number) => {
    const at = Date.now();
    setNow(at);
    setDeadline(at + seconds * 1000);
  }, []);

  return { secondsLeft, start };
}
