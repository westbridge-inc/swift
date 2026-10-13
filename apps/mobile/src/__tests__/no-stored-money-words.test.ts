import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// [OWNER RULING 8 Oct, NO "WALLET" · legal] Swift holds no money for anyone, so
// no screen may call anything a "wallet", a "top up", a money "balance",
// "banked" money or "stored value". Weekly fees paid before they are due are
// "Fee paid ahead — covers N weeks"; the action is "Pay weekly fee". A
// partner's MMG account is their "MMG account". Owner: "change wording
// everywhere to save me legal trouble".
//
// This census reads what the phone app, the website and the admin console can
// put in front of a person: every string and every piece of markup text in the
// code they ship. Types, comments, identifiers and code-shaped keys
// ('walletBalanceGyd', 'WALLET', a cache key) are not words on a screen; the
// server's field names may stay.

const root = (path: string) => join(process.cwd(), path);
const SKIP_DIRS = new Set(['__tests__', 'test', '__mocks__', 'node_modules']);
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? (SKIP_DIRS.has(e.name) ? [] : files(join(path, e.name)))
    : /\.(?:[cm]?[jt]sx?)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !e.name.endsWith('.d.ts') ? [join(path, e.name)] : []);
}
/** Everything the phone app, the website and the admin console ship. */
const SURFACES = ['src', '../web/src', '../admin/src', '../../packages/ui/src', '../../packages/types/src'];

export const STORED_MONEY_WORDS = /\bwallets?\b|\btop[\s-]?ups?\b|\bbalances?\b|\bbanked\b|\bstored[\s-]value\b/i;
/** Phrases that use a listed word and are kept on purpose:
 *  - the Terms' denial that Swift "offers no wallet or stored value" — the
 *    sentence is the legal protection (served from the API, snapshotted into
 *    the website by legal:sync);
 *  - "trial balance", the accountants' name for debits equalling credits. */
const KEPT = [/offers no wallet or stored value/gi, /\btrial balance\b/gi];
/** A string shaped like code, not like words: an identifier, a key, an enum,
 *  or an API route (the server's route names may stay). */
const CODE_SHAPED = /^(?:[a-z][A-Za-z0-9_.:\-/]*|[A-Z0-9_]+|(?:(?:GET|POST|PUT|PATCH|DELETE) )?\/[\w/:.-]*)$/;

export function screenWords(fileName: string, code: string): { line: number; text: string }[] {
  const src = ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2022, true, /x$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isLiteralTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    const texts: string[] = [];
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) texts.push(node.text);
    else if (ts.isTemplateExpression(node)) texts.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
    else if (ts.isJsxText(node)) texts.push(node.text);
    for (const raw of texts) {
      const text = raw.trim();
      if (!text || CODE_SHAPED.test(text)) continue;
      const words = KEPT.reduce((t, kept) => t.replace(kept, ''), text);
      if (STORED_MONEY_WORDS.test(words)) out.push({ line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1, text: text.slice(0, 160) });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

describe('no stored-money words on any screen [owner ruling 8 Oct]', () => {
  it('the phone app, the website and the admin console say none of them', () => {
    const list = SURFACES.flatMap((dir) => files(root(dir)));
    expect(list.length).toBeGreaterThan(600);
    const hits = list.flatMap((file) => screenWords(file, readFileSync(file, 'utf8'))
      .map((hit) => `${relative(root('../..'), file)}:${hit.line} ${hit.text}`));
    expect(hits).toEqual([]);
  }, 120_000);

  it('the detector sees the words in strings, templates and markup — not in types, comments, identifiers or keys', () => {
    const probe = (code: string) => screenWords('probe.tsx', code).length > 0;
    expect(probe("export const a = 'Payment added to your balance.';")).toBe(true);
    expect(probe('export const B = () => <T>WALLET BALANCE</T>;')).toBe(true);
    expect(probe('export const C = () => <LinkText label="Top up" />;')).toBe(true);
    expect(probe('export const d = (n: number) => `${n} banked · covers 2 weeks`;')).toBe(true);
    expect(probe("export const e = { WALLET: 'Wallet' };")).toBe(true);
    expect(probe("export const f = 'the store\\'s MMG wallet';")).toBe(true);
    expect(probe("export type P = 'WALLET' | 'CASH';\n// wallet balance\nexport const walletBalanceGyd = 1;")).toBe(false);
    expect(probe("const s: any = {}; export const g = s['walletBalanceGyd'] ?? s['wallet'];")).toBe(false);
    expect(probe("export const r = (id: string) => [`/api/v1/admin/subscriptions/${id}/topup`, 'POST /subscriptions/:id/topup'];")).toBe(false);
    expect(probe("export const h = 'Swift offers no wallet or stored value.';")).toBe(false);
    expect(probe("export const i = 'Fee paid ahead — covers 2 weeks';")).toBe(false);
  });
});
