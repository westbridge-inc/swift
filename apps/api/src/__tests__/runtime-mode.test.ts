import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RUNTIME_MODES, RuntimeModeError, isDevelopment, isProduction, parseRuntimeMode, runtimeMode } from '../utils/runtime-mode';

// ---------------------------------------------------------------------------
// [TA-S1-007 / F036-02] ONE typed runtime-mode parser, and nothing else keys
// on the raw string.
//
// Every posture decision used to compare NODE_ENV to the exact word
// "production", so unset or misspelled meant "not production": sandbox
// providers, dev push, plaintext documents, repository-known salts, a
// single-node realtime — quietly, while serving traffic. The parser below
// refuses anything but the four exact words, and the census keeps the exact
// string comparison from creeping back anywhere in the API.
// ---------------------------------------------------------------------------

describe('parseRuntimeMode', () => {
  it('accepts exactly the four words', () => {
    for (const m of RUNTIME_MODES) expect(parseRuntimeMode(m)).toBe(m);
    expect(RUNTIME_MODES).toEqual(['production', 'development', 'test', 'loadtest']);
  });

  it.each([undefined, '', 'prod', 'Production', 'PRODUCTION', ' production', 'production ', 'productio', 'dev', 'staging', 'local'])(
    'refuses %j — never a quiet development posture',
    (raw) => {
      expect(() => parseRuntimeMode(raw as string | undefined)).toThrow(RuntimeModeError);
      expect(() => parseRuntimeMode(raw as string | undefined)).toThrow(/NODE_ENV must be exactly one of production \| development \| test \| loadtest/);
    },
  );

  it('names the offending value in the refusal, and says "(unset)" when there is none', () => {
    expect(() => parseRuntimeMode('prod')).toThrow(/got "prod"/);
    expect(() => parseRuntimeMode(undefined)).toThrow(/got \(unset\)/);
  });
});

describe('the posture helpers', () => {
  it('isProduction / isDevelopment read the mode from the env they are given', () => {
    expect(isProduction({ NODE_ENV: 'production' })).toBe(true);
    expect(isProduction({ NODE_ENV: 'development' })).toBe(false);
    expect(isProduction({ NODE_ENV: 'loadtest' })).toBe(false);
    expect(isDevelopment({ NODE_ENV: 'development' })).toBe(true);
    expect(isDevelopment({ NODE_ENV: 'test' })).toBe(false);
    expect(isDevelopment({ NODE_ENV: 'loadtest' })).toBe(false);
    expect(runtimeMode({ NODE_ENV: 'test' })).toBe('test');
  });

  it('a helper asked for the posture under an unknown NODE_ENV throws instead of guessing', () => {
    expect(() => isProduction({ NODE_ENV: 'prod' })).toThrow(RuntimeModeError);
    expect(() => isDevelopment({})).toThrow(RuntimeModeError);
  });

  it('this test process runs under a known mode (vitest pins NODE_ENV=test)', () => {
    expect(runtimeMode()).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// THE CENSUS: no production/development decision may compare the raw string
// again. Comments are stripped first so a phrase in prose cannot satisfy or
// trip the assertion (the hazard-matching rule), and the stripper is proved
// non-empty so a stripper that returned nothing could not pass everything.
// ---------------------------------------------------------------------------
const SRC = join(__dirname, '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const EXACT = /NODE_ENV'\]\s*[!=]==\s*'(production|development|test|loadtest)'/;
/** The sanctioned pass-throughs of the raw value: CORS origin resolution
 *  receives NODE_ENV as data (server + socket) and never decides posture from it. */
const ALLOWED_RAW_READS = new Set(['server.ts', 'plugins/socket.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('the census', () => {
  const files = walk(SRC);

  it('walks a real tree and the stripper leaves code behind', () => {
    expect(files.length).toBeGreaterThan(200);
    const sample = strip(readFileSync(join(SRC, 'utils/boot-config.ts'), 'utf8'));
    expect(sample.length).toBeGreaterThan(1_000);
    expect(sample).toContain('runtimeMode(env)');
  });

  it('no file outside the parser compares NODE_ENV to a posture word', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(SRC, f);
      if (rel === 'utils/runtime-mode.ts') continue;
      const code = strip(readFileSync(f, 'utf8'));
      if (EXACT.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the raw value is read as data only where sanctioned', () => {
    const readers: string[] = [];
    for (const f of files) {
      const rel = relative(SRC, f);
      if (rel === 'utils/runtime-mode.ts') continue;
      const code = strip(readFileSync(f, 'utf8'));
      if (/process\.env\['NODE_ENV'\]/.test(code)) readers.push(rel);
    }
    expect(readers.filter((r) => !ALLOWED_RAW_READS.has(r))).toEqual([]);
  });

  it('the boot guard parses the mode rather than comparing it', () => {
    const boot = strip(readFileSync(join(SRC, 'utils/boot-config.ts'), 'utf8'));
    expect(boot).toContain("import { runtimeMode } from './runtime-mode';");
    expect((boot.match(/runtimeMode\(env\) !== 'production'/g) ?? []).length).toBe(2);
  });
});
