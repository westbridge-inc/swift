import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// [BUG-GUARDS C4] Every pushed screen shows a way back, in every state.
//
// A store that was still loading, or whose read failed, replaced the whole
// screen with a spinner or an error and no Back (UI sweep U32: swipe or the
// hardware button were the only ways out, and iPhones have no button). This
// census reads the navigators with the TypeScript parser: every screen a
// stack PUSHES (not a stack's first screen, not a tab, not a nested
// navigator) is resolved to its component, and every `return` of that
// component that renders something must carry a way back:
//   - the kit <Header> (its Back chip), a <SubHeader> without hideBack,
//   - an `onBack=` / `onClose=` prop, or a goBack()/pop()/popToTop() call,
//   - or a component of this app that always renders one of those.
// A new hit fails the suite; add the Back, or list it below with the reason.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

/** In-memory files for the self-test below; the census itself reads the disk. */
const VIRTUAL = new Map<string, string>();
const exists = (p: string) => VIRTUAL.has(p) || (!p.startsWith('/virtual/') && existsSync(p));
const read = (p: string) => VIRTUAL.get(p) ?? readFileSync(p, 'utf8');

const parsed = new Map<string, ts.SourceFile>();
function sourceFile(path: string): ts.SourceFile {
  let sf = parsed.get(path);
  if (!sf) {
    sf = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    parsed.set(path, sf);
  }
  return sf;
}

function resolveModule(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) if (exists(c)) return c;
  return null;
}

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
const isFn = (n: ts.Node): n is Fn => ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);

/** Unwrap memo(...) / forwardRef(...) / React.memo(...) around a component. */
function unwrapComponent(init: ts.Expression | undefined): Fn | null {
  let e = init;
  while (e && ts.isCallExpression(e) && /(^|\.)(memo|forwardRef)$/.test(e.expression.getText())) e = e.arguments[0];
  while (e && ts.isParenthesizedExpression(e)) e = e.expression;
  return e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) ? e : null;
}

/** The function named `name` in `file`, following `export { X as Y }`, `export default X` and re-exports. */
function findComponent(file: string, name: string, depth = 0): { file: string; fn: Fn } | null {
  if (depth > 4) return null;
  const sf = sourceFile(file);
  let local = name;
  for (const st of sf.statements) {
    if (name === 'default' && ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) local = st.expression.text;
    if (name === 'default' && ts.isFunctionDeclaration(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return { file, fn: st };
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text !== name) continue;
        const orig = el.propertyName?.text ?? el.name.text;
        if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
          const target = resolveModule(file, st.moduleSpecifier.text);
          return target ? findComponent(target, orig, depth + 1) : null;
        }
        local = orig;
      }
    }
  }
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === local) return { file, fn: st };
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === local) {
          const fn = unwrapComponent(d.initializer);
          if (fn) return { file, fn };
        }
      }
    }
    if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier) && local !== name) {
      // `import { X } from './a'; export { X }` — follow the import.
      const bindings = st.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.name.text === local) {
            const target = resolveModule(file, st.moduleSpecifier.text);
            return target ? findComponent(target, el.propertyName?.text ?? el.name.text, depth + 1) : null;
          }
        }
      }
    }
  }
  return null;
}

/** Where the identifier `name`, used in `file`, is defined: an import, or a component of the same file. */
function resolveIdentifier(file: string, name: string): { file: string; fn: Fn } | null {
  const sf = sourceFile(file);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const target = resolveModule(file, st.moduleSpecifier.text);
    if (st.importClause.name?.text === name) return target ? findComponent(target, 'default') : null;
    const bindings = st.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (el.name.text === name) return target ? findComponent(target, el.propertyName?.text ?? el.name.text) : null;
      }
    }
  }
  return findComponent(file, name);
}

/** The return statements that belong to `fn` itself (not to functions nested in it). */
function ownReturns(fn: Fn): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isReturnStatement(n)) { if (n.expression) out.push(n.expression); return; }
    if (isFn(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n)) return;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
  return out;
}

const rendersNothing = (e: ts.Expression): boolean => {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined') || e.kind === ts.SyntaxKind.FalseKeyword;
};

/** goBack() on anything; pop/popTo/popToTop/replace/reset only on the navigation (a mutation's reset() is no exit). */
const BACK_CALL = /^goBack$/;
const NAV_EXIT = /^(pop|popToTop|popTo|replace|reset)$/;
const NAV_RECEIVER = /nav|Nav|CommonActions|StackActions/;
const BACK_PROP = /^(onBack|onClose)$/;

const memo = new Map<Fn, string[]>();
const at = (file: string, n: ts.Node) => `${relative(dirname(file).startsWith('/virtual/') ? '/virtual/src' : SRC, file)}:${sourceFile(file).getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
/** Every return of this component that renders something carries a way back. */
function alwaysBack(file: string, fn: Fn, depth: number): boolean {
  let failing = memo.get(fn);
  if (!failing) {
    memo.set(fn, ['(cycle)']); // a cycle is not a way back
    const rets = ownReturns(fn).filter((r) => !rendersNothing(r));
    failing = rets.length === 0 ? [at(file, fn)] : rets.filter((r) => !hasBack(file, fn, r, depth)).map((r) => at(file, r));
    memo.set(fn, failing);
  }
  return failing.length === 0;
}

/** The variable `name` declared in `fn` (`const header = <Header/>`), if any. */
function localInit(fn: Fn, name: string): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) { found = n.initializer; return; }
    if (n !== fn && isFn(n)) return;
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

/** A handler or prop value that leaves the screen (`onPress={() => navigation.goBack()}`, `navigation.replace(...)`). */
function callsBack(n: ts.Node): boolean {
  let found = false;
  const visit = (k: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(k)) {
      const callee = k.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
      if (BACK_CALL.test(name)) { found = true; return; }
      if (ts.isPropertyAccessExpression(callee) && NAV_EXIT.test(name) && NAV_RECEIVER.test(callee.expression.getText())) { found = true; return; }
    }
    ts.forEachChild(k, visit);
  };
  visit(n);
  return found;
}

/**
 * The rendered value `node` (returned by `fn` in `file`) ALWAYS shows a way back: `a ? X : Y` needs it
 * in both branches, `a && X` never guarantees it, an element carries it itself (a Back mark, a prop or
 * handler that goes back, an element prop that does) or in one of its children.
 */
function hasBack(file: string, fn: Fn, node: ts.Node, depth: number, seen: Set<string> = new Set()): boolean {
  const sf = sourceFile(file);
  const again = (n: ts.Node) => hasBack(file, fn, n, depth, seen);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return again(node.expression);
  if (ts.isConditionalExpression(node)) return again(node.whenTrue) && again(node.whenFalse);
  if (ts.isJsxExpression(node)) return node.expression ? again(node.expression) : false;
  if (ts.isJsxFragment(node)) return node.children.some(again);
  if (ts.isIdentifier(node)) {
    // {header} — a local element built earlier in the component.
    if (seen.has(node.text)) return false;
    const init = localInit(fn, node.text);
    return init !== null && !isFn(init) && hasBack(file, fn, init, depth, new Set([...seen, node.text]));
  }
  if (ts.isCallExpression(node)) {
    // {renderHeader()} — a render helper of this component or file.
    const callee = node.expression;
    if (!ts.isIdentifier(callee) || depth >= 3) return false;
    const local = localInit(fn, callee.text);
    const helper = local ? unwrapComponent(local) : findComponent(file, callee.text)?.fn;
    return helper ? alwaysBack(file, helper, depth + 1) : false;
  }
  const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
  if (!opening) return false;
  const tag = opening.tagName.getText(sf);
  const attrs = opening.attributes.properties.filter(ts.isJsxAttribute);
  if (tag === 'Header') return true;
  if (tag === 'SubHeader') {
    const hide = attrs.find((x) => x.name.getText(sf) === 'hideBack');
    if (!hide || hide.initializer?.getText(sf) === '{false}') return true;
  }
  for (const a of attrs) {
    if (BACK_PROP.test(a.name.getText(sf))) return true;
    if (a.initializer && callsBack(a.initializer)) return true;
    // header={<Header />}: an element handed down as a prop.
    if (a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression
      && (ts.isJsxElement(a.initializer.expression) || ts.isJsxSelfClosingElement(a.initializer.expression) || ts.isJsxFragment(a.initializer.expression))
      && again(a.initializer.expression)) return true;
  }
  if (/^[A-Z]/.test(tag) && !tag.includes('.') && depth < 3) {
    const target = resolveIdentifier(file, tag);
    if (target && alwaysBack(target.file, target.fn, depth + 1)) return true;
  }
  return ts.isJsxElement(node) && node.children.some(again);
}

/** A readable, line-free label for one return: the `if` that guards it, or "final return". */
function labelOf(ret: ts.Expression, fn: Fn): string {
  let cur: ts.Node = ret;
  while (cur.parent && cur.parent !== fn) {
    const p: ts.Node = cur.parent;
    if (ts.isIfStatement(p)) return `if (${p.expression.getText().replace(/\s+/g, ' ')})`;
    if (ts.isCaseClause(p)) return `case ${p.expression.getText()}`;
    cur = p;
  }
  return 'final return';
}

interface Pushed { screen: string; navigator: string; component: string }
interface Hit { file: string; line: number; component: string; label: string; screens: string[]; inner: string[] }

/** Every screen a stack pushes: not a stack's first slot, not a tab, not a nested navigator. */
function pushedScreens(files: string[], root: string): { pushed: Array<Pushed & { file: string; fn: Fn }>; unresolved: string[]; total: number } {
  const pushed: Array<Pushed & { file: string; fn: Fn }> = [];
  const unresolved: string[] = [];
  let total = 0;
  for (const path of files) {
    const text = read(path);
    if (!/create(NativeStack|Stack)Navigator/.test(text)) continue;
    const sf = sourceFile(path);
    const stacks = new Set<string>();
    const findStacks = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer)
        && /^create(NativeStack|Stack)Navigator$/.test(n.initializer.expression.getText(sf))) stacks.add(n.name.text);
      ts.forEachChild(n, findStacks);
    };
    findStacks(sf);
    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n) && stacks.has(n.openingElement.tagName.getText(sf).replace(/\.Navigator$/, '')) && n.openingElement.tagName.getText(sf).endsWith('.Navigator')) {
        const nav = n.openingElement.tagName.getText(sf).replace(/\.Navigator$/, '');
        const initial = n.openingElement.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'initialRouteName');
        const initialName = initial && ts.isJsxAttribute(initial) && initial.initializer && ts.isStringLiteral(initial.initializer) ? initial.initializer.text : null;
        // The screens a stack can open on: the first rendered child, through <Group>, fragments and
        // {cond ? <A/> : <B/>} / {cond && <A/>} (a child that may render nothing lets the next one be first).
        const isScreen = (c: ts.Node): c is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(c) && c.tagName.getText(sf) === `${nav}.Screen`;
        const firsts = (c: ts.Node): { first: ts.JsxSelfClosingElement[]; mayBeEmpty: boolean } => {
          if (isScreen(c)) return { first: [c], mayBeEmpty: false };
          if (ts.isParenthesizedExpression(c)) return firsts(c.expression);
          if (ts.isJsxExpression(c)) return c.expression ? firsts(c.expression) : { first: [], mayBeEmpty: true };
          if (ts.isJsxFragment(c) || (ts.isJsxElement(c) && c.openingElement.tagName.getText(sf) === `${nav}.Group`)) return firstsOfSeq(c.children);
          if (ts.isConditionalExpression(c)) {
            const t = firsts(c.whenTrue);
            const f = firsts(c.whenFalse);
            return { first: [...t.first, ...f.first], mayBeEmpty: t.mayBeEmpty || f.mayBeEmpty };
          }
          if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return { first: firsts(c.right).first, mayBeEmpty: true };
          if (ts.isJsxText(c) || c.kind === ts.SyntaxKind.NullKeyword || c.kind === ts.SyntaxKind.FalseKeyword) return { first: [], mayBeEmpty: true };
          return { first: [], mayBeEmpty: true };
        };
        const firstsOfSeq = (children: readonly ts.Node[]): { first: ts.JsxSelfClosingElement[]; mayBeEmpty: boolean } => {
          const first: ts.JsxSelfClosingElement[] = [];
          for (const c of children) {
            const r = firsts(c);
            first.push(...r.first);
            if (!r.mayBeEmpty) return { first, mayBeEmpty: false };
          }
          return { first, mayBeEmpty: true };
        };
        const roots = new Set(firstsOfSeq(n.children).first);
        const all: ts.JsxSelfClosingElement[] = [];
        const collect = (c: ts.Node) => { if (isScreen(c)) all.push(c); else ts.forEachChild(c, collect); };
        n.children.forEach(collect);
        for (const s of all) {
          {
            total += 1;
            const attrs = s.attributes.properties.filter(ts.isJsxAttribute);
            const nameAttr = attrs.find((a) => a.name.getText(sf) === 'name');
            const screen = nameAttr?.initializer && ts.isStringLiteral(nameAttr.initializer) ? nameAttr.initializer.text : '?';
            const isRoot = initialName ? screen === initialName : roots.has(s);
            if (isRoot) continue;
            const compAttr = attrs.find((a) => a.name.getText(sf) === 'component');
            const comp = compAttr?.initializer && ts.isJsxExpression(compAttr.initializer) && compAttr.initializer.expression && ts.isIdentifier(compAttr.initializer.expression)
              ? compAttr.initializer.expression.text : null;
            const where = `${relative(root, path)} ${nav}.Screen ${screen}`;
            if (!comp) { unresolved.push(`${where}: no component={Identifier}`); continue; }
            const target = resolveIdentifier(path, comp);
            if (!target) { unresolved.push(`${where}: ${comp} not found`); continue; }
            // A nested navigator: its own Screens are counted where it is defined.
            if (/\.Navigator\b/.test(target.fn.getText())) continue;
            pushed.push({ screen, navigator: relative(root, path), component: comp, file: target.file, fn: target.fn });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { pushed, unresolved, total };
}

function census(files: string[], root: string): { hits: Hit[]; examined: number; screens: number; total: number; unresolved: string[] } {
  const { pushed, unresolved, total } = pushedScreens(files, root);
  const byFn = new Map<Fn, { file: string; component: string; screens: string[] }>();
  for (const p of pushed) {
    const e = byFn.get(p.fn) ?? { file: p.file, component: p.component, screens: [] };
    e.screens.push(p.screen);
    byFn.set(p.fn, e);
  }
  const hits: Hit[] = [];
  let examined = 0;
  for (const [fn, e] of byFn) {
    for (const ret of ownReturns(fn)) {
      if (rendersNothing(ret)) continue;
      examined += 1;
      if (!hasBack(e.file, fn, ret, 0)) {
        // `return <TaxiBooking {...props} />`: name the states of the component it hands over to.
        let inner: string[] = [];
        let r: ts.Expression = ret;
        while (ts.isParenthesizedExpression(r)) r = r.expression;
        const opening = ts.isJsxSelfClosingElement(r) ? r : ts.isJsxElement(r) ? r.openingElement : null;
        const delegate = opening ? resolveIdentifier(e.file, opening.tagName.getText()) : null;
        if (delegate) inner = memo.get(delegate.fn) ?? [];
        hits.push({ file: relative(root, e.file), line: sourceFile(e.file).getLineAndCharacterOfPosition(ret.getStart()).line + 1, component: e.component, label: labelOf(ret, fn), screens: [...new Set(e.screens)], inner });
      }
    }
  }
  return { hits, examined, screens: byFn.size, total, unresolved };
}

const keyOf = (h: Hit) => `${h.file} | ${h.label.slice(0, 64)}`;

/** Hits another lane is fixing right now: tolerated while present, never required. */
const PENDING_ELSEWHERE: Record<string, string> = {
  'modules/shop/screens/RestaurantScreen.tsx | if (vendor.isLoading)': 'UI-SWEEP U32 (#1915)',
  'modules/shop/screens/RestaurantScreen.tsx | if (vendor.isError || !v)': 'UI-SWEEP U32 (#1915)',
  'modules/shop/screens/MenuItemScreen.tsx | if (vendor.isLoading)': 'UI-SWEEP U32 (#1915)',
  'modules/shop/screens/MenuItemScreen.tsx | if (vendor.isError || !item)': 'UI-SWEEP U32 (#1915)',
  'modules/orders/screens/DeliveryScreen.tsx | if (order.isLoading)': 'UI-SWEEP U32 (#1915)',
  'modules/orders/screens/DeliveryScreen.tsx | if (!o)': 'UI-SWEEP U32 (#1915)',
};

/** Reviewed: this state has no Back on purpose. Every entry must still match a real hit. */
const KNOWN: Record<string, string> = {};

const RESULT = census(sources(SRC), SRC);

describe('[BUG-GUARDS C4] every pushed screen shows a way back, in every state', () => {
  it('reads the navigators (the census is not vacuous)', () => {
    expect(RESULT.total).toBeGreaterThanOrEqual(70);
    expect(RESULT.screens).toBeGreaterThanOrEqual(50);
    expect(RESULT.examined).toBeGreaterThanOrEqual(RESULT.screens);
  });

  it('every pushed screen resolves to its component', () => {
    expect(RESULT.unresolved).toEqual([]);
  });

  it('every state of every pushed screen carries a way back (or is listed with its reason)', () => {
    const offenders = RESULT.hits.filter((h) => !KNOWN[keyOf(h)] && !PENDING_ELSEWHERE[keyOf(h)])
      .map((h) => `${h.file}:${h.line} ${h.component} (${h.screens.join(', ')}) — \`${h.label}\` renders with no way back${h.inner.length ? ` (inside: ${h.inner.join(', ')})` : ''}. Add the kit <Header /> (or onBack / goBack) to this state.`);
    expect(offenders).toEqual([]);
  });

  it('every KNOWN entry names a real hit and says why', () => {
    for (const [key, reason] of Object.entries(KNOWN)) {
      expect(reason.trim().length, key).toBeGreaterThanOrEqual(20);
      expect(RESULT.hits.some((h) => keyOf(h) === key), `stale entry ${key}: the hit is gone, drop it`).toBe(true);
    }
    for (const lane of Object.values(PENDING_ELSEWHERE)) expect(lane).toMatch(/^UI-SWEEP U\d+ \(#\d+\)$/);
  });

  it('bites: the shapes that stranded people are refused, the honest shapes pass', () => {
    const files: Record<string, string> = {
      'nav.tsx': `import { createNativeStackNavigator } from '@react-navigation/native-stack';
        import { Gate } from './Gate'; import { Home } from './Home'; import { A } from './A'; import { B } from './B';
        import { C } from './C'; import { D } from './D'; import { E } from './E'; import { F } from './F';
        import { G } from './G'; import { Nested } from './Nested';
        const Stack = createNativeStackNavigator();
        export function Nav({ gate }: any) {
          return (
            <Stack.Navigator>
              {gate ? <Stack.Screen name="Gate" component={Gate} /> : (<><Stack.Screen name="Home" component={Home} /><Stack.Screen name="A" component={A} /></>)}
              <Stack.Group><Stack.Screen name="B" component={B} /><Stack.Screen name="C" component={C} /></Stack.Group>
              <Stack.Screen name="D" component={D} /><Stack.Screen name="E" component={E} /><Stack.Screen name="F" component={F} />
              <Stack.Screen name="G" component={G} /><Stack.Screen name="Nested" component={Nested} />
            </Stack.Navigator>
          );
        }`,
      // The first screen of each gate branch is a root: no Back needed.
      'Gate.tsx': `export function Gate() { return <View><Text>Pick a role</Text></View>; }`,
      'Home.tsx': `export function Home() { return <View />; }`,
      // U32: the loading state replaced the screen with a spinner and no Back.
      'A.tsx': `export function A() { const q = useQ(); if (q.isLoading) return <Spinner />; return <View><Header /></View>; }`,
      // The Back sits in one branch only: the failure branch strands the person.
      'B.tsx': `export function B() { const q = useQ(); return <View>{q.isError ? <ErrorState /> : <Header />}</View>; }`,
      'C.tsx': `export function C() { const q = useQ(); return <View>{q.isError ? <Header title="x" /> : <Header />}{q.data && <Header />}</View>; }`,
      // A local component that goes back, handed in through a local element, counts in every state.
      'D.tsx': `function Top({ navigation }: any) { return <Pressable onPress={() => navigation.goBack()} />; }
        export function D({ navigation }: any) { const header = <Top navigation={navigation} />; if (useQ().isLoading) return <View>{header}<Spinner /></View>; return <View>{header}</View>; }`,
      // \`x && <Header/>\` never guarantees a Back; a SubHeader with hideBack is no Back.
      'E.tsx': `export function E() { const x = useX(); return <View>{x && <Header />}<SubHeader title="t" navigation={null} hideBack /></View>; }`,
      // navigation.replace leaves the screen; a mutation's reset() does not.
      'F.tsx': `export function F({ navigation }: any) { const m = useM(); if (m.done) return <Button onPress={() => navigation.replace('Home')} />; if (m.failed) return <Button onPress={() => m.reset()} />; return null; }`,
      // memo(...) and \`export { G }\` resolve.
      'G.tsx': `const G = memo(function G() { return <Wrapper><SubHeader title="t" navigation={null} /></Wrapper>; }); export { G };`,
      // A nested navigator: its own Screens are counted where it is defined.
      'Nested.tsx': `import { createNativeStackNavigator } from '@react-navigation/native-stack'; import { X } from './X';
        const Inner = createNativeStackNavigator();
        export function Nested() { return <Inner.Navigator><Inner.Screen name="X" component={X} /></Inner.Navigator>; }`,
      'X.tsx': `export function X() { return <View />; }`,
    };
    for (const [name, text] of Object.entries(files)) VIRTUAL.set(`/virtual/src/${name}`, text);
    const r = census(Object.keys(files).map((n) => `/virtual/src/${n}`), '/virtual/src');
    expect(r.unresolved).toEqual([]);
    expect(r.total).toBe(11);
    expect(r.hits.map(keyOf).sort()).toEqual(['A.tsx | if (q.isLoading)', 'B.tsx | final return', 'E.tsx | final return', 'F.tsx | if (m.failed)']);
  });
});
