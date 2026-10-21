import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REASON_MIN, reasonTooShort } from '@/lib/ask-reason';

// ---------------------------------------------------------------------------
// [ADM-006] THE OPERATOR STATES WHY, OR NOTHING HAPPENS.
//
// The server refuses a consequential action without a reason. That alone did
// not fix this console, because it DID send one — the literal string
// 'Suspended by admin', hard-coded at the call site. A reason nobody was asked
// for is a field, not an explanation. The ask itself is the in-page panel
// (components/mc/ReasonDialog); that a CANCELLED panel returns nothing, never
// a default, is graded as behaviour in components/mc/primitives.test.tsx.
//
// [UI-FIX-ADMIN] The browser prompt is gone from the console. Owner ruling (6
// Oct): no browser prompts. A window.prompt / confirm / alert lost the typed
// reason when the server refused, and the refusal was usually never shown. The
// last pages on it (zones, compliance, discovery, promos, jobs, custody,
// moderation, ads) now ask in the panel; this census keeps it that way.
// ---------------------------------------------------------------------------

const REAL = 'Three written warnings, then a no-show on a paid booking';
const SRC = join(process.cwd(), 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'test' || e.name === 'node_modules' ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Code only: comments may name the old shapes on purpose, to record what was removed. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/** A browser dialog or the removed prompt helper, called from console code. */
export function browserPrompts(source: string): string[] {
  // [REVIEW-F2 S4-3] a bare confirm(…) / prompt(…) / alert(…) is the same browser
  // dialog as window.confirm(…); a member call (actions.confirm) or a longer name
  // (onConfirm, confirmLabel) is not.
  return [...code(source).matchAll(/(\b(?:window|globalThis|self)\.(?:prompt|confirm|alert)|(?<![\w.$])(?<!function\s+)(?:prompt|confirm|alert)|\baskReason)\s*\(/g)].map((m) => m[1]!);
}

describe('[ADM-006] the reason floor', () => {
  it('matches the server: fewer than REASON_MIN characters is not a reason', () => {
    expect(REASON_MIN).toBe(12);
    expect(reasonTooShort('Too short.')).toBe(true);
    expect(reasonTooShort('   abcdefghijk   ')).toBe(true); // 11 once trimmed
    expect(reasonTooShort(REAL)).toBe(false);
  });
});

describe('[UI-FIX-ADMIN] no console page asks through a browser prompt', () => {
  const files = sources(SRC);

  it('the census reads the console (it is not vacuous)', () => {
    expect(files.length).toBeGreaterThanOrEqual(80);
    expect(files.some((f) => f.endsWith(join('app', 'moderation', 'page.tsx')))).toBe(true);
  });

  it('no window.prompt / confirm / alert, and no askReason, anywhere in console code', () => {
    const offenders = files.flatMap((f) => browserPrompts(readFileSync(f, 'utf8')).map((call) => `${relative(SRC, f)}: ${call}(…)`));
    expect(offenders).toEqual([]);
  });

  it('bites: each shape that used to be here is found; a comment naming it is not', () => {
    expect(browserPrompts(`const r = askReason({ action: 'ban' }); if (r) m.mutate(r);`)).toEqual(['askReason']);
    expect(browserPrompts(`const id = window.prompt('Rider id:')?.trim();`)).toEqual(['window.prompt']);
    expect(browserPrompts(`if (!window.confirm('Sure?')) return;`)).toEqual(['window.confirm']);
    expect(browserPrompts(`window.alert('Nothing was changed.');`)).toEqual(['window.alert']);
    expect(browserPrompts(`if (!confirm('Sure?')) return;`)).toEqual(['confirm']);
    expect(browserPrompts(`const id = prompt('Rider id:');`)).toEqual(['prompt']);
    expect(browserPrompts(`globalThis.alert('x');`)).toEqual(['globalThis.alert']);
    expect(browserPrompts(`onConfirm(x); actions.confirm(x); const c = { confirmLabel: 'Go' }; promptText(x);`)).toEqual([]);
    expect(browserPrompts(`// it used to call window.prompt('x') here\nconst reason = await ask(p);`)).toEqual([]);
    expect(browserPrompts(`/** askReason(p) became ask(p) */ const reason = await ask(p);`)).toEqual([]);
  });
});
