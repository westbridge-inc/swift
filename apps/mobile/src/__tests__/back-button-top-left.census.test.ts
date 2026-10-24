import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// [UI-SWEEP U-P2, owner 22 Oct] "Your activity" showed its Back in the TOP
// CENTRE. The back chip sat in a column; its 44pt touch box (kit touchTarget:
// minWidth + alignItems centre) stretched across the column and centred the
// chip, and the whole row became the Back target. Every other pushed screen
// has Back at the top LEFT.
//
// This census reads every screen with the TypeScript parser and finds every
// back control: a kit CircleChip with a back icon, or a Pressable /
// PressableScale / TouchableOpacity drawing a back chevron. Each one must
// sit at the top left:
//   - first in a row (flexDirection 'row', not centred or pushed right), or
//   - in a box pinned to the left (position absolute + left, no right), or
//   - itself pinned or aligned to the left, or in a column that aligns left;
// and a Pressable back must be at least 44pt on its own (touchTarget(), a
// 44pt box, or a labelled pill at least 44pt tall), not only through hitSlop
// (Android measures the control's own bounds). A new hit fails the suite:
// use the kit <Header />.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const BACK_ICONS = new Set(['chevron-left', 'arrow-left']);
const PRESSABLES = new Set(['Pressable', 'PressableScale', 'TouchableOpacity']);
const MIN_BACK_PT = 44;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(p);
    return e.name.endsWith('.tsx') && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });
}

const tagName = (el: ts.JsxOpeningLikeElement) => el.tagName.getText();
function attr(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return el.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}
function stringAttr(el: ts.JsxOpeningLikeElement, name: string): string | undefined {
  const init = attr(el, name)?.initializer;
  if (!init) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)) return init.expression.text;
  return undefined;
}

/** A style written in place, as { key: source text }. touchTarget(n) reads as its 48pt box. */
type Style = Map<string, string>;
function styleOf(expr: ts.Expression | undefined, into: Style = new Map()): Style {
  if (!expr) return into;
  if (ts.isParenthesizedExpression(expr)) return styleOf(expr.expression, into);
  if (ts.isArrayLiteralExpression(expr)) { expr.elements.forEach((e) => styleOf(e, into)); return into; }
  if (ts.isCallExpression(expr) && expr.expression.getText() === 'touchTarget') {
    into.set('minWidth', '48'); into.set('minHeight', '48'); into.set('touchTarget', expr.getText());
    return into;
  }
  if (ts.isObjectLiteralExpression(expr)) {
    for (const p of expr.properties) {
      if (ts.isPropertyAssignment(p)) into.set(p.name.getText(), p.initializer.getText());
      else if (ts.isSpreadAssignment(p)) styleOf(p.expression, into);
      else if (ts.isShorthandPropertyAssignment(p)) into.set(p.name.getText(), p.name.getText());
    }
  }
  return into;
}
function styleAttr(el: ts.JsxOpeningLikeElement): Style {
  const init = attr(el, 'style')?.initializer;
  return init && ts.isJsxExpression(init) ? styleOf(init.expression) : new Map();
}
const unquote = (v: string | undefined) => v?.replace(/^['"`]|['"`]$/g, '');
const num = (v: string | undefined) => (v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
const pinnedLeft = (s: Style) => unquote(s.get('position')) === 'absolute' && s.has('left') && !s.has('right');

type Back = { file: string; line: number; kind: 'chip' | 'press'; open: ts.JsxOpeningLikeElement; node: ts.Node };

function backControls(file: string, sf: ts.SourceFile): Back[] {
  const out: Back[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && tagName(n) === 'CircleChip' && BACK_ICONS.has(stringAttr(n, 'icon') ?? '')) {
      out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, kind: 'chip', open: n, node: ts.isJsxOpeningElement(n) ? n.parent : n });
    }
    if (ts.isJsxElement(n) && PRESSABLES.has(tagName(n.openingElement))) {
      let drawsBack = false;
      const find = (c: ts.Node) => {
        if (ts.isJsxSelfClosingElement(c) && tagName(c) === 'Feather' && BACK_ICONS.has(stringAttr(c, 'name') ?? '')) drawsBack = true;
        // A nested pressable is its own control.
        if (!(ts.isJsxElement(c) && PRESSABLES.has(tagName(c.openingElement)))) ts.forEachChild(c, find);
      };
      n.children.forEach(find);
      if (drawsBack) out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, kind: 'press', open: n.openingElement, node: n });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The element the back control is laid out in, or null when the control is what a component returns (its caller places it). */
function container(node: ts.Node): ts.JsxElement | null {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxElement(p)) return p;
    if (ts.isFunctionLike(p)) return null;
  }
  return null;
}
const meaningful = (c: ts.JsxChild) =>
  !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces) && !(ts.isJsxExpression(c) && !c.expression);

function placementProblem(b: Back): string | null {
  const own = styleAttr(b.open);
  if (pinnedLeft(own) || unquote(own.get('alignSelf')) === 'flex-start') return null;
  const box = container(b.node);
  if (!box) return null;
  const s = styleAttr(box.openingElement);
  if (pinnedLeft(s)) return null;
  const direction = unquote(s.get('flexDirection'));
  if (direction === 'row') {
    const justify = unquote(s.get('justifyContent'));
    if (justify && !['flex-start', 'space-between'].includes(justify)) return `in a row that places it ${justify}`;
    const first = box.children.find(meaningful);
    if (!first || first.pos > b.node.pos || first.end < b.node.end) return 'not first in its row';
    return null;
  }
  if (direction === undefined && unquote(s.get('alignItems')) === 'flex-start') return null;
  return `in a ${direction ?? 'column'} that stretches it across the screen (its touch box centres it)`;
}

function sizeProblem(b: Back): string | null {
  if (b.kind === 'chip') return null; // kit CircleChip: touchTarget(size), never under 48pt
  const own = styleAttr(b.open);
  const big = (s: Style) =>
    (num(s.get('minWidth')) ?? num(s.get('width')) ?? 0) >= MIN_BACK_PT && (num(s.get('minHeight')) ?? num(s.get('height')) ?? 0) >= MIN_BACK_PT;
  if (big(own)) return null;
  // A labelled pill ("‹ Swift"): its words make it wider than 44pt, so its height decides.
  let labelled = false;
  const words = (c: ts.Node) => {
    if ((ts.isJsxOpeningElement(c) || ts.isJsxSelfClosingElement(c)) && tagName(c) === 'T') labelled = true;
    ts.forEachChild(c, words);
  };
  (b.node as ts.JsxElement).children.forEach(words);
  // The drawn box inside the pressable (its first View) when it is 44pt or more.
  let inner = false;
  const look = (c: ts.Node) => {
    if (inner) return;
    if ((ts.isJsxOpeningElement(c) || ts.isJsxSelfClosingElement(c)) && tagName(c) === 'View') {
      const v = styleAttr(c);
      inner = big(v) || (labelled && (num(v.get('minHeight')) ?? num(v.get('height')) ?? 0) >= MIN_BACK_PT);
      return;
    }
    ts.forEachChild(c, look);
  };
  (b.node as ts.JsxElement).children.forEach(look);
  return inner ? null : `under ${MIN_BACK_PT}pt on its own (hitSlop does not count)`;
}

function census(files: Array<{ file: string; text: string }>): string[] {
  const hits: string[] = [];
  for (const { file, text } of files) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const b of backControls(file, sf)) {
      for (const problem of [placementProblem(b), sizeProblem(b)]) if (problem) hits.push(`${b.file}:${b.line} ${b.kind} back ${problem}`);
    }
  }
  return hits;
}

describe('[UI-SWEEP U-P2] every Back sits at the top left, 44pt or more', () => {
  const files = sources(SRC).map((f) => ({ file: f.slice(SRC.length + 1), text: readFileSync(f, 'utf8') }));

  it('the census finds the app’s back controls (guards the guard)', () => {
    const found = files.flatMap(({ file, text }) => backControls(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)));
    expect(found.filter((b) => b.kind === 'chip').length, 'kit back chips').toBeGreaterThan(5);
    expect(found.filter((b) => b.kind === 'press').length, 'pressable back chevrons').toBeGreaterThan(5);
    expect(found.some((b) => b.file === 'kit/screen.tsx'), 'the kit Header’s own Back').toBe(true);
  });

  it('no screen renders a centred or stretched Back, and none is under 44pt', () => {
    expect(census(files)).toEqual([]);
  });

  it('the census catches the old Your activity header, and passes the shapes the app uses', () => {
    const wrap = (jsx: string) => `export function S() { return (${jsx}); }`;
    const hits = (jsx: string) => census([{ file: 'virtual.tsx', text: wrap(jsx) }]);
    // The shape the owner saw: a back chip in a plain column.
    expect(hits(`<View style={{ paddingTop: 16 }}><CircleChip icon="chevron-left" label="Back" onPress={go} /><T>Title</T></View>`)).toHaveLength(1);
    // Pinned left and right without a row: stretched, so centred.
    expect(hits(`<View style={{ position: 'absolute', left: 16, right: 16 }}><CircleChip icon="chevron-left" label="Back" /></View>`)).toHaveLength(1);
    // A row that centres it, or one where it is not first.
    expect(hits(`<View style={{ flexDirection: 'row', justifyContent: 'center' }}><CircleChip icon="chevron-left" label="Back" /></View>`)).toHaveLength(1);
    expect(hits(`<View style={{ flexDirection: 'row' }}><T>Title</T><CircleChip icon="chevron-left" label="Back" /></View>`)).toHaveLength(1);
    // A 24pt glyph behind hitSlop only.
    expect(hits(`<View style={{ flexDirection: 'row' }}><Pressable onPress={go} hitSlop={10}><Feather name="arrow-left" size={22} /></Pressable></View>`)).toHaveLength(1);
    // The shapes that pass: the kit Header's row, a left-pinned box, touchTarget, a 44pt drawn box.
    expect(hits(`<View style={{ height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><CircleChip icon="chevron-left" label="Back" /><T>t</T></View>`)).toEqual([]);
    expect(hits(`<View style={{ position: 'absolute', top: 8, left: 24 }}><CircleChip icon="chevron-left" label="Go back" /></View>`)).toEqual([]);
    expect(hits(`<View style={{ flexDirection: 'row', gap: 8 }}><Pressable onPress={go} style={touchTarget(24)}><Feather name="chevron-left" size={24} /></Pressable><T>t</T></View>`)).toEqual([]);
    expect(hits(`<View style={{ flexDirection: 'row' }}><Pressable onPress={go}>{({ pressed }) => (<View style={{ width: 44, height: 44 }}><Feather name="chevron-left" /></View>)}</Pressable></View>`)).toEqual([]);
    expect(hits(`<View><Pressable onPress={go} style={{ ...touchTarget(24), alignSelf: 'flex-start' }}><Feather name="chevron-left" /></Pressable></View>`)).toEqual([]);
    expect(hits(`<View><Pressable onPress={go} style={{ alignSelf: 'flex-start' }}><View style={{ minHeight: 44 }}><Feather name="chevron-left" /><T>Swift</T></View></Pressable></View>`)).toEqual([]);
    // ...but a bare 44pt-tall strip with no words is not a 44pt target, and a column still stretches it.
    expect(hits(`<View style={{ flexDirection: 'row' }}><Pressable onPress={go}><View style={{ minHeight: 44 }}><Feather name="chevron-left" /></View></Pressable></View>`)).toHaveLength(1);
    expect(hits(`<View><Pressable onPress={go} style={touchTarget(24)}><Feather name="chevron-left" /></Pressable></View>`)).toHaveLength(1);
  });
});
