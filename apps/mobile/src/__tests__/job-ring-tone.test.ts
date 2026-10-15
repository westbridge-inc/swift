import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [RINGER · owner ruling 15 Oct] Swift's job ring tone is ORIGINAL: the
// committed file is exactly what scripts/make-job-ring.mjs synthesizes from
// arithmetic, byte for byte, so its origin is provable from the repo alone.
// And it is a tone both platforms accept: an iOS notification sound must be
// PCM in a WAV under 30 s, an Android res/raw name only [a-z0-9_].
// ---------------------------------------------------------------------------

const MOBILE = process.cwd();
const TONE = join(MOBILE, 'assets/sounds/swift_job_ring.wav');
const SCRIPT = join(MOBILE, 'scripts/make-job-ring.mjs');

describe('the job ring tone', () => {
  it('is byte-for-byte what the committed generator synthesizes', () => {
    const generated = execFileSync(process.execPath, [SCRIPT, '--stdout'], { maxBuffer: 4 * 1024 * 1024 });
    expect(Buffer.compare(generated, readFileSync(TONE))).toBe(0);
  });

  it('is generated, never read: the generator opens no audio and fetches nothing', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).not.toMatch(/readFile|createReadStream|fetch\(|https?:\/\/|require\(/);
  });

  it('is a 2 s, loud, loopable, 16-bit mono PCM WAV that iOS and Android both play', () => {
    const wav = readFileSync(TONE);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    const rate = wav.readUInt32LE(24);
    expect(rate).toBe(44_100);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    const bytes = wav.readUInt32LE(40);
    expect(wav.length).toBe(44 + bytes);
    const seconds = bytes / 2 / rate;
    expect(seconds).toBe(2);
    expect(seconds).toBeLessThan(30); // iOS plays the default sound for anything longer

    const samples = Array.from({ length: bytes / 2 }, (_, i) => wav.readInt16LE(44 + i * 2));
    const peak = Math.max(...samples.map(Math.abs));
    const dbfs = 20 * Math.log10(peak / 32767);
    expect(dbfs).toBeGreaterThan(-2); // loud
    expect(peak).toBeLessThan(32767); // never clipped
    // Loopable: silent at both ends, so the repeat never clicks.
    expect(samples[0]).toBe(0);
    expect(samples.at(-1)).toBe(0);
    expect(/^[a-z0-9_]+\.wav$/.test('swift_job_ring.wav')).toBe(true);
  });
});
