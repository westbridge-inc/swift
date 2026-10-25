#!/usr/bin/env node
// ---------------------------------------------------------------------------
// [RINGER · owner ruling 15 Oct] Swift's job ring tone, synthesized here from
// plain arithmetic, so its origin is this file: no recording, no sample, no
// downloaded or third-party audio. Run it to (re)write the tone:
//
//   node apps/mobile/scripts/make-job-ring.mjs           writes assets/sounds/swift_job_ring.wav
//   node apps/mobile/scripts/make-job-ring.mjs --stdout  writes the same bytes to stdout
//
// The output is deterministic, and src/__tests__/job-ring-tone.test.ts checks
// that the committed file is byte-for-byte what this script produces.
//
// The tone: two bright trills (C6 and E6 alternating 16 times a second, with
// a soft octave on top so small phone speakers carry it), 0.5 s each, 0.25 s
// apart, then 0.75 s of quiet. 2.0 s in all, so it loops as a steady
// ring-ring ... ring-ring. Every burst starts and ends at silence through a
// 10 ms fade, so the loop never clicks. Peak about -1 dBFS: loud, not clipped.
// 16-bit mono PCM WAV, 44.1 kHz: a format both iOS notification sounds
// (under 30 s) and Android res/raw accept.
// ---------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLE_RATE = 44_100;
export const DURATION_S = 2.0;
const PEAK = 0.89; // about -1 dBFS
const FADE_S = 0.01;
const TRILL_HZ = 16;
const NOTES = [1046.5, 1318.51]; // C6, E6
const BURSTS = [
  { start: 0.0, length: 0.5 },
  { start: 0.75, length: 0.5 },
];

/** Which burst, if any, sample `i` falls in, and how far into it. */
function burstAt(i) {
  const t = i / SAMPLE_RATE;
  for (const burst of BURSTS) {
    const local = t - burst.start;
    if (local >= 0 && local < burst.length) return { burst, local };
  }
  return null;
}

/** Every sample of the tone, in [-1, 1]. The phase is carried from sample to
 *  sample, so the switch between the two notes of the trill is seamless. */
function samples() {
  const frames = Math.round(SAMPLE_RATE * DURATION_S);
  const out = new Float64Array(frames);
  let phase = 0;
  for (let i = 0; i < frames; i += 1) {
    const at = burstAt(i);
    if (!at) {
      phase = 0;
      continue;
    }
    const { burst, local } = at;
    const envelope = Math.min(1, local / FADE_S, (burst.length - local) / FADE_S);
    const note = NOTES[Math.floor(local * TRILL_HZ * 2) % 2];
    // The fundamental plus a quiet octave. Their sum peaks at about 1.10, so
    // dividing by 1.11 keeps the tone just under PEAK.
    out[i] = (envelope * PEAK * (Math.sin(phase) + 0.25 * Math.sin(2 * phase))) / 1.11;
    phase = (phase + (2 * Math.PI * note) / SAMPLE_RATE) % (2 * Math.PI);
  }
  return out;
}

/** The tone as a complete WAV file. */
export function synthJobRing() {
  const values = samples();
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2);
  });
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const wav = synthJobRing();
  if (process.argv.includes('--stdout')) {
    process.stdout.write(wav);
  } else {
    const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds', 'swift_job_ring.wav');
    writeFileSync(out, wav);
    process.stderr.write(`wrote ${out} (${wav.length} bytes)\n`);
  }
}
