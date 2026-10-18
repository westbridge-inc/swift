import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// [Terms ¶11 · legal research A12 · GUARDRAILS §8 · owner R5] Swift promises
// what the Terms say: "Swift charges Partners no commission on Orders". Never
// a forever promise ("no commission, ever", "never a commission", "Zero
// commission — ever"): fees change only with notice, so a promise about the
// future is not one the Terms make. This census reads every string, template
// piece and markup text that the phone app, the website, the admin console,
// the desktop console, the API (statements, notifications, e-mails) and the
// shared packages put in front of a person — never comments.
// ---------------------------------------------------------------------------

const repo = join(__dirname, '..', '..', '..', '..');
const ROOTS = ['apps/mobile/src', 'apps/mobile/App.tsx', 'apps/web/src', 'apps/admin/src', 'apps/desktop/src', 'apps/api/src', 'packages'];
const SKIP_DIRS = new Set(['__tests__', 'test', 'tests', '__mocks__', 'node_modules', 'dist', 'build', '.next']);
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

/** A commission promise about all time: "never/ever/forever/always" within the same sentence as "commission". */
const FOREVER = /\b(?:never|ever|forever|always)\b[^.!?\n]{0,40}\bcommission|\bcommission[^.!?\n]{0,60}\b(?:ever|forever|always)\b/i;

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

/** Every string, template piece and piece of markup text, with its line (comments are not read). */
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

describe('partner copy: no commission on orders, never a forever promise', () => {
  it('the screens that state the model use the Terms wording', () => {
    const card = read('apps/mobile/src/components/onboarding/PricingCard.tsx');
    expect(card).toContain("'Service provider rate · Keep 100% of every booking — no commission on orders.'");
    expect(card).toContain('`Keep 100% of every sale — no commission on orders.');
    expect(card).toContain('rate · Keep 100% of every fare, fee and tip — no commission on orders.`');
    expect(read('apps/mobile/src/modules/mover/screens/EarningsScreen.tsx')).toContain('Swift only charges the flat weekly fee. No commission on orders.');
    // [S4-1] a passenger can pay the driver by MMG too (#1825): "paid in cash, on every job" was not true
    expect(read('apps/mobile/src/modules/mover/screens/MoverAccountScreen.tsx')).toContain(
      'Swift only charges a flat weekly fee — no commission on orders. You&apos;re paid directly by the customer: in cash, or into your own MMG account where you offer it.',
    );
  });

  const all = ROOTS.flatMap((r) => files(join(repo, r)));

  it('reads every app', () => {
    for (const r of ['apps/mobile/src', 'apps/web/src', 'apps/admin/src', 'apps/api/src']) {
      expect(all.filter((f) => relative(repo, f).startsWith(r)).length, r).toBeGreaterThan(10);
    }
  });

  it('no string, template or markup text in any app makes the forever promise', () => {
    const found: string[] = [];
    for (const f of all) {
      const code = readFileSync(f, 'utf8');
      if (!/commission/i.test(code)) continue;
      for (const w of words(f, code)) {
        if (FOREVER.test(w.text)) found.push(`${relative(repo, f)}:${w.line} ${JSON.stringify(w.text.trim().slice(0, 100))}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('the reader sees JSX text, template pieces and strings, never comments', () => {
    const got = words('probe.tsx', [
      '// a comment: no commission, ever',
      "const a = 'string, never commission';",
      'const b = `head ${x} tail, commission forever`;',
      'const c = <T>jsx no commission, ever</T>;',
    ].join('\n')).map((w) => w.text.trim());
    expect(got).toEqual(['string, never commission', 'head', 'tail, commission forever', 'jsx no commission, ever']);
  });

  it('the census catches each form of the promise (and leaves the Terms wording alone)', () => {
    for (const promise of [
      'no commission, ever', 'Zero commission — ever.', 'no commission on any fare, ever', 'Swift never takes a commission.',
      'a flat weekly fee, never commission.', 'never a commission taken from your earnings', 'commission-free forever', 'We will always be commission free',
    ]) expect(FOREVER.test(promise), promise).toBe(true);
    for (const honest of ['Swift charges Partners no commission on Orders.', 'No commission on orders.', 'Zero commission.', 'Swift takes no commission: 100% of every sale is yours.']) {
      expect(FOREVER.test(honest), honest).toBe(false);
    }
  });
});
