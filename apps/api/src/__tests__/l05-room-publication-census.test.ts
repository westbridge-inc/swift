import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const SENSITIVE_ROOM = /^[`'"](?:order|chat):/;

/** True when `arg` is an order/chat room literal, an array holding one, or an
 * identifier whose declaration in the same file initializes it to one. */
function namesSensitiveRoom(arg: ts.Expression, ast: ts.SourceFile): boolean {
  if (SENSITIVE_ROOM.test(arg.getText(ast))) return true;
  if (ts.isArrayLiteralExpression(arg)) return arg.elements.some((el) => namesSensitiveRoom(el, ast));
  if (!ts.isIdentifier(arg)) return false;
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === arg.text
      && n.initializer && namesSensitiveRoom(n.initializer, ast)) found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(ast);
  return found;
}

describe('sensitive room publication census', () => {
  it('all 48 existing order publishers call the current-audience gate; no direct order or chat broadcast remains', () => {
    const bypasses: string[] = []; let orderPublishers = 0;
    for (const file of sources(join(__dirname, '..'))) {
      const text = readFileSync(file, 'utf8');
      const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n)) {
          if (n.expression.getText(ast) === 'emitToOrderRoom') orderPublishers++;
          // A helper that takes the room as an argument (e.g. roomEmit(`order:…`)) is the same bypass.
          const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : n.expression.getText(ast);
          // emitToStoreRoom is the store-room gate (owner ruling #15): its room is
          // vendor:<id>, and its order: arguments are EVENT names (order:new).
          if (/emit/i.test(callee) && !['emit', 'emitToOrderRoom', 'emitToChatRoom', 'emitToStoreRoom'].includes(callee)
            && n.arguments.some((arg) => /^[`'"](?:order|chat):/.test(arg.getText(ast)))) {
            bypasses.push(file + ':' + (ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1));
          }
          if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'emit'
            && ts.isCallExpression(n.expression.expression)
            && ts.isPropertyAccessExpression(n.expression.expression.expression)
            && n.expression.expression.expression.name.text === 'to'
            && n.expression.expression.arguments.some((arg) => /(?:order|chat):/.test(arg.getText(ast)))) {
            bypasses.push(file + ':' + (ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1));
          }
          // Any to()/in()/except() targeting an order or chat room, whether the
          // room is written inline, in an array, or held in a variable first
          // (const room = an order: template; io.in(room)), is a publication or a
          // membership operation outside the gate.
          if (ts.isPropertyAccessExpression(n.expression) && ['to', 'in', 'except'].includes(n.expression.name.text)
            && n.arguments.some((arg) => namesSensitiveRoom(arg, ast))) {
            bypasses.push(file + ':' + (ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1));
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(ast);
    }
    expect(bypasses).toEqual([]);
    // 43 + the guardian check-in hint (it used a roomEmit(`order:…`) helper the first census missed)
    // + the admin store-refund close (#1607)
    // + the swap question withdrawn at its deadline on MMG (#1830, through the gate)
    // + the MMG acceptance expiry (owner 18 Oct: not marked "Paid by MMG" within 30 minutes of acceptance).
    // + the taxi stop change (multi-stop part 4: ride:stop_changed, through the gate).
    // + [O-4] the out-of-stock question asked before acceptance, and the free cancel when the only
    //   item left gets no answer (picking.service, both through the gate).
    expect(orderPublishers).toBe(50);
  });
});
