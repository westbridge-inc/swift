import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// [OWNER 17 Oct, live test of build 11] The store Team card said
// "Tap a role pill to switch Manager ↔ Staff." and the phone drew the arrow as
// a colour emoji: "this emoji in dashboard is not professional at all."
// Words or the app's own icon set (Feather / MaterialCommunityIcons via
// @expo/vector-icons on the phone) — never an emoji, on any screen, page or
// notification the phone app, the website, the admin console or the API puts
// in front of a person (the desktop ops console and shared packages too).
//
// What counts: a character that is BOTH Extended_Pictographic and Emoji (iOS
// draws these in colour even without U+FE0F — the ↔ above had none), a
// regional-indicator flag letter, the emoji variation selector U+FE0F and the
// keycap mark U+20E3. Plain typographic marks that are not Emoji (✓ ✕ ★ ·
// — →) are text glyphs and stay allowed. Only strings, templates and markup
// text are read, never comments.

const repo = join(process.cwd(), '..', '..');
const ROOTS = ['apps/mobile/src', 'apps/mobile/App.tsx', 'apps/web/src', 'apps/admin/src', 'apps/desktop/src', 'apps/api/src', 'packages'];
const SKIP_DIRS = new Set(['__tests__', 'test', 'tests', '__mocks__', 'node_modules', 'dist', 'build']);

/** Characters that may stay, each with its reason. */
const CHAR_ALLOW: Record<string, string> = {
  '©': 'the copyright sign is a legal mark: the OpenStreetMap licence attribution ("© OpenStreetMap contributors") and the site footer copyright line',
};

/** Whole files that may hold emoji, each with its reason. Every entry must still exist AND still hold one (no stale entries). */
const FILE_ALLOW: Record<string, string> = {
  'apps/web/src/legal/legal-html.ts':
    'the HTML entity decoder table (&copy; &reg; &trade;) for the legal documents: it maps entities found in the legal text, it is not copy',
  'apps/api/src/modules/discovery/taxonomy.seed.ts':
    'category pictograms are catalogue DATA the customer category rail draws (spec #17 6.1); moving the rail to the icon set is an OWNER decision raised 17 Oct (UI-POLISH) — delete this entry when it moves',
  'apps/mobile/src/lib/flags.ts':
    'the country flag in the phone-number calling-code chip (sign-in, emergency contacts) names the country, it is not decoration; OWNER decision raised 17 Oct (UI-POLISH) — delete this entry if he wants it gone',
};

const isEmoji = (ch: string): boolean =>
  (/\p{Extended_Pictographic}/u.test(ch) && /\p{Emoji}/u.test(ch)) ||
  /\p{Regional_Indicator}/u.test(ch) ||
  ch === '️' ||
  ch === '⃣';

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  if (/\.(?:[cm]?[jt]sx?)$/.test(path)) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? SKIP_DIRS.has(e.name)
        ? []
        : files(join(path, e.name))
      : /\.(?:[cm]?[jt]sx?)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !e.name.endsWith('.d.ts')
        ? [join(path, e.name)]
        : [],
  );
}

/** Every string, template piece and piece of markup text, with its line. */
function words(fileName: string, code: string): Array<{ line: number; text: string }> {
  const src = ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2022, true, /x$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ line: number; text: string }> = [];
  const at = (n: ts.Node, text: string) => out.push({ line: src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1, text });
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) at(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      at(node.head, node.head.text);
      for (const span of node.templateSpans) at(span.literal, span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

function offenders(text: string): string[] {
  return [...new Set([...text].filter((ch) => isEmoji(ch) && !(ch in CHAR_ALLOW)))];
}

const show = (chars: string[]) => chars.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' ');

describe('[UI-POLISH 17 Oct] no emoji in anything the apps or the API show a person', () => {
  const all = ROOTS.flatMap((r) => files(join(repo, r)));

  it('reads every app', () => {
    for (const r of ['apps/mobile/src', 'apps/web/src', 'apps/admin/src', 'apps/desktop/src', 'apps/api/src']) {
      expect(all.filter((f) => relative(repo, f).startsWith(r)).length, r).toBeGreaterThan(10);
    }
  });

  it('no string, template or markup text holds an emoji', () => {
    const found: string[] = [];
    for (const f of all) {
      const rel = relative(repo, f);
      if (rel in FILE_ALLOW) continue;
      const code = readFileSync(f, 'utf8');
      if (![...code].some(isEmoji)) continue;
      for (const w of words(f, code)) {
        const bad = offenders(w.text);
        if (bad.length) found.push(`${rel}:${w.line} ${show(bad)} ${JSON.stringify(w.text.slice(0, 80))}`);
      }
    }
    expect(found, 'use words or the app icon set instead').toEqual([]);
  });

  it('the allow-list is not stale: every allowed file exists and still holds an emoji', () => {
    for (const rel of Object.keys(FILE_ALLOW)) {
      const p = join(repo, rel);
      expect(existsSync(p), rel).toBe(true);
      expect([...readFileSync(p, 'utf8')].some(isEmoji), rel).toBe(true);
    }
  });

  it('the detector bites on the owner-reported arrow and spares plain text marks', () => {
    expect(offenders('Tap a role pill to switch Manager ↔ Staff.')).toEqual(['↔']);
    expect(offenders('Saved ✓ · 4.8★ — ✕ → next')).toEqual([]);
    expect(offenders('🚨 SOS')).toEqual(['🚨']);
    expect(offenders('🏷️')).toEqual(['🏷', '️']);
    expect(offenders('\u{1F1EC}\u{1F1FE}').length).toBe(2);
  });
});
