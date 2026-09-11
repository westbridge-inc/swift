import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// [REPORT-102 / no-AI] NOTHING IN APPLICATION SOURCE MAY REACH A MODEL.
//
// The removal PR deleted `ai.test.ts`, whose import-boundary block was the only
// automated check that money, auth, verification and dispatch never import a
// model layer — while two operator-facing env templates said, in the present
// tense, that a CI gate enforced exactly that. Between the removal and the
// permanent gate there was therefore ZERO protection and two files promising
// otherwise. This closes that window.
//
// WHAT THIS IS NOT: a network boundary. A source scan cannot stop a container
// reaching a provider host; denying egress is owner-side infrastructure and is
// tracked separately. The permanent repository-wide gate (which also covers
// mobile, web, desktop, workflows and lockfiles) lands with its own change and
// deliberately lands LAST so it cannot pass before the removal is complete.
// This test covers API application source, which is where the runtime was.
// ---------------------------------------------------------------------------

const API_SRC = join(__dirname, '..');
/** This file necessarily contains the very strings it forbids. */
const ALLOWLIST = new Set(['__tests__/no-ai-boundary.test.ts']);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
};

// Built from fragments so this file's own source does not trip a future
// repository-wide gate that scans for these literals.
const A = 'anthropic';
const FORBIDDEN: Array<{ what: string; re: RegExp }> = [
  { what: 'a model provider SDK import', re: new RegExp(`from\\s+['"]@${A}-ai/`, 'i') },
  { what: 'a model provider package name', re: new RegExp(`@${A}-ai`, 'i') },
  { what: 'a model provider host', re: new RegExp(`api\\.${A}\\.com`, 'i') },
  { what: 'a model provider API key name', re: new RegExp(`${A}_api_key`, 'i') },
  { what: 'a model identifier', re: /['"`]claude-[a-z0-9.-]+['"`]/i },
  { what: 'a dynamic import of a model SDK', re: new RegExp(`import\\s*\\(\\s*['"][^'"]*${A}`, 'i') },
];

describe('[no-AI] no application source reaches a model', () => {
  const files = walk(API_SRC);

  it('the scan actually found the source tree — a gate that grades nothing is not a gate', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.endsWith(join('modules', 'order', 'order.service.ts')))).toBe(true);
  });

  it('no model SDK, host, key name or model id appears anywhere in apps/api/src', () => {
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(API_SRC, file);
      if (ALLOWLIST.has(rel.split('\\').join('/'))) continue;
      const text = readFileSync(file, 'utf8');
      for (const { what, re } of FORBIDDEN) {
        const line = text.split('\n').findIndex((l) => re.test(l));
        if (line >= 0) hits.push(`${rel}:${line + 1} — ${what}`);
      }
    }
    expect(
      hits,
      'Swift ships no model-backed capability. If a genuine need appears it is an owner decision, not a code change.',
    ).toEqual([]);
  });

  it('the money, auth, verification and dispatch paths import no ai/agent module', () => {
    // The boundary the deleted test guarded, stated as itself rather than as a
    // side effect of the modules no longer existing.
    const guarded = ['order', 'billing', 'auth', 'verification', 'dispatch', 'cash', 'booking', 'rides'];
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(API_SRC, file).split('\\').join('/');
      if (!guarded.some((m) => rel.startsWith(`modules/${m}/`))) continue;
      for (const [i, l] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (/from\s+['"][^'"]*\/(ai|agent)\/[^'"]*['"]/.test(l)) offenders.push(`${rel}:${i + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
