import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DRIVER_AGREEMENT, MARKETING_CONSENT, PRIVACY, TERMS, VENDOR_AGREEMENT } from '../modules/legal/legal.routes';
import { feeCoveredLine } from '../modules/billing/fee-notice-copy';

// [OWNER RULING 8 Oct, NO "WALLET" · legal] Swift holds no money for anyone, so
// nothing the server says to a person may call anything a "wallet", a "top up",
// a money "balance", "banked" money or "stored value". Weekly fees paid before
// they are due are "fee paid ahead"; a partner's MMG account is their "MMG
// account". Owner: "change wording everywhere to save me legal trouble".
//
// What the server says to people: error messages (AppError, validation
// messages), notifications and operations pages (anything with a title and a
// body), the reasons a fee notice quotes, the copy modules, and the legal
// documents. Log lines, metric help, SQL, ledger descriptions, event notes and
// code names (prepaidBalance, WALLET_CURRENCY_MISMATCH, /topup) are records
// and identifiers, not words on a screen; the internal names may stay.

const SRC = join(__dirname, '..');
const SKIP_DIRS = new Set(['__tests__', 'test', '__mocks__', 'node_modules', 'generated']);
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? (SKIP_DIRS.has(e.name) ? [] : files(join(dir, e.name)))
    : /\.ts$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !e.name.endsWith('.d.ts') ? [join(dir, e.name)] : []);
}

const STORED_MONEY_WORDS = /\bwallets?\b|\btop[\s-]?ups?\b|\bbalances?\b|\bbanked\b|\bstored[\s-]value\b/i;
/** Kept on purpose: the Terms' denial that Swift "offers no wallet or stored
 *  value" (the sentence is the protection), and "trial balance", the
 *  accountants' name for debits equalling credits. */
const KEPT = [/offers no wallet or stored value/gi, /\btrial balance\b/gi];
const CODE_SHAPED = /^(?:[a-z][A-Za-z0-9_.:\-/]*|[A-Z0-9_]+|(?:(?:GET|POST|PUT|PATCH|DELETE) )?\/[\w/:.-]*)$/;
const said = (text: string) => STORED_MONEY_WORDS.test(KEPT.reduce((t, kept) => t.replace(kept, ''), text));

/** Properties whose string value is shown to a person. */
const SHOWN_PROPS = new Set(['title', 'body', 'message', 'reason', 'required', 'hint', 'sentence', 'label', 'subtitle', 'headline', 'cta']);

function textsOf(node: ts.Node | undefined): string[] {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
  if (ts.isConditionalExpression(node)) return [...textsOf(node.whenTrue), ...textsOf(node.whenFalse)];
  if (ts.isBinaryExpression(node)) return [...textsOf(node.left), ...textsOf(node.right)];
  if (ts.isParenthesizedExpression(node)) return textsOf(node.expression);
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return textsOf(node.body);
  return [];
}

/** Every string the server can say to a person in one module. */
export function shownWords(fileName: string, code: string): { line: number; text: string }[] {
  const src = ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out: { line: number; text: string }[] = [];
  const keep = (node: ts.Node, texts: string[]) => {
    for (const raw of texts) {
      const text = raw.trim();
      if (!text || CODE_SHAPED.test(text) || !said(text)) continue;
      out.push({ line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1, text: text.slice(0, 160) });
    }
  };
  const copyModule = /(?:copy|refusals)\.ts$/.test(fileName);
  const visit = (node: ts.Node, inCopy: boolean) => {
    let copy = inCopy;
    if (ts.isNewExpression(node) && node.expression.getText(src) === 'AppError') keep(node, node.arguments?.slice(2).flatMap(textsOf) ?? []);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'refine') keep(node, node.arguments.slice(1).flatMap(textsOf));
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && SHOWN_PROPS.has(node.name.text)) keep(node, textsOf(node.initializer));
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /COPY|_LINE$|_WORDS$/.test(node.name.text)) copy = true;
    if (copy || copyModule) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) keep(node, textsOf(node));
    }
    ts.forEachChild(node, (child) => visit(child, copy));
  };
  visit(src, false);
  return out;
}

describe('the server never says stored-money words [owner ruling 8 Oct]', () => {
  it('no error message, notification, operations page, fee reason or copy module says them', () => {
    const list = files(SRC);
    expect(list.length).toBeGreaterThan(300);
    const hits = list.flatMap((file) => shownWords(file, readFileSync(file, 'utf8'))
      .map((hit) => `${relative(SRC, file)}:${hit.line} ${hit.text}`));
    expect([...new Set(hits)]).toEqual([]);
  }, 120_000);

  it('the legal documents say none of them (the Terms keep their denial of a wallet)', () => {
    for (const [name, text] of Object.entries({ TERMS, PRIVACY, DRIVER_AGREEMENT, VENDOR_AGREEMENT, MARKETING_CONSENT })) {
      expect(said(text), name).toBe(false);
    }
    expect(TERMS).toContain('offers no wallet or stored value');
    expect(PRIVACY).toContain('we do not collect card numbers or mobile-money credentials');
  });

  it('a fee the partner already paid ahead is "fee paid ahead", never a balance', () => {
    expect(feeCoveredLine(2100, 'GYD', { first: true })).toBe('Your fee paid ahead already covers your first weekly fee of GY$2,100.');
  });

  it('the detector sees the words where a person reads them — not in logs, SQL, records or code names', () => {
    const probe = (code: string) => shownWords('probe.ts', code).length > 0;
    expect(probe("throw new AppError(409, 'X', 'Wallet currency does not match');")).toBe(true);
    expect(probe("send({ title: 'Top-up received', body: `$${1} added to your subscription balance.` });")).toBe(true);
    expect(probe("const s = z.number().refine((n) => n > 0, 'A top-up must be more than zero');")).toBe(true);
    expect(probe("return { ok: false, reason: 'Insufficient prepaid balance' };")).toBe(true);
    expect(probe("export const ENFORCEMENT_COPY = { D: 'Your previous account has an outstanding balance.' };")).toBe(true);
    expect(probe("log().warn({ n }, '[M-08] top-up tails owed');")).toBe(false);
    expect(probe("await tx.billingEvent.create({ data: { type: 'PREPAID_TOPUP', note: 'late MMG approval banked' } });")).toBe(false);
    expect(probe("throw new AppError(409, 'WALLET_CURRENCY_MISMATCH', 'The fee paid ahead is in a different currency');")).toBe(false);
    expect(probe("app.post('/subscriptions/:id/topup', h);")).toBe(false);
  });
});
