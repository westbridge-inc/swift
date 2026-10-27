import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// [AUTH-FIX · S2-3] A HOOK REFUSES BY THROWING — the census.
//
// `authenticate` sent its 401 and resolved undefined. Fastify then ran the
// next hook and the route handler whenever the response had not ENDED yet:
// the app's async onSend hooks were still writing it, or the caller hung up
// mid-response. `return reply` closes the first case only (a hang-up resolves
// the reply's promise early, and the chain goes on). A THROWN error stops the
// request in every case, and the error handler writes the same status and
// body. This file holds every place in apps/api/src to that rule:
//
//   A. inside an async function, every `reply.send(...)` / `reply.redirect(...)`
//      is RETURNED (a return statement, or the body of an arrow function);
//   B. every call of `authenticate(request, reply)` is returned, or awaited
//      and followed at once by `requireAuthenticatedIdentity(request)` (a
//      guard goes on only with an identity authenticate verified);
//   C. no async function answers `if (reply.sent) return;`;
//   D. no request hook (onRequest / preParsing / preValidation / preHandler:
//      added with addHook, named in route options, or the authenticate
//      decorator) sends a reply: it throws, and nothing after it runs.
//
// The behaviour itself is proven over a real socket in
// auth-refusal-status.test.ts; this census keeps a new hook from bringing the
// bug back.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'generated') continue;
      out.push(...sourceFiles(p));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

type FnLike = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration;
const isFn = (n: ts.Node): n is FnLike =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);
const isAsync = (fn: FnLike) => (ts.getModifiers(fn) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);

function enclosingFn(n: ts.Node): FnLike | undefined {
  let p: ts.Node | undefined = n.parent;
  while (p && !isFn(p)) p = p.parent;
  return p;
}
/** The reply parameter's name: a parameter typed FastifyReply or named like a
 *  reply, else `reply` (a helper that closes over the route's reply). */
function replyNameOf(fn: FnLike | undefined, src: ts.SourceFile): string {
  const param = fn?.parameters.find((p) => ts.isIdentifier(p.name)
    && (/^_?reply$/i.test(p.name.text) || /\bFastifyReply\b/.test(p.type?.getText(src) ?? '')));
  return param ? param.name.getText(src) : 'reply';
}
function outerOf(n: ts.Node): ts.Node {
  let p = n.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p))) p = p.parent;
  return p;
}
const isReturned = (call: ts.Node) => {
  const p = outerOf(call);
  return ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body !== undefined && !ts.isBlock(p.body));
};

type Site = { where: string; text: string };
const sends: Array<Site & { async: boolean; returned: boolean }> = [];
const authCalls: Array<Site & { ok: boolean }> = [];
const bareSentReturns: Site[] = [];
const parsed = sourceFiles(SRC).map((file) => ({ file, src: ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true) }));

for (const { file, src } of parsed) {
  const rel = relative(SRC, file);
  const where = (n: ts.Node) => `${rel}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const fn = enclosingFn(n);
      const replyName = replyNameOf(fn, src);
      const receiver = n.expression.expression.getText(src);
      if ((method === 'send' || method === 'redirect') && new RegExp(`\\b${replyName}\\b`).test(receiver)) {
        sends.push({ where: where(n), text: n.getText(src).replace(/\s+/g, ' ').slice(0, 80), async: !!fn && isAsync(fn), returned: isReturned(n) });
      }
      if (method === 'authenticate' && n.arguments.length === 2) {
        const p = outerOf(n);
        // Returned: the hook ends there. Awaited as a statement: the next
        // statement must insist on the verified identity before going on.
        let ok = isReturned(n);
        if (!ok && ts.isAwaitExpression(p) && ts.isExpressionStatement(outerOf(p)) && ts.isBlock(outerOf(p).parent)) {
          const stmt = outerOf(p) as ts.ExpressionStatement;
          const block = stmt.parent as ts.Block;
          const next = block.statements[block.statements.indexOf(stmt) + 1];
          ok = !!next && /^requireAuthenticatedIdentity\(/.test(next.getText(src));
        }
        authCalls.push({ where: where(n), text: n.getText(src), ok });
      }
    }
    if (ts.isIfStatement(n) && /^\w+\.sent$/.test(n.expression.getText(src).replace(/\s+/g, ''))) {
      const fn = enclosingFn(n);
      const then = ts.isBlock(n.thenStatement) && n.thenStatement.statements.length === 1 ? n.thenStatement.statements[0] : n.thenStatement;
      if (fn && isAsync(fn) && ts.isReturnStatement(then) && !then.expression) bareSentReturns.push({ where: where(n), text: n.getText(src) });
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}

// D. Every request hook, resolved to its function: inline, a named function
// (same file first, then anywhere), or the function a guard factory returns.
const REQUEST_HOOKS = new Set(['onRequest', 'preParsing', 'preValidation', 'preHandler']);
type Located = { fn: FnLike; rel: string; src: ts.SourceFile };
const named = new Map<string, Located[]>();
const built = new Map<string, { call: ts.CallExpression; src: ts.SourceFile }>();
for (const { file, src } of parsed) {
  const rel = relative(SRC, file);
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name) named.set(n.name.text, [...(named.get(n.name.text) ?? []), { fn: n, rel, src }]);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isFn(n.initializer)) {
      named.set(n.name.text, [...(named.get(n.name.text) ?? []), { fn: n.initializer, rel, src }]);
    }
    // `const browseSearch = bindBrowseTenant(app)`: the hook is what the factory returns.
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer)) {
      built.set(`${rel}#${n.name.text}`, { call: n.initializer, src });
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}
function returnedFns(fn: FnLike): FnLike[] {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return isFn(fn.body) ? [fn.body] : [];
  const out: FnLike[] = [];
  const visit = (n: ts.Node): void => {
    if (n !== fn && isFn(n)) return;
    if (ts.isReturnStatement(n) && n.expression && isFn(n.expression)) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return out;
}
const hookFns = new Map<FnLike, { rel: string; src: ts.SourceFile; uses: string[] }>();
const unresolvedHooks: string[] = [];
function noteHook(l: Located, use: string) {
  const entry = hookFns.get(l.fn) ?? { rel: l.rel, src: l.src, uses: [] };
  entry.uses.push(use);
  hookFns.set(l.fn, entry);
}
function lookup(name: string, rel: string): Located[] {
  const all = named.get(name) ?? [];
  const same = all.filter((l) => l.rel === rel);
  return same.length ? same : all;
}
function resolveHook(expr: ts.Expression | undefined, rel: string, src: ts.SourceFile, use: string): void {
  if (!expr) return;
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) expr = expr.expression;
  if (isFn(expr)) return noteHook({ fn: expr, rel, src }, use);
  if (ts.isArrayLiteralExpression(expr)) return expr.elements.forEach((e) => resolveHook(ts.isSpreadElement(e) ? e.expression : e, rel, src, use));
  if (ts.isConditionalExpression(expr)) { resolveHook(expr.whenTrue, rel, src, use); resolveHook(expr.whenFalse, rel, src, use); return; }
  if (ts.isIdentifier(expr)) {
    const found = lookup(expr.text, rel);
    const factoryBuilt = built.get(`${rel}#${expr.text}`);
    if (!found.length && factoryBuilt) return resolveHook(factoryBuilt.call, rel, factoryBuilt.src, use);
    if (!found.length) unresolvedHooks.push(`${use} ${expr.text}`);
    found.forEach((l) => noteHook(l, use));
    return;
  }
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    const found = lookup(name, rel);
    if (!found.length) unresolvedHooks.push(`${use} ${expr.getText(src).slice(0, 40)}`);
    found.forEach((l) => returnedFns(l.fn).forEach((fn) => noteHook({ fn, rel: l.rel, src: l.src }, `${use} via ${name}()`)));
    return;
  }
  // app.authenticate / app.authenticateOptional: the decorators, held below.
  if (ts.isPropertyAccessExpression(expr)) return;
  unresolvedHooks.push(`${use} ${expr.getText(src).slice(0, 40)}`);
}
for (const { file, src } of parsed) {
  const rel = relative(SRC, file);
  const at = (n: ts.Node) => `${rel}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const [first, second] = n.arguments;
      const method = n.expression.name.text;
      if (method === 'addHook' && first && ts.isStringLiteral(first) && REQUEST_HOOKS.has(first.text)) resolveHook(second, rel, src, `addHook ${first.text} @${at(n)}`);
      if (method === 'decorate' && first && ts.isStringLiteral(first) && /^authenticate/.test(first.text)) resolveHook(second, rel, src, `decorate ${first.text} @${at(n)}`);
    }
    if (ts.isPropertyAssignment(n) && REQUEST_HOOKS.has(n.name.getText(src).replace(/['"]/g, ''))) resolveHook(n.initializer, rel, src, `${n.name.getText(src)} @${at(n)}`);
    if (ts.isShorthandPropertyAssignment(n) && REQUEST_HOOKS.has(n.name.text)) resolveHook(n.name, rel, src, `${n.name.text} @${at(n)}`);
    ts.forEachChild(n, visit);
  };
  visit(src);
}
const sendingHooks: string[] = [];
for (const [fn, { rel, src, uses }] of hookFns) {
  const visit = (n: ts.Node): void => {
    if (n !== fn && isFn(n)) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['send', 'redirect'].includes(n.expression.name.text)
      && !/^(this|app|notifications|socket|io)\b/.test(n.expression.expression.getText(src))) {
      sendingHooks.push(`${rel}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1} (${uses[0]}) ${n.getText(src).replace(/\s+/g, ' ').slice(0, 60)}`);
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
}

describe('[S2-3] census: a request hook refuses by throwing; a handler returns what it sends', () => {
  it('the scan is not vacuous: it reads the route sends and authenticate\'s four direct callers', () => {
    expect(sends.length).toBeGreaterThan(60);
    // authenticate refuses by throwing: it sends nothing itself.
    expect(sends.filter((s) => s.where.startsWith('plugins/auth.ts:'))).toEqual([]);
    expect(authCalls.map((c) => c.where.replace(/:\d+$/, ''))).toEqual(expect.arrayContaining([
      'modules/admin/admin.routes.ts', 'modules/user/customer.routes.ts', 'modules/search/search-scope.ts',
    ]));
    expect(authCalls.length).toBeGreaterThanOrEqual(4);
  });

  it('A. inside an async function, every reply.send / reply.redirect is returned', () => {
    expect(sends.filter((s) => s.async && !s.returned).map((s) => `${s.where} ${s.text}`)).toEqual([]);
  });

  it('B. every authenticate(request, reply) is returned, or awaited and followed by requireAuthenticatedIdentity(request)', () => {
    expect(authCalls.filter((c) => !c.ok).map((c) => `${c.where} ${c.text}`)).toEqual([]);
  });

  it('C. no async function answers `if (reply.sent) return;`', () => {
    expect(bareSentReturns.map((s) => `${s.where} ${s.text}`)).toEqual([]);
  });

  it('D. the scan reads the request hooks: authenticate, the admin guards, the customer hook, the browse binding', () => {
    const where = [...hookFns.values()].map((h) => h.rel);
    expect(where).toEqual(expect.arrayContaining([
      'plugins/auth.ts', 'modules/admin/admin.routes.ts', 'modules/user/customer.routes.ts', 'modules/search/search-scope.ts', 'modules/ads/ads.routes.ts',
    ]));
    expect(hookFns.size).toBeGreaterThan(15);
    expect(unresolvedHooks.join("\n")).toBe("");
  });

  it('D. no request hook sends a reply: it refuses by throwing, so nothing after it can run', () => {
    expect(sendingHooks).toEqual([]);
  });
});
