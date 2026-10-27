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
//    In a list, `holdRow(key, () => x.mutateAsync(…))` (lib/useRowHold) holds
//    only the SAME row: one shared isPending silently dropped a tap on a
//    DIFFERENT row (#1952 review S3-2).
// A button inside Alert.alert(…) is the system dialog (it closes on the
// first tap), so it is left out; an effect is not a press. A handler handed
// to a call (`guardAuth(() => s.mutate())`) is followed to that call, and a
// ternary branch of an `on…` prop is that prop's handler.
// A new hit fails the suite; fix it, or list it below with the reason. A call
// the scanner cannot trace to a press (an object `onPress:`, a handler kept in
// a ref) fails too, unless UNTRACED lists it with the reason it is safe.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
// >>> C2 shared scanner: byte-identical in apps/mobile and apps/web (the census checks it). Fix it once, copy it to both.
const GUARD_PROP = /^(disabled|loading|busy|isLoading|pending|isPending|submitting|saving|working|inFlight|sending|cancelling|deleting|removing|adding)$|[a-z](Loading|Busy|Pending|Saving|Submitting|Disabled|InFlight|Sending|Cancelling|Deleting|Removing|Adding)$/;
/** …or [#1936] TanStack's per-row hold: the pending mutations read back with useMutationState filtered on
 *  status 'pending' (`const pending = new Set(useMutationState({ filters: { mutationKey, status: 'pending' }, … }))`,
 *  `disabled={pending.has(row.id)}`): only the row whose request is running waits. */
const PENDING = /\.isPending\b|\bisPending\b|\.isLoading\b|\.status\s*===\s*['"]pending['"]|\bisMutating\(|\buseIsMutating\(|\buseMutationState\(\s*\{[\s\S]*?\bstatus:\s*['"]pending['"]/;
const MAX_HOPS = 4;
/** A function handed to one of these runs on its own (not a press). */
const EFFECT = /^(useEffect|useLayoutEffect|useInsertionEffect|useFocusEffect)$/;
/** The per-row hold (`const holdRow = useRowHold(); holdRow(key, () => x.mutateAsync(…))`): only the SAME row waits. */
const ROW_HOLD = 'useRowHold';

type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
const isFn = (n: ts.Node): n is Fn => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
/** `useX(…)`, or `React.useX(…)` (MenuItemScreen's React.useCallback / React.useEffect). */
const calleeName = (c: ts.CallExpression) => (ts.isIdentifier(c.expression) ? c.expression.text
  : ts.isPropertyAccessExpression(c.expression) && c.expression.expression.getText() === 'React' ? c.expression.name.text : null);

interface Hit { file: string; line: number; text: string }
/** unresolved: calls the scanner could not trace to a press, an effect or a mutation hook's own body (never judged). */
interface Census { hits: Hit[]; calls: number; pressed: number; unresolved: Hit[] }

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
  /** The hooks a returned value comes from: a call (`useMutation(…)`), through parentheses / `as` / `!` and both
   *  branches of a ternary, or a local bound to one — the phone's vendorops `usePreviewSafeMutation`:
   *  `const m = useVendorMutation(o); return (pv ? previewMutation() : m) as …`. */
  const handed = (e: ts.Expression, fn: Fn): string[] => {
    let x: ts.Expression = e;
    while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
    if (ts.isConditionalExpression(x)) return [...handed(x.whenTrue, fn), ...handed(x.whenFalse, fn)];
    if (ts.isCallExpression(x)) return calleeName(x) ? [calleeName(x)!] : [];
    if (!ts.isIdentifier(x) || !fn.body || !ts.isBlock(fn.body)) return [];
    const name = x.text;
    return fn.body.statements.flatMap((st) => (ts.isVariableStatement(st) ? st.declarationList.declarations : [])
      .flatMap((d) => (ts.isIdentifier(d.name) && d.name.text === name && d.initializer && ts.isCallExpression(d.initializer) && calleeName(d.initializer) ? [calleeName(d.initializer)!] : [])));
  };
  const returned = (fn: Fn): string[] => {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return handed(fn.body as ts.Expression, fn);
    return fn.body.statements.flatMap((st) => (ts.isReturnStatement(st) && st.expression ? handed(st.expression, fn) : []));
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
  const rowHolds = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer)) {
      const hook = calleeName(n.initializer);
      if (hook === ROW_HOLD && ts.isIdentifier(n.name)) rowHolds.add(n.name.text);
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
  // An alias (`const mutateCart = addToCart.mutate`, MarketScreen): its calls are the mutation's calls.
  const aliases = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isPropertyAccessExpression(n.initializer)
      && ts.isIdentifier(n.initializer.expression) && handles.has(n.initializer.expression.text) && /^(mutate|mutateAsync)$/.test(n.initializer.name.text)) callNames.set(n.name.text, n.initializer.getText());
    ts.forEachChild(n, aliases);
  };
  aliases(sf);
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
  /** The `on…` prop a handler sits in, through parentheses and ternary branches (`onX={ok ? () => s.mutate() : undefined}`);
   *  held when such a ternary's condition names the pending state (`onRate={rate.isPending ? undefined : (n) => …}`). */
  const pressAttr = (n: ts.Node): { attr: ts.JsxAttribute; held: boolean } | null => {
    let at: ts.Node = n;
    let held = false;
    for (let p = at.parent; p && (ts.isParenthesizedExpression(p) || (ts.isConditionalExpression(p) && p.condition !== at)); p = at.parent) {
      if (ts.isConditionalExpression(p) && namesPending(p.condition, false)) held = true;
      at = p;
    }
    const p = at.parent;
    if (p && ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent) && /^on[A-Z]/.test(p.parent.name.getText())) return { attr: p.parent, held };
    return null;
  };
  /** The call a function is handed to (through useCallback): `guardAuth(() => …)`, `holdRow(key, () => …)`, `useEffect(() => …)`. */
  const hostCall = (fn: Fn): { call: ts.CallExpression; arg: number } | null => {
    let at: ts.Node = fn;
    if (ts.isCallExpression(at.parent) && calleeName(at.parent) === 'useCallback' && at.parent.arguments[0] === at) at = at.parent;
    const p = at.parent;
    if (!ts.isCallExpression(p)) return null;
    const arg = p.arguments.indexOf(at as ts.Expression);
    return arg >= 0 ? { call: p, arg } : null;
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
    const host = hostCall(fn);
    if (host && host.arg === 1 && rowHolds.has(calleeName(host.call) ?? '')) return; // held per row
    const slot = pressAttr(fn);
    if (slot) {
      out.pressed++;
      if (!slot.held && !elementGuarded(slot.attr)) out.hits.push({ file, line: at(node), text: `${label} <- <${slot.attr.parent.parent.tagName.getText()} ${slot.attr.name.getText()}>` });
      return;
    }
    const named = nameOf(fn);
    if (named && hooks.has(named.name)) return; // inside a mutation hook's own body: each caller's call is judged as a call
    if (!named && host && EFFECT.test(calleeName(host.call) ?? '')) return; // an effect, not a press
    if (!named && host) { follow(host.call, label, hops, seen); return; } // `guardAuth(() => s.mutate())`: follow the call that runs it (outward only, so no hop)
    if (!named || hops >= MAX_HOPS) { out.unresolved.push({ file, line: at(node), text: label }); return; }
    const refs: ts.Identifier[] = [];
    /** Only refs to THIS binding: not a name (`<X onAdd=…>`, `{ onAdd: … }`, a type's member), not another
     *  binding of the same name (MarketCard's own `onAdd` prop; ServiceJobsScreen's two `confirm`s). */
    const scope = named.decl.parent;
    const binds = (b: ts.BindingName): boolean => (ts.isIdentifier(b) ? b.text === named.name : b.elements.some((e) => !ts.isOmittedExpression(e) && binds(e.name)));
    const declares = (st: ts.Statement): boolean => (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => d !== named.decl && binds(d.name)))
      || (ts.isFunctionDeclaration(st) && st !== named.decl && st.name?.text === named.name);
    const isName = (n: ts.Identifier): boolean => {
      const p = n.parent;
      return (ts.isJsxAttribute(p) && p.name === n) || ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === n)
        || (ts.isBindingElement(p) && p.propertyName === n) || (ts.isPropertyAccessExpression(p) && p.name === n);
    };
    const shadowed = (n: ts.Node): boolean => {
      for (let at = n.parent; at && !ts.isSourceFile(at); at = at.parent) {
        if (at === scope || (at.pos <= named.decl.pos && named.decl.end <= at.end)) return false;
        if (isFn(at) && at.parameters.some((pr) => binds(pr.name))) return true;
        if (ts.isBlock(at) && at.statements.some(declares)) return true;
      }
      return false;
    };
    const findRefs = (n: ts.Node) => {
      // A hook's deps array (`useEffect(…, [onAdd])`) names the handler without running it.
      const inDeps = ts.isIdentifier(n) && ts.isArrayLiteralExpression(n.parent) && ts.isCallExpression(n.parent.parent) && /^use[A-Z]/.test(calleeName(n.parent.parent) ?? '');
      if (ts.isIdentifier(n) && n.text === named.name && n.parent !== named.decl && !inDeps && !isName(n) && !shadowed(n)) refs.push(n);
      ts.forEachChild(n, findRefs);
    };
    findRefs(sf);
    if (!refs.length) { out.unresolved.push({ file, line: at(node), text: label }); return; }
    for (const ref of refs) {
      const direct = pressAttr(ref);
      if (direct) {
        out.pressed++;
        if (!direct.held && !elementGuarded(direct.attr)) out.hits.push({ file, line: at(node), text: `${label} <- <${direct.attr.parent.parent.tagName.getText()} ${direct.attr.name.getText()}>` });
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
    } else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && handles.has(n.expression.text) && /^(mutate|mutateAsync)$/.test(n.name.text)
      && !(ts.isCallExpression(n.parent) && n.parent.expression === n) && !(ts.isVariableDeclaration(n.parent) && n.parent.initializer === n)) {
      // A method reference (`onPress={s.mutate}`): the prop's own element is the only place a hold can be.
      const label = `${n.expression.text}.${n.name.text}`;
      out.calls++;
      const slot = pressAttr(n);
      if (!slot) out.unresolved.push({ file, line: at(n), text: label });
      else {
        out.pressed++;
        if (!slot.held && !elementGuarded(slot.attr)) out.hits.push({ file, line: at(n), text: `${label} <- <${slot.attr.parent.parent.tagName.getText()} ${slot.attr.name.getText()}>` });
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

// <<< C2 shared scanner

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
  'modules/vendor/screens/VendorOps.tsx | orderAction.mutate <- <VendorOrderCard onAction>': 'Held per order: each card gets busy={pendingIds.has(o.id)}, and usePendingOrderIds (hooks/vendorops.ts) reads the pending ORDER_ACTION_KEY mutations (useMutationState, status pending), which this scanner does not follow into another file; VendorOrderCard disables and spins its step buttons on busy. A repeated step is also refused by the server (the order has already moved on).',
};

/** Calls the scanner cannot trace to a press, checked by hand. Every entry must still match an untraced call. */
const UNTRACED: Record<string, string> = {
  'modules/cart/screens/CartScreen.tsx | placeOrder.mutate': 'onOrder is also kept in a ref (onOrderLatest) for the pickup-confirm Alert button (the system dialog fires once); its own Place order press is judged, and usePlaceOrder refuses a second order while one is in flight (its inFlight ref).',
  'modules/chat/screens/ConversationScreen.tsx | reportContent.mutate': 'An ActionSheet item (object onPress): kit/action-sheet runs onClose() before the item, so the sheet and its buttons are gone after the first tap.',
  'modules/shop/screens/RestaurantScreen.tsx | reportContent.mutate': 'An ActionSheet item (object onPress): the item closes the sheet first (setReportOpen(false)) and kit/action-sheet runs onClose() before it.',
  'modules/mover/screens/ActiveJobScreen.tsx | riderAct.mutate': 'Handed to DoorCash as its submit prop with pending={riderAct.isPending}: DoorCash returns early while pending (its confirm) and its Confirm buttons are loading={pending}.',
  'modules/mover/screens/MoverHomeScreen.tsx | goOnline.mutateAsync': 'Called inside the options object handed to prepareMoverOnline by startOnline, which returns early on busyToggle (preparingOnline, set true first, or goOnline/goOffline pending); the GO control is also disabled={busyToggle}.',
  'hooks/useCartSteppers.ts | add.mutateAsync': '[TAP-AUDIT] The cart steppers send from one queue per cart line (drive): a line has at most one request out, and a tap made meanwhile only moves its target, so no tap sends the same write twice.',
  'hooks/useCartSteppers.ts | update.mutateAsync': '[TAP-AUDIT] The cart steppers send from one queue per cart line (drive): a line has at most one request out, and a tap made meanwhile only moves its target, so no tap sends the same write twice.',
  'hooks/vendorops.ts | sale.mutateAsync': '[IN-STORE-SALE] The "Sold in store" taps send from one line per item (lib/inStoreSale drive): an item has at most one request out, each tap is its own sale with its own key, and a resend of the same tap (Try again) carries the same key, which the server answers with its receipt, so no tap is taken twice.',
  'modules/vendor/screens/VendorOrderDetailScreen.tsx | returnReceived.mutate': 'An object action handed to CustodyRecoveryNotice with pending: returnReceived.isPending; the notice renders it as a PillButton loading and disabled on pending.',
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

  it('every call the scanner cannot trace to a press is listed with the reason it is safe', () => {
    const untraced = RESULT.unresolved.filter((u) => !UNTRACED[keyOf(u)])
      .map((u) => `${u.file}:${u.line} ${u.text} — the census cannot see the press behind it. Make the press traceable (an on… prop, a named handler) or list it in UNTRACED with the reason.`);
    expect(untraced).toEqual([]);
    for (const [key, reason] of Object.entries(UNTRACED)) {
      expect(reason.trim().length, key).toBeGreaterThanOrEqual(20);
      expect(RESULT.unresolved.some((u) => keyOf(u) === key), `stale entry ${key}: the call is traced now (or gone), drop it`).toBe(true);
    }
  });

  it('every KNOWN entry names a real hit and says why', () => {
    for (const [key, reason] of Object.entries(KNOWN)) {
      expect(reason.trim().length, key).toBeGreaterThanOrEqual(20);
      expect(RESULT.hits.some((h) => keyOf(h) === key), `stale entry ${key}: the hit is gone, drop it`).toBe(true);
    }
    for (const lane of Object.values(PENDING_ELSEWHERE)) expect(lane).toMatch(/^UI-(SWEEP|FIX-WEB|FIX-ADMIN) U\d+$/);
  });

  it('runs the one shared scanner: the block is byte-identical in apps/mobile and apps/web', () => {
    const block = (path: string) => /\/\/ >>> C2 shared scanner[\s\S]*\/\/ <<< C2 shared scanner/.exec(readFileSync(join(process.cwd(), '..', path), 'utf8'))?.[0];
    const phone = block('mobile/src/__tests__/a-press-never-fires-a-mutation-twice.census.test.ts');
    expect(phone).toBeTruthy();
    expect(block('web/src/lib/a-press-never-fires-a-mutation-twice.census.test.ts'), 'apps/web differs from apps/mobile: copy the block').toBe(phone);
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
    // The shared in-flight count of a mutation key (useIsMutating / queryClient.isMutating) holds it too.
    expect(verdict(`function P(){ const m = useSave(); const busy = useIsMutating({ mutationKey: k }) > 0; return <button disabled={busy} onClick={() => m.mutate()} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const m = useSave(); const qc = useQueryClient(); const go = () => { if (qc.isMutating({ mutationKey: k })) return; m.mutate(); }; return <button onClick={go} />; }`)).toEqual([]);
    // A useState flag nobody sets to true is not a guard.
    expect(verdict(`function P(){ const s = useSave(); const [busy, setBusy] = useState(false); const done = () => setBusy(false); return <B disabled={busy} onPress={() => s.mutate(undefined, { onSettled: done })} />; }`)).toEqual(['s.mutate <- <B onPress>']);
    // Not a press: the system dialog's button, an effect.
    expect(verdict(`function P(){ const s = useSave(); return <B onPress={() => Alert.alert('Sure?', '', [{ text: 'Yes', onPress: () => s.mutate() }])} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const s = useSave(); const cancel = () => s.mutate(); return <B onPress={() => Alert.alert('Sure?', '', [{ text: 'Yes', onPress: cancel }])} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const s = useSave(); useEffect(() => { s.mutate(); }, []); return null; }`)).toEqual([]);
    // [#1952 S3-2] A list: one shared isPending is not a per-row hold; holdRow(key, …) is.
    expect(verdict(`function P({ rows }){ const s = useSave(); const holdRow = useRowHold(); return rows.map((r) => <B onPress={() => holdRow(r.id, () => s.mutateAsync(r.id))} />); }`)).toEqual([]);
    expect(verdict(`function P({ rows }){ const s = useSave(); const other = useOther(); return rows.map((r) => <B onPress={() => other(r.id, () => s.mutateAsync(r.id))} />); }`)).toEqual(['s.mutateAsync <- <B onPress>']);
    // [#1952 S3-1] Followed now: a ternary branch of an on… prop, a handler handed to a call, React.useCallback.
    expect(verdict(`function P({ ok }){ const s = useSave(); return <B onX={ok ? () => s.mutate() : undefined} />; }`)).toEqual(['s.mutate <- <B onX>']);
    expect(verdict(`function P(){ const s = useSave(); return <B onRate={s.isPending ? undefined : () => s.mutate()} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const s = useSave(); return <B onAdd={() => guardAuth(() => s.mutate())} />; }`)).toEqual(['s.mutate <- <B onAdd>']);
    expect(verdict(`function P(){ const s = useSave(); return <B busy={s.isPending} onAdd={() => guardAuth(() => s.mutate())} />; }`)).toEqual([]);
    expect(verdict(`function P(){ const s = useSave(); const add = React.useCallback(() => s.mutate(), [s]); React.useEffect(() => { if (later) add(); }, [add]); return <B onPress={add} />; }`)).toEqual(['s.mutate <- <B onPress>']);
    expect(verdict(`function P(){ const s = useSave(); return <B cancelling={s.isPending} onCancel={() => s.mutate()} />; }`)).toEqual([]);
    // A method reference is judged at its prop.
    expect(verdict(`function P(){ const s = useSave(); return <B onPress={s.mutate} />; }`)).toEqual(['s.mutate <- <B onPress>']);
    expect(verdict(`function P(){ const s = useSave(); return <B disabled={s.isPending} onPress={s.mutate} />; }`)).toEqual([]);
    // An alias of mutate is the mutation (MarketScreen's `const mutateCart = addToCart.mutate`).
    // [#1952 S4-3] Refs are scope-aware: a child's own `onAdd` prop is not the parent's handler.
    expect(verdict(`function Card({ onAdd, adding }){ return <B onPress={() => onAdd(1)} />; }\nfunction P(){ const s = useSave(); const onAdd = (i) => s.mutate(i); return <Card onAdd={onAdd} adding={s.isPending} />; }`)).toEqual([]);
    expect(verdict(`function Card({ onAdd }){ return <B onPress={() => onAdd(1)} />; }\nfunction P(){ const s = useSave(); const onAdd = (i) => s.mutate(i); return <Card onAdd={onAdd} />; }`)).toEqual(['s.mutate <- <Card onAdd>']);
    expect(verdict(`function P(){ const s = useSave(); const send = s.mutate; return <B onPress={() => send()} />; }`)).toEqual(['send() <- <B onPress>']);
    // [#1952 S3-1] Not traceable: an object onPress, a handler kept in a ref, are untraced (listed or failing), never silently passed.
    const untraced = (src: string) => census({ ...hook, 'x.tsx': src }).unresolved.map((u) => u.text);
    expect(untraced(`function P(){ const s = useSave(); return <Sheet actions={[{ label: 'Go', onPress: () => s.mutate() }]} />; }`)).toEqual(['s.mutate']);
    expect(untraced(`function P(){ const s = useSave(); const keep = useRef(() => s.mutate()); return null; }`)).toEqual(['s.mutate']);
    // A mutation hook's own body is not a press (its callers are judged).
    expect(census(hook).unresolved).toEqual([]);
    // [STORE-VAT 01:36Z finding] A hook that hands back a LOCAL mutation through a ternary and a cast (the phone's
    // vendorops usePreviewSafeMutation) is a mutation hook too, and so is every hook that returns it.
    const preview = { 'ops.ts': `function useSafe(o) { const pv = usePreviewDataset(); const m = useSave(o); return (pv ? previewMutation() : m) as R; }\nexport function useRemoveStaff() { return useSafe({ mutationFn: remove }); }` };
    const seen = (src: string) => census({ ...hook, ...preview, 'x.tsx': src }).hits.map((h) => h.text);
    expect(seen(`function P(){ const del = useRemoveStaff(); return <B onPress={() => del.mutate(1)} />; }`)).toEqual(['del.mutate <- <B onPress>']);
    expect(seen(`function P(){ const del = useRemoveStaff(); return <B disabled={del.isPending} onPress={() => del.mutate(1)} />; }`)).toEqual([]);
  });
});
