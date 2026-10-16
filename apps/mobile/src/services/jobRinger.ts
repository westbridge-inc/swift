import { Vibration } from 'react-native';
import { hasJobRing } from './jobRingCapability';

// ---------------------------------------------------------------------------
// [RINGER · owner ruling 15 Oct] The job ring while the app is open: a new
// order on the store's takeover, an offer on the mover's card. It loops
// Swift's tone and buzzes on the same 2 s beat until the screen stops it
// (Accept, Decline, the order settling, unmount, the app leaving the
// foreground) or the deadline passes, whichever is first.
//
// The tone needs expo-audio, a NATIVE module that only build 12 has. On builds
// 9-11 (this JS can reach them over the air) expo-audio's JS is never even
// evaluated, because it throws on a binary without its native half and would
// take the whole screen down: the ring degrades to the buzz alone, which every
// build has. The ring respects the phone: it plays only when the ringer is on
// (playsInSilentMode false), and never in the background.
// ---------------------------------------------------------------------------

/** The parts of expo-audio the ring uses, typed here so nothing outside
 *  build 12 ever needs the package. */
export interface RingPlayer {
  loop: boolean;
  volume: number;
  play(): void;
  pause(): void;
  remove(): void;
}
export interface RingAudio {
  createAudioPlayer(source: unknown): RingPlayer;
  setAudioModeAsync(mode: {
    playsInSilentMode?: boolean;
    interruptionMode?: 'mixWithOthers' | 'doNotMix' | 'duckOthers';
    shouldPlayInBackground?: boolean;
  }): Promise<void>;
}

export interface RingDeps {
  /** expo-audio, or null on a binary without it. */
  audio: () => RingAudio | null;
  /** The bundled tone, as the audio player takes it. */
  source: () => unknown;
  vibrate: (pattern: number[]) => void;
  cancelVibration: () => void;
  now: () => number;
}

/** One beat of the buzz: wait, buzz, pause, buzz (ms). */
export const RING_VIBRATION = [0, 500, 250, 500];
/** The beat: the tone is 2.0 s long, and the buzz repeats with it. */
export const RING_PERIOD_MS = 2000;

/** expo-audio on a binary that has it; null otherwise, and on any failure.
 *  `load` exists for tests; the app always loads the real package. */
export function loadRingAudio(
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  load: () => unknown = () => require('expo-audio'),
): RingAudio | null {
  if (!hasJobRing()) return null;
  try {
    const mod = load() as Partial<RingAudio> | null | undefined;
    return mod && typeof mod.createAudioPlayer === 'function' && typeof mod.setAudioModeAsync === 'function'
      ? (mod as RingAudio)
      : null;
  } catch {
    return null;
  }
}

/** A ringer over `deps`. Each call starts one ring and returns its stop,
 *  which is safe to call any number of times. */
export function createJobRinger(deps: RingDeps) {
  return function startJobRing(opts: { deadlineMs?: number } = {}): () => void {
    const deadlineMs = typeof opts.deadlineMs === 'number' && Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : undefined;
    if (deadlineMs !== undefined && deadlineMs <= deps.now()) return () => {};

    let stopped = false;
    let player: RingPlayer | null = null;
    const release = (p: RingPlayer) => {
      try { p.pause(); } catch { /* already gone */ }
      try { p.remove(); } catch { /* already gone */ }
    };

    const buzz = () => deps.vibrate(RING_VIBRATION);
    buzz();
    const beat = setInterval(buzz, RING_PERIOD_MS);
    const deadline = deadlineMs !== undefined ? setTimeout(() => stop(), deadlineMs - deps.now()) : undefined;

    function stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(beat);
      if (deadline !== undefined) clearTimeout(deadline);
      deps.cancelVibration();
      if (player) release(player);
      player = null;
    }

    const audio = deps.audio();
    if (audio) {
      void (async () => {
        // The mode first, so not even the first ring sounds with the ringer off.
        try {
          await audio.setAudioModeAsync({ playsInSilentMode: false, interruptionMode: 'duckOthers', shouldPlayInBackground: false });
        } catch { /* the buzz still carries it */ }
        if (stopped) return;
        try {
          const created = audio.createAudioPlayer(deps.source());
          created.loop = true;
          created.volume = 1;
          created.play();
          if (stopped) release(created);
          else player = created;
        } catch { /* the buzz still carries it */ }
      })();
    }
    return stop;
  };
}

let audioOnce: RingAudio | null | undefined;

/** The app's ringer: the real expo-audio (looked up once), the bundled tone,
 *  the phone's vibrator. */
export const startJobRing = createJobRinger({
  audio: () => (audioOnce === undefined ? (audioOnce = loadRingAudio()) : audioOnce),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  source: () => require('../../assets/sounds/swift_job_ring.wav'),
  vibrate: (pattern) => Vibration.vibrate(pattern),
  cancelVibration: () => Vibration.cancel(),
  now: () => Date.now(),
});
