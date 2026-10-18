import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [RINGER · owner ruling 15 Oct] The ring while the app is open: Swift's tone
// looped with a strong buzz on one 2 s beat, until stopped or the deadline.
// On builds 9-11 (no expo-audio native module) expo-audio's JS is never
// evaluated, because it throws on such a binary: the buzz alone carries it.
// ---------------------------------------------------------------------------

const capability = vi.hoisted(() => ({ hasJobRing: vi.fn(() => true) }));
vi.mock('./jobRingCapability', () => capability);
vi.mock('react-native', () => ({ Vibration: { vibrate: vi.fn(), cancel: vi.fn() } }));

import { RING_PERIOD_MS, RING_VIBRATION, createJobRinger, loadRingAudio, type RingAudio, type RingPlayer } from './jobRinger';

function fakeAudio() {
  const player = { loop: false, volume: 0, play: vi.fn(), pause: vi.fn(), remove: vi.fn() } satisfies RingPlayer;
  const audio = {
    createAudioPlayer: vi.fn((_source: unknown) => player),
    setAudioModeAsync: vi.fn(async () => undefined),
  };
  return { audio: audio as RingAudio & typeof audio, player };
}

function rig(audio: RingAudio | null) {
  const vibrate = vi.fn();
  const cancelVibration = vi.fn();
  const start = createJobRinger({ audio: () => audio, source: () => 'tone-asset', vibrate, cancelVibration, now: () => Date.now() });
  return { start, vibrate, cancelVibration };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-15T18:00:00.000Z'));
  capability.hasJobRing.mockReturnValue(true);
});
afterEach(() => vi.useRealTimers());

describe('createJobRinger', () => {
  it('build 12: loops the tone at full volume, ringer-respecting, and buzzes every beat until stopped', async () => {
    const { audio, player } = fakeAudio();
    const { start, vibrate, cancelVibration } = rig(audio);
    const stop = start();
    await flush();

    expect(audio.setAudioModeAsync).toHaveBeenCalledWith({ playsInSilentMode: false, interruptionMode: 'duckOthers', shouldPlayInBackground: false });
    expect(audio.createAudioPlayer).toHaveBeenCalledWith('tone-asset');
    expect({ loop: player.loop, volume: player.volume }).toEqual({ loop: true, volume: 1 });
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenLastCalledWith(RING_VIBRATION);
    expect(RING_PERIOD_MS).toBe(2000);

    vi.advanceTimersByTime(RING_PERIOD_MS * 3);
    expect(vibrate).toHaveBeenCalledTimes(4);

    stop();
    expect(player.pause).toHaveBeenCalled();
    expect(player.remove).toHaveBeenCalled();
    expect(cancelVibration).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RING_PERIOD_MS * 5);
    expect(vibrate).toHaveBeenCalledTimes(4);
    stop(); // safe twice
    expect(cancelVibration).toHaveBeenCalledTimes(1);
  });

  it('stops by itself at the deadline', async () => {
    const { audio, player } = fakeAudio();
    const { start, vibrate, cancelVibration } = rig(audio);
    start({ deadlineMs: Date.now() + 5_000 });
    await flush();
    vi.advanceTimersByTime(4_999);
    expect(player.remove).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(player.remove).toHaveBeenCalled();
    expect(cancelVibration).toHaveBeenCalledTimes(1);
    const buzzes = vibrate.mock.calls.length;
    vi.advanceTimersByTime(RING_PERIOD_MS * 5);
    expect(vibrate).toHaveBeenCalledTimes(buzzes);
  });

  it('a deadline already past rings nothing at all', async () => {
    const { audio } = fakeAudio();
    const { start, vibrate } = rig(audio);
    start({ deadlineMs: Date.now() });
    await flush();
    expect(vibrate).not.toHaveBeenCalled();
    expect(audio.createAudioPlayer).not.toHaveBeenCalled();
  });

  it('builds 9-11 (no audio): the buzz alone, every beat', () => {
    const { start, vibrate, cancelVibration } = rig(null);
    const stop = start();
    vi.advanceTimersByTime(RING_PERIOD_MS);
    expect(vibrate).toHaveBeenCalledTimes(2);
    stop();
    expect(cancelVibration).toHaveBeenCalledTimes(1);
  });

  it('an audio failure never costs the buzz', async () => {
    const { audio } = fakeAudio();
    audio.createAudioPlayer.mockImplementation(() => { throw new Error('no audio session'); });
    const { start, vibrate } = rig(audio);
    start();
    await flush();
    vi.advanceTimersByTime(RING_PERIOD_MS);
    expect(vibrate).toHaveBeenCalledTimes(2);
  });

  it('stopped before the audio was ready: the tone never starts', async () => {
    const { audio, player } = fakeAudio();
    const { start } = rig(audio);
    const stop = start();
    stop();
    await flush();
    expect(player.play).not.toHaveBeenCalled();
  });
});

describe('loadRingAudio: never evaluates expo-audio on a binary without it', () => {
  it('builds 9-11: does not even try to load the package', () => {
    capability.hasJobRing.mockReturnValue(false);
    const load = vi.fn(() => { throw new Error('Cannot find native module ExpoAudio'); });
    expect(loadRingAudio(load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('build 12: the package, or null if it fails or is not what the ring needs', () => {
    const { audio } = fakeAudio();
    expect(loadRingAudio(() => audio)).toBe(audio);
    expect(loadRingAudio(() => { throw new Error('boom'); })).toBeNull();
    expect(loadRingAudio(() => ({}))).toBeNull();
    expect(loadRingAudio(() => undefined)).toBeNull();
  });

  it('no file imports expo-audio statically (a static import throws on builds 9-11 before any guard runs)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)
          && /from ['"]expo-audio['"]|import\(['"]expo-audio['"]\)/.test(readFileSync(path, 'utf8'))) offenders.push(path);
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
    expect(readFileSync(join(process.cwd(), 'src/services/jobRinger.ts'), 'utf8').match(/require\('expo-audio'\)/g)).toHaveLength(1);
  });
});
