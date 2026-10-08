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

describe('sensitive room publication census', () => {
  it('all 43 existing order publishers call the current-audience gate; no direct order or chat broadcast remains', () => {
    const bypasses: string[] = []; let orderPublishers = 0;
    for (const file of sources(join(__dirname, '..'))) {
      const text = readFileSync(file, 'utf8');
      const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n)) {
          if (n.expression.getText(ast) === 'emitToOrderRoom') orderPublishers++;
          if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'emit'
            && ts.isCallExpression(n.expression.expression)
            && ts.isPropertyAccessExpression(n.expression.expression.expression)
            && n.expression.expression.expression.name.text === 'to'
            && n.expression.expression.arguments.some((arg) => /(?:order|chat):/.test(arg.getText(ast)))) {
            bypasses.push(file + ':' + (ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1));
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(ast);
    }
    expect(bypasses).toEqual([]);
    expect(orderPublishers).toBe(43);
  });
});
