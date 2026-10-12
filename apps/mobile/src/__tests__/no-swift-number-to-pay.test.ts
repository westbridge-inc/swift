import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// [OWNER 8 Oct 23:58 (4) · 29 Sep] Partners pay the weekly fee ONLY through the
// MMG checkout page (card later): never at an MMG agent, never to a Swift
// Number. The server still sends the account's Swift Number (san /
// sanFormatted) for older builds; the phone app and the website never show it
// and never name a Swift Number or an agent as a way to pay.

const root = (path: string) => join(process.cwd(), path);
const SKIP_DIRS = new Set(['__tests__', 'test', '__mocks__', 'node_modules']);
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? (SKIP_DIRS.has(e.name) ? [] : files(join(path, e.name)))
    : /\.(?:[cm]?[jt]sx?)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !e.name.endsWith('.d.ts') ? [join(path, e.name)] : []);
}
/** The words a module can put on a screen: every string, template and piece of markup text. */
function words(fileName: string, code: string): string[] {
  const src = ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2022, true, /x$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) out.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}
/** Property reads of the Swift Number the server sends: `x.san`, `x.sanFormatted`, `x['san']`. */
function readsTheNumber(fileName: string, code: string): boolean {
  const src = ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2022, true, /x$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && (node.name.text === 'san' || node.name.text === 'sanFormatted')) found = true;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && ['san', 'sanFormatted'].includes(node.argumentExpression.text)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found;
}
const NAMED = /swift\s*number|pay\s+(?:at|through|with)\s+(?:an?\s+)?(?:mmg\s+)?agent/i;
const names = (file: string) => words(file, readFileSync(file, 'utf8')).some((text) => NAMED.test(text));

describe('no Swift Number or agent is offered as a way to pay the weekly fee', () => {
  const list = [...files(root('src')), ...files(root('../web/src'))];

  it('the phone app and the website never name one', () => {
    expect(list.length).toBeGreaterThan(400);
    expect(list.filter(names).map((f) => relative(root('../..'), f))).toEqual([]);
  }, 60_000);

  it('and never read the Swift Number the server still sends for older builds', () => {
    expect(list.filter((f) => readsTheNumber(f, readFileSync(f, 'utf8'))).map((f) => relative(root('../..'), f))).toEqual([]);
  }, 60_000);

  it('the detector sees a name or a read, and not a comment or a component name', () => {
    const probe = (code: string) => words('p.tsx', code).some((text) => NAMED.test(text)) || readsTheNumber('p.tsx', code);
    expect(probe("export const a = 'Pay at an MMG agent with your Swift Number';")).toBe(true);
    expect(probe('export const B = (s: { sanFormatted: string }) => <T>{s.sanFormatted}</T>;')).toBe(true);
    expect(probe("const s: any = {}; export const c = s['san'];")).toBe(true);
    expect(probe('// the Swift Number screen\nexport function VendorSwiftNumberScreen() { return null; }')).toBe(false);
  });
});
