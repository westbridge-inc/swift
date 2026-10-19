import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// [BUG-GUARDS C3] A failed read is never shown as empty.
//
// query-error-census.test.ts proves every console read LOOKS at its error.
// It cannot see WHERE: Approvals printed the raw error and, right under it,
// "Nothing is waiting on a second signature." (the error was read, in a
// sibling branch). This census reads every .tsx file with the TypeScript
// parser and finds each empty-state message ("No ...", "Nothing ...",
// "Nobody ...", "... is empty"). A message that sits behind a data check
// (rows.length === 0, !data, an `empty=` prop) must ALSO sit behind a
// failure check: an ancestor condition that names the error/success
// (q.isError ? <QueryFailed/> : rows.length === 0 ? 'No ...' : ...), an
// early `if (q.isError) return`, a gate that needs the data to exist
// (q.data && q.data.rows.length === 0), or an element that receives the
// error itself (<DataTable error={q.error} empty="..."/>).
// It also refuses `.catch(() => setRows([]))`: a failure turned into empty.
// A new hit fails the suite; fix it, or list it below with the reason.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const EMPTY = /^(No |Nothing\b|Nobody\b|None\b|You (owe|have) nothing|All caught up|Your [a-z ]+ is empty|Empty\b)/i;
const FAILURE_AWARE = /error|Error|failed|Failed|unavailable|Unavailable|fetchStatus|isSuccess|status\s*===\s*['"](error|success)['"]/;
const DATA_GATE = /\.length\b|\bdata\b|rows|items|list|=== 0|isEmpty|empty|count|total/i;
/** A conjunct that only tests that the read's data exists (`q.data`, `data`, `vendorData`): the read succeeded. */
const dataPresent = (cond: string) => cond.split('&&').some((part) => /^\(?\s*[\w.?]*\b\w*(data|Data)\s*\)?$/.test(part.trim()));
const EMPTY_PROPS = /^(empty|emptyText|emptyLabel|emptyTitle|emptyMessage)$/;

/**
 * [REVIEW-F S3-1] The attribute a literal is the value of. Not only its direct
 * parent: `empty={f ? 'No x matches.' : 'No x yet.'}` (the form the list pages
 * use) puts a ConditionalExpression and a JsxExpression in between, and the
 * census used to see no empty prop there at all (caught only when the read
 * happened to be named like data). Walks up through `?:` (a branch, never the
 * condition), `(...)`, `{...}` and a `??` / `||` fallback.
 */
function attributeOf(n: ts.Node, sf: ts.SourceFile): ts.JsxAttribute | null {
  let child: ts.Node = n;
  for (let p: ts.Node | undefined = n.parent; p; child = p, p = p.parent) {
    if (ts.isJsxAttribute(p)) return p;
    const through = ts.isParenthesizedExpression(p) || ts.isJsxExpression(p)
      || (ts.isConditionalExpression(p) && p.condition !== child)
      || (ts.isBinaryExpression(p) && p.right === child && /^(\?\?|\|\|)$/.test(p.operatorToken.getText(sf)));
    if (!through) return null;
  }
  return null;
}

let examined = 0;

export interface Hit { file: string; line: number; kind: 'empty' | 'swallow'; text: string }
interface Cond { text: string; negated: boolean }

const isFn = (n: ts.Node) => ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);
function returns(st: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => { if (ts.isReturnStatement(n)) found = true; else if (!isFn(n)) ts.forEachChild(n, visit); };
  visit(st);
  return found;
}

/** Every condition that decides whether `node` renders, from the innermost out, up to the component. */
function governing(node: ts.Node, sf: ts.SourceFile): { conds: Cond[]; inRow: boolean; errorProp: boolean; component: string | null } {
  const conds: Cond[] = [];
  let inRow = false;
  let errorProp = false;
  let component: string | null = null;
  let cur: ts.Node = node;
  while (cur.parent) {
    const p: ts.Node = cur.parent;
    if (ts.isConditionalExpression(p)) {
      if (cur === p.whenTrue) conds.push({ text: p.condition.getText(sf), negated: false });
      if (cur === p.whenFalse) conds.push({ text: p.condition.getText(sf), negated: true });
    } else if (ts.isBinaryExpression(p) && cur === p.right) {
      const op = p.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) conds.push({ text: p.left.getText(sf), negated: false });
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) conds.push({ text: p.left.getText(sf), negated: true });
    } else if (ts.isIfStatement(p)) {
      if (cur === p.thenStatement) conds.push({ text: p.expression.getText(sf), negated: false });
      if (cur === p.elseStatement) conds.push({ text: p.expression.getText(sf), negated: true });
    } else if (ts.isBlock(p) || ts.isSourceFile(p)) {
      for (const st of p.statements) {
        if (st === cur) break;
        if (ts.isIfStatement(st) && returns(st.thenStatement)) conds.push({ text: st.expression.getText(sf), negated: true });
      }
    } else if (ts.isCallExpression(p) && /\.(map|flatMap)$/.test(p.expression.getText(sf))) {
      inRow = true;
    } else if (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) {
      for (const a of p.attributes.properties) {
        if (ts.isJsxAttribute(a) && /^(error|isError|failed|readError|loadError)$/.test(a.name.getText(sf))) errorProp = true;
      }
    } else if (ts.isJsxAttribute(p)) {
      const owner = p.parent.parent;
      for (const a of owner.attributes.properties) {
        if (ts.isJsxAttribute(a) && /^(error|isError|failed|readError|loadError)$/.test(a.name.getText(sf))) errorProp = true;
      }
    }
    if (isFn(p) && p.parent && (ts.isSourceFile(p.parent) || ts.isVariableDeclaration(p.parent) || ts.isExportAssignment(p.parent))) {
      const named = ts.isFunctionDeclaration(p) ? p.name : ts.isVariableDeclaration(p.parent) ? p.parent.name : undefined;
      component = named && ts.isIdentifier(named) ? named.text : null;
      break;
    }
    cur = p;
  }
  return { conds, inRow, errorProp, component };
}

/** A child component's empty state is honest when every place this file renders it is behind a failure check. */
function parentGuards(component: string, sf: ts.SourceFile): boolean {
  const uses: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === component) uses.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return uses.length > 0 && uses.every((u) => {
    const g = governing(u, sf);
    return g.errorProp || g.conds.some((c) => FAILURE_AWARE.test(c.text));
  });
}

/** The census for one source text (the self-test below drives it directly). */
export function scan(file: string, source: string): Hit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: Hit[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    let text: string | null = null;
    if (ts.isJsxText(n)) text = n.text.replace(/\s+/g, ' ').trim();
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text.trim();
    if (text && text.length >= 4 && EMPTY.test(text)) {
      const p = n.parent;
      const attr = attributeOf(n, sf);
      const notShown = ts.isImportDeclaration(p) || ts.isExportDeclaration(p)
        || (ts.isBinaryExpression(p) && /^(===|!==|==|!=)$/.test(p.operatorToken.getText(sf)))
        || (ts.isCallExpression(p) && /toast|Error|console|throw|track|log/.test(p.expression.getText(sf)))
        || (attr !== null && /^(key|id|aria-|placeholder|testID)/.test(attr.name.getText(sf)));
      if (!notShown) {
        const { conds, inRow, errorProp, component } = governing(n, sf);
        const asEmptyProp = attr !== null && EMPTY_PROPS.test(attr.name.getText(sf));
        const dataGated = asEmptyProp || conds.some((c) => DATA_GATE.test(c.text));
        const failureAware = errorProp || conds.some((c) => FAILURE_AWARE.test(c.text))
          || conds.some((c) => !c.negated && dataPresent(c.text))
          || conds.some((c) => c.negated && c.text.split('||').some((part) => /^!\s*[\w.?]*\b\w*(data|Data)$/.test(part.trim())));
        examined += 1;
        if (dataGated && !inRow && !failureAware && !(component && /^[A-Z]/.test(component) && parentGuards(component, sf))) hits.push({ file, line: lineOf(n), kind: 'empty', text });
      }
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'catch') {
      const handler = n.arguments[0];
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        const body = handler.body.getText(sf);
        const toEmpty = /\bset[A-Z]\w*\(\s*(\[\]|null|0|\{\s*\}|''|""|false)\s*\)/.test(body);
        const saysFailed = /\bset\w*(Error|Failed|Failure|Unavailable)\w*\(|\berror\b|toast/.test(body);
        if (toEmpty && !saysFailed) hits.push({ file, line: lineOf(n), kind: 'swallow', text: handler.getText(sf).replace(/\s+/g, ' ').slice(0, 60) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'test' || e.name === 'node_modules' ? [] : sources(p);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });
}

const keyOf = (h: Hit) => `${h.file} | ${h.text.slice(0, 48)}`;

/** Hits another lane is fixing right now: tolerated while present, never required. */
const PENDING_ELSEWHERE: Record<string, string> = {};

/** Reviewed: the message is true even when a read failed. Every entry must still match a real hit. */
const KNOWN: Record<string, string> = {};

const ALL = sources(SRC).flatMap((p) => scan(relative(SRC, p), readFileSync(p, 'utf8')));
const EXAMINED = examined;

describe('[BUG-GUARDS C3] a failed read is never shown as empty', () => {
  it('finds the console empty states (the census is not vacuous)', () => {
    expect(EXAMINED).toBeGreaterThanOrEqual(60);
  });

  it('every empty message sits behind a failure check (or is listed with its reason)', () => {
    const offenders = ALL.filter((h) => !KNOWN[keyOf(h)] && !PENDING_ELSEWHERE[keyOf(h)])
      .map((h) => `${h.file}:${h.line} [${h.kind}] "${h.text}" — a failed read would show this. Put the failure first (QueryFailed with retry), then the empty state.`);
    expect(offenders).toEqual([]);
  });

  it('every KNOWN entry names a real hit and says why', () => {
    for (const [key, reason] of Object.entries(KNOWN)) {
      expect(reason.trim().length, key).toBeGreaterThanOrEqual(20);
      expect(ALL.some((h) => keyOf(h) === key), `stale entry ${key}: the hit is gone, drop it`).toBe(true);
    }
    for (const lane of Object.values(PENDING_ELSEWHERE)) expect(lane).toMatch(/^UI-(SWEEP|FIX-WEB|FIX-ADMIN) U\d+$/);
  });

  it('bites: the shapes that lied are refused, the honest shapes pass', () => {
    const verdict = (src: string) => scan('x.tsx', src).map((h) => h.kind);
    // The Approvals shape: the error is shown in a SIBLING branch, the empty state still renders under it.
    expect(verdict(`function P(){ const { data, error, isLoading } = useQuery({}); const rows = data ?? [];
      return <div>{error && <p>{String(error)}</p>}{!isLoading && rows.length === 0 && <p>Nothing is waiting.</p>}</div>; }`)).toEqual(['empty']);
    // The Collections shape: a ternary on loading only.
    expect(verdict(`function P(){ const q = useQuery({}); const rows = q.data ?? [];
      return q.isLoading ? <p>Loading</p> : rows.length === 0 ? <p>Nobody in this list.</p> : <ul/>; }`)).toEqual(['empty']);
    // The empty prop on a table that never hears about the failure.
    expect(verdict(`function P(){ const q = useQuery({}); return <DataTable rows={q.data ?? []} empty="No stores yet." />; }`)).toEqual(['empty']);
    // A failure swallowed into an empty list.
    expect(verdict(`function P(){ useEffect(() => { load().then(setRows).catch(() => setRows([])); }, []); return null; }`)).toEqual(['swallow']);
    // Honest shapes.
    expect(verdict(`function P(){ const q = useQuery({}); const rows = q.data ?? [];
      return q.isError ? <QueryFailed/> : rows.length === 0 ? <p>No stores yet.</p> : <ul/>; }`)).toEqual([]);
    expect(verdict(`function P(){ const q = useQuery({}); if (q.isError) return <QueryFailed/>; const rows = q.data ?? [];
      if (rows.length === 0) return <p>No stores yet.</p>; return <ul/>; }`)).toEqual([]);
    expect(verdict(`function P(){ const q = useQuery({}); return <DataTable rows={q.data ?? []} error={q.error} empty="No stores yet." />; }`)).toEqual([]);
    // [REVIEW-F S3-1] An empty prop chosen by a ternary is still an empty prop, whatever the read is named.
    expect(verdict(`function P(){ const q = useQuery({}); const [f] = useState(''); return <DataTable rows={q.data ?? []} empty={f ? 'No stores match.' : 'No stores yet.'} />; }`)).toEqual(['empty', 'empty']);
    expect(verdict(`function P(){ const q = useQuery({}); const [f] = useState(''); return <DataTable rows={q.data ?? []} error={q.error} empty={f ? 'No stores match.' : 'No stores yet.'} />; }`)).toEqual([]);
    // ...and a literal chosen by a ternary under a placeholder is never an empty state.
    expect(verdict(`function P(){ const q = useQuery({}); return <input placeholder={q.data ? 'No filter' : 'None yet'} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const { data } = useQuery({}); return data && data.claims.length === 0 ? <p>No claims</p> : null; }`)).toEqual([]);
    expect(verdict(`function P(){ useEffect(() => { load().then(setRows).catch(() => { setRows([]); setLoadFailed(true); }); }, []); return null; }`)).toEqual([]);
    // A child table: honest only when the parent renders it behind the failure check.
    const child = `function T({ rows }){ return rows.length === 0 ? <p>No zones yet.</p> : <ul/>; }`;
    expect(verdict(`${child} function P(){ const q = useQuery({}); return <div>{q.error ? <p>failed</p> : null}<T rows={q.data ?? []} /></div>; }`)).toEqual(['empty']);
    expect(verdict(`${child} function P(){ const q = useQuery({}); return q.error ? <QueryFailed/> : <T rows={q.data ?? []} />; }`)).toEqual([]);
    // A row-level fallback inside a list is about that row, not the read.
    expect(verdict(`function P({ rows }){ return <ul>{rows.map((r) => <li>{r.items.length === 0 ? 'No items' : r.items.length}</li>)}</ul>; }`)).toEqual([]);
  });
});
