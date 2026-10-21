import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// [BUG-GUARDS C5] The console speaks plain words first: a raw status code is
// never the only or the main text (admin console).
//
// Operators read raw codes as the whole label: "PENDING_REVIEW" in a status
// cell, "OFFENSIVE" as the report reason, "WAIVE_WEEK" as a history line. The
// rule (COORD, 21 Oct; Mission Control row 104): the console shows plain words
// first; a raw code may appear ONLY as a muted secondary detail next to them —
// <span className="muted">Code: {x.status}</span> — never as the only or
// primary text. (Web and phone never show a raw code at all: apps/web has
// that census, #1944.)
// This census reads every .tsx/.ts file with the TypeScript parser. It finds
// each value that is SHOWN — a JSX child, or a text prop (title, aria-label,
// label, placeholder, …) — and looks through `??`, `||`, `&&`, ternaries,
// template literals, string `+`, String() and toLowerCase()/toUpperCase()
// for a machine field: `x.status`, `x.kind`, `x.type`, `x.reason`,
// `x.memberRole`, `err.code`, … (or a local taken straight from one, like
// `const status = row.status`). A field right after the text "Code:" in the
// same element (or template) is the secondary detail and passes. It also
// refuses `.replace(/_/g, ' ')` / `.replaceAll('_', ' ')` anywhere: that is a
// code dressed up as words. A label map (STATUS_LABEL[x.status],
// statusLabel(x.status)) is the fix.
// A new hit fails the suite; fix it, or list it below with the reason.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
/** The console: a raw code may follow "Code:" as a secondary detail (web + phone: never). */
const ALLOW_SECONDARY_CODE = true;

// >>> C5 shared scanner: byte-identical in apps/web, apps/admin and the phone (checked once all are on main); the per-app rule
// (ALLOW_SECONDARY_CODE) sits above. Fix it once, copy it to both.
/** Field names that carry a machine value the server sends (PENDING_REVIEW, RIDER_EN_ROUTE_PICKUP, OWNER). */
const RAW_NAME = /^(status|state|kind|type|reason|role|outcome|decision|resolution|tier|method|errorCode|reasonCode|refusalCode|failureCode)$|[a-z](Status|State|Kind|Type|Reason|Role|Outcome|Decision|Resolution|Class|Method)$/;
/** `code` is a machine value only on an error or refusal (err.code = ORDER_NOT_FOUND); a promo code,
 *  a start code or a currency code is text the person is meant to read. */
const ERRORISH = /^e$|err|fail|refus|problem|result|response|outcome/i;
/** Props whose value is read as text. key, className, href, value, data-* … are not shown. */
const TEXT_PROP = /^(title|aria-label|accessibilityLabel|accessibilityHint|aria-description|alt|placeholder|label|description|subtitle|message|text|heading|caption|hint|empty|tooltip|badge)$/;
const PASS_THROUGH = new Set(['toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase', 'trim', 'toString']);

type Kind = 'raw' | 'dressed' | 'code-only';
/** Fields shown right after "Code:" (the console's secondary detail); they still need plain words next to them. */
const secondary = new WeakSet<ts.Node>();
interface Hit { file: string; line: number; kind: Kind; text: string }
let examined = 0;

const strip = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
  return x;
};
const snippet = (n: ts.Node) => n.getText().replace(/\s+/g, ' ').slice(0, 60);
const isFn = (n: ts.Node): n is ts.SignatureDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

/** Names bound by a destructuring pattern (`const { status, order: { kind } } = x`). */
function bindsName(name: ts.BindingName, id: string): boolean {
  if (ts.isIdentifier(name)) return name.text === id;
  return name.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, id));
}

/** Where a local comes from: a `const` initializer, a destructuring (taken straight off an object), or a
 *  parameter (unknown here: the caller decides, so it is not judged). */
function origin(id: ts.Identifier): { init?: ts.Expression; destructured?: true } | null {
  for (let at: ts.Node | undefined = id.parent; at; at = at.parent) {
    if (isFn(at) && at.parameters.some((p) => bindsName(p.name, id.text))) return null;
    const statements = ts.isBlock(at) || ts.isSourceFile(at) || ts.isCaseClause(at) || ts.isDefaultClause(at) ? at.statements : null;
    if (!statements) continue;
    for (const st of statements) {
      if (!ts.isVariableStatement(st) || st.getStart() > id.getStart()) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === id.text) return d.initializer ? { init: d.initializer } : null;
        if (!ts.isIdentifier(d.name) && bindsName(d.name, id.text)) return { destructured: true };
      }
    }
  }
  return null;
}

/** A machine field read straight off the data (or a local taken straight from one). */
function isRawField(e: ts.Expression, seen = new Set<ts.Node>()): boolean {
  if (ts.isPropertyAccessExpression(e) || (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))) {
    const name = ts.isPropertyAccessExpression(e) ? e.name.text : (e.argumentExpression as ts.StringLiteralLike).text;
    if (RAW_NAME.test(name)) return true;
    return name === 'code' && ERRORISH.test(e.expression.getText());
  }
  if (ts.isIdentifier(e) && RAW_NAME.test(e.text) && !seen.has(e)) {
    seen.add(e);
    const o = origin(e);
    if (!o) return false;
    if (o.destructured) return true;
    return rawLeaves(o.init!, false, seen).length > 0;
  }
  return false;
}

/** #1948 review S3-1: props a component in this file shows as text (`function Chip({ status }) { return
 *  <span>{status}</span>; }` -> `Chip.status`). Its call sites are judged instead: `<Chip status={d.status} />`. */
const textProps = new Set<string>();
function noteTextProp(id: ts.Identifier): void {
  for (let at: ts.Node | undefined = id.parent; at; at = at.parent) {
    if (!isFn(at)) continue;
    const first = at.parameters[0];
    if (!first || !ts.isObjectBindingPattern(first.name)) return;
    const el = first.name.elements.find((b) => ts.isIdentifier(b.name) && b.name.text === id.text);
    if (!el) return;
    const named = ts.isFunctionDeclaration(at) ? at.name : ts.isVariableDeclaration(at.parent) ? at.parent.name : undefined;
    if (named && ts.isIdentifier(named) && /^[A-Z]/.test(named.text)) textProps.add(`${named.text}.${(el.propertyName ?? el.name).getText()}`);
    return;
  }
}

/** The parts of a shown expression that end up as text, with the raw ones kept. `afterCodeLabel`: the
 *  text right before this part reads "Code:" (the console's secondary detail). */
function rawLeaves(e0: ts.Expression, afterCodeLabel: boolean, seen = new Set<ts.Node>()): ts.Expression[] {
  const e = strip(e0);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.PlusToken) {
      const left = rawLeaves(e.left, afterCodeLabel, seen);
      const leftText = ts.isStringLiteralLike(strip(e.left)) ? (strip(e.left) as ts.StringLiteralLike).text : '';
      return [...left, ...rawLeaves(e.right, op === ts.SyntaxKind.PlusToken ? /\bCode:\s*$/.test(leftText) : afterCodeLabel, seen)];
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return rawLeaves(e.right, afterCodeLabel, seen);
    return [];
  }
  if (ts.isConditionalExpression(e)) return [...rawLeaves(e.whenTrue, afterCodeLabel, seen), ...rawLeaves(e.whenFalse, afterCodeLabel, seen)];
  if (ts.isTemplateExpression(e)) {
    return e.templateSpans.flatMap((span, i) => {
      const before = i === 0 ? e.head.text : e.templateSpans[i - 1]!.literal.text;
      return rawLeaves(span.expression, /\bCode:\s*$/.test(before), seen);
    });
  }
  if (ts.isCallExpression(e)) {
    const callee = e.expression;
    if (ts.isPropertyAccessExpression(callee) && PASS_THROUGH.has(callee.name.text) && e.arguments.length === 0) return rawLeaves(callee.expression, afterCodeLabel, seen);
    if (ts.isIdentifier(callee) && callee.text === 'String' && e.arguments.length === 1) return rawLeaves(e.arguments[0]!, afterCodeLabel, seen);
    return [];
  }
  if (ts.isIdentifier(e)) noteTextProp(e);
  if (isRawField(e, seen)) {
    if (ALLOW_SECONDARY_CODE && afterCodeLabel) secondary.add(e);
    return [e];
  }
  return [];
}

/** `.replace(/_/g, ' ')`, `.replaceAll('_', ' ')`, `.split('_').join(' ')`: a code turned into fake words. */
function isDressing(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const [what, by] = call.arguments;
  // `/_/g`, `/_+/g`, and a class or alternation that takes the underscore too (`/[_-]/g`, `/[\s_]+/g`, `/_|-/g`).
  const pattern = what && ts.isRegularExpressionLiteral(what) ? /^\/(.*)\/[a-z]*$/.exec(what.text)?.[1] ?? '' : '';
  const underscore = what && ((pattern.includes('_') && /^[[\]_\-|+\\s]+$/.test(pattern)) || (ts.isStringLiteralLike(what) && what.text === '_'));
  if ((callee.name.text === 'replace' || callee.name.text === 'replaceAll') && underscore) return !!by && ts.isStringLiteralLike(by) && /^\s+$/.test(by.text);
  if (callee.name.text === 'join' && by === undefined && what && ts.isStringLiteralLike(what) && /^\s+$/.test(what.text)) {
    // `.split('_').join(' ')`, also through `.map(…)` / `.filter(…)` (`.split('_').map(capitalise).join(' ')`).
    let inner = callee.expression;
    while (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && /^(map|filter|slice)$/.test(inner.expression.name.text)) inner = inner.expression.expression;
    return ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === 'split'
      && !!inner.arguments[0] && ts.isStringLiteralLike(inner.arguments[0]) && inner.arguments[0].text === '_';
  }
  return false;
}

/** The text before a JSX child, in its parent element: "Code: {x.status}" is the console's secondary detail. */
function codeLabelBefore(child: ts.JsxExpression): boolean {
  const parent = child.parent;
  if (!ts.isJsxElement(parent) && !ts.isJsxFragment(parent)) return false;
  const kids = parent.children;
  for (let i = kids.indexOf(child) - 1; i >= 0; i--) {
    const k = kids[i]!;
    if (ts.isJsxText(k)) {
      if (k.containsOnlyTriviaWhiteSpaces) continue;
      return /\bCode:\s*$/.test(k.text);
    }
    if (ts.isJsxExpression(k) && k.expression && ts.isStringLiteralLike(strip(k.expression))) return /\bCode:\s*$/.test((strip(k.expression) as ts.StringLiteralLike).text);
    return false;
  }
  return false;
}

/** Inside a prop that is not read as text (className={TONE[x.status]}, key, href): not words. */
function inHiddenProp(n: ts.Node): boolean {
  for (let at = n.parent; at && !ts.isJsxElement(at) && !ts.isJsxFragment(at) && !isFn(at); at = at.parent) {
    if (ts.isJsxAttribute(at)) return !TEXT_PROP.test(at.name.getText());
  }
  return false;
}

/** The plain words for the same field next to its secondary "Code: X": a label map (LABEL[x.status]), a
 *  label function (statusLabel(x.status)) or a ternary on it that gives text, shown within the element
 *  around the code or up to two elements further out. Without them the code is the only label. */
function plainWordsNear(shown: ts.Node, leaf: ts.Expression): boolean {
  const field = leaf.getText();
  let scope: ts.Node = shown;
  let levels = 0;
  for (let at = shown.parent; at && levels < 3 && !isFn(at); at = at.parent) {
    if (ts.isJsxElement(at) || ts.isJsxFragment(at)) { scope = at; levels++; }
  }
  let found = false;
  const look = (n: ts.Node) => {
    if (found || n === leaf) return;
    const words = (ts.isElementAccessExpression(n) && n.argumentExpression.getText() === field)
      || (ts.isCallExpression(n) && !(ts.isPropertyAccessExpression(n.expression) && PASS_THROUGH.has(n.expression.name.text))
        && !(ts.isIdentifier(n.expression) && n.expression.text === 'String') && n.arguments.some((a) => a.getText() === field))
      || (ts.isConditionalExpression(n) && n.condition.getText().includes(field) && ts.isStringLiteralLike(strip(n.whenTrue)));
    if (words && !inHiddenProp(n)) { found = true; return; }
    ts.forEachChild(n, look);
  };
  look(scope);
  return found;
}

function scan(file: string, src: string): Hit[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: Hit[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isJsxExpression(node) && node.expression) {
      const p = node.parent;
      const shownChild = ts.isJsxElement(p) || ts.isJsxFragment(p);
      const shownProp = ts.isJsxAttribute(p) && TEXT_PROP.test(p.name.getText());
      if (shownChild || shownProp) {
        examined++;
        for (const leaf of rawLeaves(node.expression, shownChild && codeLabelBefore(node))) {
          if (secondary.has(leaf) && plainWordsNear(node, leaf)) continue;
          hits.push({ file, line: at(leaf), kind: secondary.has(leaf) ? 'code-only' : 'raw', text: snippet(leaf) });
        }
      }
    }
    if (ts.isCallExpression(node) && isDressing(node)) hits.push({ file, line: at(node), kind: 'dressed', text: snippet(node) });
    ts.forEachChild(node, visit);
  };
  textProps.clear();
  visit(sf);
  // The call sites of a component that shows a prop as text: that prop's value is shown.
  const callSites = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
      for (const a of node.attributes.properties) {
        if (!ts.isJsxAttribute(a) || TEXT_PROP.test(a.name.getText()) || !textProps.has(`${node.tagName.getText()}.${a.name.getText()}`)) continue;
        if (!a.initializer || !ts.isJsxExpression(a.initializer) || !a.initializer.expression) continue;
        examined++;
        for (const leaf of rawLeaves(a.initializer.expression, false)) hits.push({ file, line: at(leaf), kind: 'raw', text: snippet(leaf) });
      }
    }
    ts.forEachChild(node, callSites);
  };
  callSites(sf);
  return hits;
}

// <<< C5 shared scanner

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__tests__' ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !/\.(test|spec|census)\.|\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

const keyOf = (h: Hit) => `${h.file} | ${h.text}`;

/** Real hits another lane is fixing (tolerated while they remain; drop each once its PR lands). */
const PENDING_ELSEWHERE: Record<string, string> = {
};

/** Real hits in pages that UI-FIX-ADMIN's open PR-A1 (#1942) rewrites. BUG-GUARDS fixes (or reviews) each one on
 *  top of #1942 once it merges, so the two never fight over the same lines. Tolerated while they remain. */
const AFTER_1942: Record<string, string> = {
  'app/custody/page.tsx | k.order?.paymentMethod': 'BUG-GUARDS C5 admin, after #1942',
  'app/finance/page.tsx | m.method': 'BUG-GUARDS C5 admin, after #1942',
  'app/orders/[id]/page.tsx | o.rideClass': 'BUG-GUARDS C5 admin, after #1942',
  "app/payment-confirmations/page.tsx | code.split('_').filter(Boolean).map((word, i) => (ACRONYMS.h": 'BUG-GUARDS C5 admin, after #1942',
  "app/ads/page.tsx | s.replace('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  "app/ads/page.tsx | status.replace('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  'app/ads/page.tsx | a.statusReason': 'BUG-GUARDS C5 admin, after #1942',
  "app/ads/page.tsx | r.replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  'app/approvals/page.tsx | row.status': 'BUG-GUARDS C5 admin, after #1942',
  'app/approvals/page.tsx | row.reason': 'BUG-GUARDS C5 admin, after #1942',
  "app/cash/page.tsx | row.channel.replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  "app/cash/page.tsx | row['type']": 'BUG-GUARDS C5 admin, after #1942',
  "app/cash/page.tsx | row['status']": 'BUG-GUARDS C5 admin, after #1942',
  "app/cash/page.tsx | o.replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  "app/cash/page.tsx | b['status']": 'BUG-GUARDS C5 admin, after #1942',
  'app/claims/page.tsx | e.kind': 'BUG-GUARDS C5 admin, after #1942',
  "app/claims/page.tsx | f.replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  "app/claims/page.tsx | filter.replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  "app/claims/page.tsx | String(c.reason).replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  "app/claims/page.tsx | it.key.replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  "app/compliance/page.tsx | String(v.reason).replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  'app/compliance/page.tsx | v.moverKind': 'BUG-GUARDS C5 admin, after #1942',
  "app/compliance/page.tsx | String(v.actionTaken).replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  'app/config/page.tsx | status': 'BUG-GUARDS C5 admin, after #1942',
  "app/custody/page.tsx | s.toLowerCase().replace(/_/g, ' ')": 'BUG-GUARDS C5 admin, after #1942',
  'app/discovery/page.tsx | c.kind': 'BUG-GUARDS C5 admin, after #1942',
  "app/integrity/page.tsx | f.outcome.replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  'app/integrity/page.tsx | f.subjectType': 'BUG-GUARDS C5 admin, after #1942',
  'app/jobs/page.tsx | row.failedReason': 'BUG-GUARDS C5 admin, after #1942',
  'app/mmg-payments/page.tsx | d.reason': 'BUG-GUARDS C5 admin, after #1942',
  'app/mmg-payments/page.tsx | e.transactionStatus': 'BUG-GUARDS C5 admin, after #1942',
  'app/mmg-payments/page.tsx | r.heldReason': 'BUG-GUARDS C5 admin, after #1942',
  'app/mmg-payments/page.tsx | r.resolution': 'BUG-GUARDS C5 admin, after #1942',
  'app/moderation/page.tsx | status': 'BUG-GUARDS C5 admin, after #1942',
  'app/moderation/page.tsx | r.reason': 'BUG-GUARDS C5 admin, after #1942',
  'app/moderation/page.tsx | r.targetType': 'BUG-GUARDS C5 admin, after #1942',
  'app/moderation/page.tsx | r.status': 'BUG-GUARDS C5 admin, after #1942',
  'app/orders/[id]/page.tsx | o.status': 'BUG-GUARDS C5 admin, after #1942',
  "app/orders/[id]/page.tsx | String(o.orderType).replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  "app/orders/[id]/page.tsx | String(ev.status).replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  'app/orders/[id]/page.tsx | o.cancellationReason': 'BUG-GUARDS C5 admin, after #1942',
  'app/promos/page.tsx | promo.discountType': 'BUG-GUARDS C5 admin, after #1942',
  'app/returns/page.tsx | r.reason': 'BUG-GUARDS C5 admin, after #1942',
  "app/subscriptions/page.tsx | String(e.kind ?? '').replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  "app/subscriptions/page.tsx | f.replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  'app/subscriptions/page.tsx | h.kind': 'BUG-GUARDS C5 admin, after #1942',
  "app/support/page.tsx | f.replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  "app/support/page.tsx | filter.replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  "app/support/page.tsx | String(t.category).replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  "app/support/page.tsx | String(t.resolution).replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
  'components/dashboard/LiveOrderFeed.tsx | order.status': 'BUG-GUARDS C5 admin, after #1942',
  "components/detail.tsx | value.replaceAll('_', ' ')": 'BUG-GUARDS C5 admin, after #1942',
};

/** Reviewed: the value is already words a person is meant to read. Every entry must still match a real hit. */
const KNOWN: Record<string, string> = {
  "lib/approvals.ts | segment .replace(/[-_]/g, ' ')": 'describeAction(): the approval queue names the admin ROUTE being approved from its path segments ("Change: Billing → Agent Payments → Refund Flag", pinned in approvals.test.ts), not a status code.',
  "lib/labels.ts | value.toLowerCase().replaceAll('_', ' ')": 'The floor of label(): it runs only for a value ENUM_LABELS has not been taught yet; labels.test.ts keeps it unreachable for every enum listed there.',
  "components/mc/ActivationChecklist.tsx | docType.replaceAll('_', ' ')": 'Fallback after docLabel() for a document type it does not know: document names are nouns (road_service_licence -> "Road service licence"), not a status code.',
};

const ALL = sources(SRC).flatMap((p) => scan(relative(SRC, p), readFileSync(p, 'utf8')));
const EXAMINED = examined;

describe('[BUG-GUARDS C5] the console never shows a raw code as the label', () => {
  it('reads the shown text of the console (the census is not vacuous)', () => {
    expect(EXAMINED).toBeGreaterThanOrEqual(1300);
  });

  it('no raw code is shown, and no code is dressed up as words (or it is listed with its reason)', () => {
    const offenders = ALL.filter((h) => !KNOWN[keyOf(h)] && !PENDING_ELSEWHERE[keyOf(h)] && !AFTER_1942[keyOf(h)])
      .map((h) => `${h.file}:${h.line} [${h.kind}] ${h.text} — an operator would read the machine code as the label. Show plain words first (a label map); keep the code, if useful, as a muted "Code: X" next to them.`);
    expect(offenders).toEqual([]);
  });

  it('every KNOWN entry names a real hit and says why', () => {
    for (const [key, reason] of Object.entries(KNOWN)) {
      expect(reason.trim().length, key).toBeGreaterThanOrEqual(20);
      expect(ALL.some((h) => keyOf(h) === key), `stale entry ${key}: the hit is gone, drop it`).toBe(true);
    }
    for (const lane of Object.values(PENDING_ELSEWHERE)) expect(lane).toMatch(/^UI-(SWEEP|FIX-WEB|FIX-ADMIN) U\d+$/);
    for (const lane of Object.values(AFTER_1942)) expect(lane).toBe('BUG-GUARDS C5 admin, after #1942');
  });

  it('bites: the shapes that showed codes are refused, label maps pass', () => {
    const verdict = (src: string) => scan('x.tsx', src).map((h) => `${h.kind}:${h.text}`);
    // Settings: the subscription's raw status inside the bold label.
    expect(verdict(`function P({ s }){ return <p>Status: <b className={s.status === 'ACTIVE' ? 'g' : 'r'}>{s.status}</b></p>; }`)).toEqual(['raw:s.status']);
    // A local taken straight from the data, with a default.
    expect(verdict(`function P({ sub }){ const status = String(sub['status'] ?? 'NONE'); return <b>{status}</b>; }`)).toEqual(['raw:status']);
    expect(verdict(`function P({ sub }){ const { status } = sub; return <b>{status}</b>; }`)).toEqual(['raw:status']);
    // The order page: a code dressed up as words, inline or in a helper.
    expect(verdict(`function P({ o }){ return <span>{o.status.replaceAll('_', ' ').toLowerCase()}</span>; }`)).toEqual(["dressed:o.status.replaceAll('_', ' ')"]);
    expect(verdict(`const words = (s: string) => s.toLowerCase().replace(/_/g, ' ');`)).toEqual(["dressed:s.toLowerCase().replace(/_/g, ' ')"]);
    expect(verdict(`const words = (s: string) => s.split('_').join(' ');`)).toEqual(["dressed:s.split('_').join(' ')"]);
    // Through fallbacks, ternaries, templates, text props and case changes.
    expect(verdict(`function P({ c }){ return <p>{LABEL[c.status] ?? c.status}</p>; }`)).toEqual(['raw:c.status']);
    expect(verdict(`function P({ c }){ return <p>{c ? c.memberRole.toUpperCase() : 'None'}</p>; }`)).toEqual(['raw:c.memberRole']);
    expect(verdict(`function P({ c }){ return <Pill label={\`Now \${c.kind}\`} />; }`)).toEqual(['raw:c.kind']);
    expect(verdict(`function P({ e }){ return <p>{e && 'Failed: ' + e.code}</p>; }`)).toEqual(['raw:e.code']);
    // The console's rule: the code may follow "Code:" as a secondary detail, never stand alone.
    expect(verdict(`function P({ r }){ return <p>{label(r.status)} <small className="muted">Code: {r.status}</small></p>; }`)).toEqual([]);
    expect(verdict(`function P({ r }){ return <p title={\`\${label(r.status)} · Code: \${r.status}\`}>{label(r.status)}</p>; }`)).toEqual([]);
    expect(verdict(`function P({ r }){ return <p>{label(r.status)} <small className="muted">{r.status}</small></p>; }`)).toEqual(['raw:r.status']);
    expect(verdict(`function P({ r }){ return <p><small>Code:</small> {r.status}</p>; }`)).toEqual(['raw:r.status']);
    // "Code: X" with no plain words for it is still the only label; a tone map in className is not words.
    expect(verdict(`function P({ r }){ return <td><small className="muted">Code: {r.status}</small></td>; }`)).toEqual(['code-only:r.status']);
    expect(verdict(`function P({ r }){ return <td className={TONE[r.status]}><small className="muted">Code: {r.status}</small></td>; }`)).toEqual(['code-only:r.status']);
    expect(verdict(`function P({ r }){ return <td>{r.status === 'LIVE' ? 'Live now' : 'Not live'} <small className="muted">Code: {r.status}</small></td>; }`)).toEqual([]);
    // [#1948 review S3-1] Payment method and ride class are codes too; a dressing through map/filter is still dressing.
    expect(verdict(`function P({ o }){ return <p>Payment: {o.paymentMethod} · Class: {o.rideClass} · {METHOD[o.method] ?? o.method}</p>; }`)).toEqual(['raw:o.paymentMethod', 'raw:o.rideClass', 'raw:o.method']);
    expect(verdict(`const words = (c: string) => c.split('_').filter(Boolean).map((w) => w[0] + w.slice(1).toLowerCase()).join(' ');`)).toEqual(["dressed:c.split('_').filter(Boolean).map((w) => w[0] + w.slice(1).to"]);
    // A character class or alternation that takes the underscore is the same dressing; a dash alone is not.
    expect(verdict(`const words = (s: string) => s.replace(/[_-]/g, ' ');`)).toEqual(["dressed:s.replace(/[_-]/g, ' ')"]);
    expect(verdict(`const words = (s: string) => s.replace(/-/g, ' ');`)).toEqual([]);
    // [#1948 review S3-1] A component that shows a prop as text is judged at its call sites.
    expect(verdict(`function Chip({ status }: { status: string }) { return <span className={status}>{status}</span>; }
      function P({ d }){ return <div><Chip status={d.status} /><Chip status={label(d.status)} /></div>; }`)).toEqual(['raw:d.status']);
    expect(verdict(`function Chip({ status }: { status: string }) { return <span>{label(status)}</span>; } function P({ d }){ return <Chip status={d.status} />; }`)).toEqual([]);
    // Honest shapes: label maps, comparisons, keys/classes, a promo code, a component that maps.
    expect(verdict(`function P({ s }){ return <b className={s.status === 'ACTIVE' ? 'g' : 'r'}>{STATUS_LABEL[s.status]}</b>; }`)).toEqual([]);
    expect(verdict(`function P({ s }){ return <b>{statusLabel(s.status)}</b>; }`)).toEqual([]);
    expect(verdict(`function P({ s }){ return <b>{s.status === 'TRIAL' ? 'Free trial' : 'Active'}</b>; }`)).toEqual([]);
    expect(verdict(`function P({ rows }){ return <ul>{rows.map((e, i) => <li key={\`\${e.status}-\${i}\`} data-state={e.state}>{e.label}</li>)}</ul>; }`)).toEqual([]);
    expect(verdict(`function P({ p }){ return <p>Use code {p.code}</p>; }`)).toEqual([]);
    expect(verdict(`function P({ c }){ return <StatusPill status={c.status} />; }`)).toEqual([]);
    expect(verdict(`function P({ c }){ const status = statusLabel(c.status); return <b>{status}</b>; }`)).toEqual([]);
    // A prop is the caller's business (judged where the caller shows it), not guessed here.
    expect(verdict(`function P({ kind }: { kind: 'Vendor' | 'Driver' }){ return <a>{kind} Partner Agreement</a>; }`)).toEqual([]);
  });
});
