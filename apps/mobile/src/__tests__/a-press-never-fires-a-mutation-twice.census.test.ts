import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// [BUG-GUARDS C2] A press never fires the same mutation twice (phone).
//
// A double tap on the favourite heart sent two add/remove requests; the item
// thumbs could race two verdicts. The phone's main flows already hold the
// button while the request runs (PillButton loading/disabled); this census
// makes that the rule for every press.
// It reads every .ts/.tsx file with the TypeScript parser:
// 1. the mutation hooks: every `use…` function that returns useMutation(…)
//    (or another such hook);
// 2. in each file, each handle (`const x = useX()`, or a destructured
//    `{ mutate: send, isPending: sending }`) and each x.mutate(…) /
//    x.mutateAsync(…) / send(…) call;
// 3. the press behind the call: the inline handler of an `on…` prop, or a
//    named handler (const / function / useCallback) followed to the `on…`
//    props that use it (up to four hops);
// 4. the guard: an `on…` element whose disabled/loading/busy/… prop names
//    the request's pending state (x.isPending, a destructured isPending, or
//    a busy flag the handler sets to true), or a handler that returns early
//    / short-circuits on it (`if (x.isPending) return`, `!x.isPending &&
//    x.mutate()`, a ref lock `if (inFlight.current) return`).
// A button inside Alert.alert(…) is the system dialog (it closes on the
// first tap), so it is left out; an effect or a callback with no `on…` prop
// behind it is not a press and is not judged.
// A new hit fails the suite; fix it, or list it below with the reason.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const GUARD_PROP = /^(disabled|loading|busy|isLoading|pending|isPending|submitting|saving|working|inFlight|sending)$|[a-z](Loading|Busy|Pending|Saving|Submitting|Disabled|InFlight|Sending)$/;
const PENDING = /\.isPending\b|\bisPending\b|\.isLoading\b|\.status\s*===\s*['"]pending['"]/;
const MAX_HOPS = 4;

type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
const isFn = (n: ts.Node): n is Fn => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
const calleeName = (c: ts.CallExpression) => (ts.isIdentifier(c.expression) ? c.expression.text : null);

interface Hit { file: string; line: number; text: string }
interface Census { hits: Hit[]; calls: number; pressed: number; unresolved: string[] }

/** `use…` functions that hand back a mutation: `=> useMutation(…)`, or a top-level `return useMutation(…)`. */
function mutationHooks(sfs: ts.SourceFile[]): Set<string> {
  const hooks = new Set(['useMutation']);
  const bodies: Array<[string, Fn]> = [];
  for (const sf of sfs) {
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name && /^use[A-Z]/.test(n.name.text)) bodies.push([n.name.text, n]);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^use[A-Z]/.test(n.name.text) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) bodies.push([n.name.text, n.initializer]);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const returned = (fn: Fn): string[] => {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return ts.isCallExpression(fn.body) && calleeName(fn.body) ? [calleeName(fn.body)!] : [];
    return fn.body.statements.flatMap((st) => (ts.isReturnStatement(st) && st.expression && ts.isCallExpression(st.expression) && calleeName(st.expression) ? [calleeName(st.expression)!] : []));
  };
  /** A wrapper that hands back its own `{ …m, mutate, mutateAsync, isPending }` (the cart and checkout hooks). */
  const wraps = (fn: Fn): boolean => {
    if (!fn.body) return false;
    const outs = ts.isBlock(fn.body) ? fn.body.statements.flatMap((st) => (ts.isReturnStatement(st) && st.expression ? [st.expression] : [])) : [fn.body];
    return outs.some((e) => {
      let x: ts.Expression = e;
      while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x)) x = x.expression;
      return ts.isObjectLiteralExpression(x) && x.properties.some((pr) => pr.name !== undefined && /^(mutate|mutateAsync)$/.test(pr.name.getText()));
    });
  };
  for (const [name, fn] of bodies) if (wraps(fn)) hooks.add(name);
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, fn] of bodies) if (!hooks.has(name) && returned(fn).some((r) => hooks.has(r))) { hooks.add(name); changed = true; }
  }
  return hooks;
}

function scanFile(file: string, sf: ts.SourceFile, hooks: Set<string>, out: Census) {
  // Handles: `const x = useX()` -> calls x.mutate / x.mutateAsync, pending x.isPending.
  // Destructured: `const { mutate: send, isPending: sending } = useX()` -> calls send(…), pending `sending`.
  const handles = new Set<string>();
  const callNames = new Map<string, string>();
  const pendingNames = new Set<string>();
  const busyStates = new Map<string, string>(); // busy flag -> its setter
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer)) {
      const hook = calleeName(n.initializer);
      if (hook && hooks.has(hook)) {
        if (ts.isIdentifier(n.name)) handles.add(n.name.text);
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            const prop = (el.propertyName ?? el.name).getText();
            if (!ts.isIdentifier(el.name)) continue;
            if (prop === 'mutate' || prop === 'mutateAsync') callNames.set(el.name.text, hook);
            if (prop === 'isPending' || prop === 'isLoading' || prop === 'status') pendingNames.add(el.name.text);
          }
        }
      }
      if (hook === 'useState' && ts.isArrayBindingPattern(n.name)) {
        const [v, set] = n.name.elements;
        if (v && set && ts.isBindingElement(v) && ts.isBindingElement(set) && ts.isIdentifier(v.name) && ts.isIdentifier(set.name)) busyStates.set(v.name.text, set.name.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!handles.size && !callNames.size) return;

  /** A busy flag counts only when something sets it to a truthy value (`setBusy(true)`, `setPicking(kind)`). */
  const setTrue = new Set<string>();
  const FALSY = new Set([ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword]);
  const findSetters = (n: ts.Node) => {
    const arg = ts.isCallExpression(n) && ts.isIdentifier(n.expression) ? n.arguments[0] : undefined;
    if (arg && !FALSY.has(arg.kind) && !(ts.isIdentifier(arg) && arg.text === 'undefined') && !(ts.isNumericLiteral(arg) && arg.text === '0')
      && !(ts.isStringLiteral(arg) && arg.text === '') && !ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) setTrue.add((n as ts.CallExpression).expression.getText());
    ts.forEachChild(n, findSetters);
  };
  findSetters(sf);

  /** Does this expression name the request's pending state (through locals: `const busy = a.isPending || b.isPending`)? */
  const namesPending = (e: ts.Node, refsOk: boolean, depth = 0): boolean => {
    if (PENDING.test(e.getText()) || (refsOk && /\.current\b/.test(e.getText()))) return true;
    let found = false;
    const look = (n: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(n)) {
        if (pendingNames.has(n.text)) found = true;
        else if (busyStates.has(n.text) && setTrue.has(busyStates.get(n.text)!)) found = true;
        else if (depth < 2) {
          const init = localInit(n);
          if (init && namesPending(init, refsOk, depth + 1)) found = true;
        }
      }
      ts.forEachChild(n, look);
    };
    look(e);
    return found;
  };
  const localInit = (id: ts.Identifier): ts.Expression | undefined => {
    for (let at: ts.Node | undefined = id.parent; at; at = at.parent) {
      const statements = ts.isBlock(at) || ts.isSourceFile(at) ? at.statements : null;
      if (!statements) continue;
      for (const st of statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === id.text && d !== id.parent) return d.initializer;
      }
    }
    return undefined;
  };

  /** Inside `fn`, is `node` behind a check of the pending state: an early `if (…) return` before it, or an
   *  enclosing `&&` / `if` / ternary whose condition names it? */
  const guardedWithin = (node: ts.Node, fn: ts.Node): boolean => {
    for (let at: ts.Node = node; at !== fn && at.parent; at = at.parent) {
      const p = at.parent;
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.right === at && namesPending(p.left, true)) return true;
      if ((ts.isIfStatement(p) || ts.isConditionalExpression(p)) && (p as ts.IfStatement).expression !== at && (p as ts.ConditionalExpression).condition !== at) {
        const cond = ts.isIfStatement(p) ? p.expression : p.condition;
        if (namesPending(cond, true)) return true;
      }
      if (ts.isBlock(p)) {
        for (const st of p.statements) {
          if (st === at) break;
          if (ts.isIfStatement(st) && namesPending(st.expression, true) && exits(st.thenStatement)) return true;
        }
      }
    }
    return false;
  };
  const exits = (st: ts.Statement): boolean => ts.isReturnStatement(st) || ts.isThrowStatement(st) || (ts.isBlock(st) && st.statements.some((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s)));

  const enclosingFn = (n: ts.Node): Fn | undefined => {
    for (let at = n.parent; at; at = at.parent) if (isFn(at)) return at;
    return undefined;
  };
  /** The name a handler is known by: `const h = (…) => …`, `const h = useCallback((…) => …, [])`, `function h()`. */
  const nameOf = (fn: Fn): { name: string; decl: ts.Node } | null => {
    if (ts.isFunctionDeclaration(fn) && fn.name) return { name: fn.name.text, decl: fn };
    let at: ts.Node = fn.parent;
    if (ts.isCallExpression(at) && calleeName(at) === 'useCallback') at = at.parent;
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return { name: at.name.text, decl: at };
    return null;
  };
  const insideAlert = (n: ts.Node): boolean => {
    for (let at = n.parent; at && !ts.isSourceFile(at); at = at.parent) {
      if (ts.isCallExpression(at) && /^Alert\.alert$/.test(at.expression.getText())) return true;
    }
    return false;
  };
  const pressAttr = (n: ts.Node): ts.JsxAttribute | null => {
    const p = n.parent;
    if (p && ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent) && /^on[A-Z]/.test(p.parent.name.getText())) return p.parent;
    return null;
  };
  const elementGuarded = (attr: ts.JsxAttribute): boolean => {
    const props = attr.parent.properties;
    return props.some((pr) => ts.isJsxAttribute(pr) && GUARD_PROP.test(pr.name.getText()) && !!pr.initializer
      && ts.isJsxExpression(pr.initializer) && !!pr.initializer.expression && namesPending(pr.initializer.expression, false));
  };
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;

  /** Every press that reaches `node` (a mutation call, or a call of a handler that makes one), unguarded ones reported. */
  const follow = (node: ts.Node, label: string, hops: number, seen: Set<ts.Node>) => {
    if (insideAlert(node)) return; // the system dialog fires once
    const fn = enclosingFn(node);
    if (!fn || seen.has(fn)) return;
    seen.add(fn);
    if (guardedWithin(node, fn)) return;
    const attr = pressAttr(fn);
    if (attr) {
      out.pressed++;
      if (!elementGuarded(attr)) out.hits.push({ file, line: at(node), text: `${label} <- <${attr.parent.parent.tagName.getText()} ${attr.name.getText()}>` });
      return;
    }
    const named = nameOf(fn);
    if (!named || hops >= MAX_HOPS) { out.unresolved.push(`${file}:${at(node)} ${label}`); return; }
    const refs: ts.Identifier[] = [];
    const findRefs = (n: ts.Node) => {
      if (ts.isIdentifier(n) && n.text === named.name && n.parent !== named.decl && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) refs.push(n);
      ts.forEachChild(n, findRefs);
    };
    findRefs(sf);
    if (!refs.length) { out.unresolved.push(`${file}:${at(node)} ${label}`); return; }
    for (const ref of refs) {
      const direct = pressAttr(ref);
      if (direct) {
        out.pressed++;
        if (!elementGuarded(direct)) out.hits.push({ file, line: at(node), text: `${label} <- <${direct.parent.parent.tagName.getText()} ${direct.name.getText()}>` });
      } else {
        follow(ref, label, hops + 1, seen);
      }
    }
  };

  const calls = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      let label: string | null = null;
      if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && handles.has(c.expression.text) && (c.name.text === 'mutate' || c.name.text === 'mutateAsync')) label = `${c.expression.text}.${c.name.text}`;
      if (ts.isIdentifier(c) && callNames.has(c.text)) label = `${c.text}()`;
      if (label) {
        out.calls++;
        follow(n, label, 0, new Set());
      }
    }
    ts.forEachChild(n, calls);
  };
  calls(sf);
}

function census(files: Record<string, string>): Census {
  const sfs = Object.entries(files).map(([f, src]) => ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  const hooks = mutationHooks(sfs);
  const out: Census = { hits: [], calls: 0, pressed: 0, unresolved: [] };
  for (const sf of sfs) scanFile(sf.fileName, sf, hooks, out);
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', '__tests__', '__mocks__'].includes(e.name) ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !/\.(test|spec|census)\.|\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

const keyOf = (h: Hit) => `${h.file} | ${h.text}`;

/** Real hits another lane is fixing (tolerated while they remain; drop each once its PR lands). */
const PENDING_ELSEWHERE: Record<string, string> = {};

/** Reviewed: a second fire is harmless or impossible. Every entry must still match a real hit. */
const KNOWN: Record<string, string> = {
  'modules/cart/screens/CartScreen.tsx | setTip.mutate <- <Pressable onPress>': 'Choosing Pickup sets the tip to 0 (a value, not a toggle): a second identical request leaves the same state, and checkout submits zero itself.',
};

const RESULT = census(Object.fromEntries(sources(SRC).map((p) => [relative(SRC, p), readFileSync(p, 'utf8')])));

describe('[BUG-GUARDS C2] a press never fires the same mutation twice', () => {
  it('finds the mutations and the presses behind them (the census is not vacuous)', () => {
    expect(RESULT.calls).toBeGreaterThanOrEqual(100);
    expect(RESULT.pressed).toBeGreaterThanOrEqual(55);
  });

  it('every press that fires a mutation is held while it runs (or is listed with its reason)', () => {
    const offenders = RESULT.hits.filter((h) => !KNOWN[keyOf(h)] && !PENDING_ELSEWHERE[keyOf(h)])
      .map((h) => `${h.file}:${h.line} ${h.text} — a second tap fires it again. Hold the press while it runs (disabled/loading={x.isPending}) or return early when it is pending.`);
    expect(offenders).toEqual([]);
  });

  it('every KNOWN entry names a real hit and says why', () => {
    for (const [key, reason] of Object.entries(KNOWN)) {
      expect(reason.trim().length, key).toBeGreaterThanOrEqual(20);
      expect(RESULT.hits.some((h) => keyOf(h) === key), `stale entry ${key}: the hit is gone, drop it`).toBe(true);
    }
    for (const lane of Object.values(PENDING_ELSEWHERE)) expect(lane).toMatch(/^UI-(SWEEP|FIX-WEB|FIX-ADMIN) U\d+$/);
  });

  it('bites: the shapes that fired twice are refused, the held ones pass', () => {
    const hook = { 'hooks.ts': `export function useSave() { return useMutation({ mutationFn: save }); }\nexport const useSaveAgain = () => useSave();\nfunction useWrapped(fn) { const m = useMutation({ mutationFn: fn }); const mutate = (p) => m.mutate(p); return { ...m, mutate }; }\nexport function useAddToCart() { return useWrapped(add); }` };
    const verdict = (src: string) => census({ ...hook, 'x.tsx': src }).hits.map((h) => h.text);
    // The favourite heart: an inline handler, nothing holds it.
    expect(verdict(`function P(){ const fav = useSave(); return <Heart onPress={() => fav.mutate({ id: 1 })} />; }`)).toEqual(['fav.mutate <- <Heart onPress>']);
    // A named handler (and a hook that returns another hook), followed to its press.
    expect(verdict(`function P(){ const s = useSaveAgain(); const submit = () => { s.mutate(); }; return <PillButton label="Save" onPress={submit} />; }`)).toEqual(['s.mutate <- <PillButton onPress>']);
    expect(verdict(`function P(){ const s = useSave(); const submit = useCallback(() => s.mutateAsync(), [s]); return <Row onPress={() => submit()} />; }`)).toEqual(['s.mutateAsync <- <Row onPress>']);
    // A wrapper hook that hands back its own mutate (the cart hooks) is a mutation too.
    expect(verdict(`function P(){ const add = useAddToCart(); return <Plus onPress={() => add.mutate({ id: 1 })} />; }`)).toEqual(['add.mutate <- <Plus onPress>']);
    // A destructured mutate, and a disabled prop that does not name the request.
    expect(verdict(`function P({ valid }){ const { mutate: send } = useSave(); return <B disabled={!valid} onPress={() => send()} />; }`)).toEqual(['send() <- <B onPress>']);
    // Held: the element names the pending state (directly, destructured, via a local, a busy flag set true).
    expect(verdict(`function P(){ const s = useSave(); return <PillButton loading={s.isPending} onPress={() => s.mutate()} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const { mutate: send, isPending: sending } = useSave(); return <B disabled={sending} onPress={() => send()} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const a = useSave(); const b = useSave(); const busy = a.isPending || b.isPending; return <B disabled={busy} onPress={() => a.mutate()} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const s = useSave(); const [busy, setBusy] = useState(false); const go = async () => { setBusy(true); await s.mutateAsync(); setBusy(false); }; return <B disabled={busy} onPress={go} />; }`)).toEqual([]);
    // Held: the handler returns early or short-circuits (a ref lock counts here).
    expect(verdict(`function P(){ const s = useSave(); return <B onPress={() => !s.isPending && s.mutate()} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const s = useSave(); const go = () => { if (s.isPending) return; s.mutate(); }; return <B onPress={go} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const s = useSave(); const lock = useRef(false); const go = () => { if (lock.current) return; lock.current = true; s.mutate(); }; return <B onPress={go} />; }`)).toEqual([]);
    // A custom component's own pending prop, and a busy flag set to a non-boolean value, hold it too.
    expect(verdict(`function P(){ const s = useSave(); return <Tools onStatement={() => s.mutate()} statementLoading={s.isPending} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const s = useSave(); const [picking, setPicking] = useState(null); const pick = async (k) => { setPicking(k); await s.mutateAsync(k); setPicking(null); }; return <Row busy={picking === 'id'} onPress={() => pick('id')} />; }`)).toEqual([]);
    // A useState flag nobody sets to true is not a guard.
    expect(verdict(`function P(){ const s = useSave(); const [busy, setBusy] = useState(false); const done = () => setBusy(false); return <B disabled={busy} onPress={() => s.mutate(undefined, { onSettled: done })} />; }`)).toEqual(['s.mutate <- <B onPress>']);
    // Not a press: the system dialog's button, an effect.
    expect(verdict(`function P(){ const s = useSave(); return <B onPress={() => Alert.alert('Sure?', '', [{ text: 'Yes', onPress: () => s.mutate() }])} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const s = useSave(); const cancel = () => s.mutate(); return <B onPress={() => Alert.alert('Sure?', '', [{ text: 'Yes', onPress: cancel }])} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const s = useSave(); useEffect(() => { s.mutate(); }, []); return null; }`)).toEqual([]);
  });
});
