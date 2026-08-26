import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * [SITE-1.1 Part 6.3] The Permissions-Policy must not disable a feature the
 * site actually uses.
 *
 * `camera=()` is an EMPTY allowlist: it disables the feature for every origin,
 * self included. It reads like hardening and behaves like a bug. The failure is
 * invisible everywhere it would be caught — the build succeeds, every page
 * renders, the header looks strict in a scan — and then getUserMedia rejects in
 * a real browser and the KYC selfie step is dead.
 *
 * This shipped in #806 and was caught by walking the built site, not by CI.
 * The test exists so the next person cannot repeat it: it reads the policy out
 * of next.config.ts, greps the real source tree for the browser APIs behind
 * each feature, and fails when the site uses one the policy forbids.
 *
 * It also fails in the other direction — granting a feature nothing uses — so
 * the policy stays as tight as the product actually requires.
 */

const WEB_ROOT = process.cwd();

/**
 * feature → does THIS file need it?
 *
 * Judged per file, not across a concatenation, and the constraint's VALUE is
 * what counts. src/app/selfie/page.tsx calls `getUserMedia({ audio: false,
 * video: {...} })` — that is a camera use and explicitly NOT a microphone use.
 * A looser rule reads the word "audio" there and demands the site hand out a
 * microphone permission nothing asks for.
 */
const FEATURES: Record<string, (_src: string) => boolean> = {
  camera: (src) => /getUserMedia/.test(src) && /\bvideo:\s*(true|\{)/.test(src),
  microphone: (src) => /getUserMedia/.test(src) && /\baudio:\s*(true|\{)/.test(src),
  geolocation: (src) => /navigator\.geolocation|getCurrentPosition|watchPosition/.test(src),
};

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

const SOURCES = sourceFiles(join(WEB_ROOT, 'src')).map((file) => ({
  file,
  text: readFileSync(file, 'utf8'),
}));

/** The files that actually need a given feature — named, so a failure points somewhere. */
function usersOf(feature: string): string[] {
  const needs = FEATURES[feature]!;
  return SOURCES.filter(({ text }) => needs(text)).map(({ file }) => file.slice(WEB_ROOT.length + 1));
}

const policy = (() => {
  const config = readFileSync(join(WEB_ROOT, 'next.config.ts'), 'utf8');
  const match = config.match(/Permissions-Policy['"]?\s*,?\s*\n?\s*value:\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error('No Permissions-Policy found in next.config.ts');
  return match[1]!;
})();

function allowlistFor(feature: string): string | null {
  const m = policy.match(new RegExp(`${feature}=\\(([^)]*)\\)`));
  return m ? m[1]!.trim() : null;
}

describe('Permissions-Policy matches what the site actually does', () => {
  it('declares every feature it has an opinion about', () => {
    for (const feature of Object.keys(FEATURES)) {
      expect(allowlistFor(feature), `${feature} is not declared in the policy`).not.toBeNull();
    }
  });

  for (const feature of Object.keys(FEATURES)) {
    it(`grants ${feature} to self only when the source uses it`, () => {
      const users = usersOf(feature);
      const allowlist = allowlistFor(feature);

      if (users.length > 0) {
        // An empty allowlist here is the #806 bug: the feature is disabled for
        // self, so the code calling it fails silently in the browser.
        expect(
          allowlist,
          `${users.join(', ')} use${users.length === 1 ? 's' : ''} the ${feature} API, ` +
            `but the policy is ${feature}=() — an empty allowlist disables it for ` +
            `self too. Use ${feature}=(self).`,
        ).not.toBe('');
        expect(allowlist).toContain('self');
      } else {
        // Nothing uses it — do not hand it out.
        expect(
          allowlist,
          `nothing in src/ uses the ${feature} API, so the policy should be ${feature}=()`,
        ).toBe('');
      }
    });
  }

  it('never opens a feature to arbitrary third-party origins', () => {
    expect(policy).not.toContain('*');
  });
});
