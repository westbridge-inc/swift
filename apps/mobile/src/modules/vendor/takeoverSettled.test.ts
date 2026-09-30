import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { takeoverSettled } from './acceptClock';

// ---------------------------------------------------------------------------
// [Q12] The takeover rings only while the order is still waiting for the
// store. An order the customer cancelled (an express order, or one released
// from its hold and then cancelled), one another device answered, or one the
// no-response timer reaped, is settled: the kitchen must stop buzzing for it
// instead of offering an Accept the server will refuse.
//
// The wiring is asserted on the AST, as takeoverEscape.test.ts does, so a
// comment or a reformat cannot make it pass or fail spuriously.
// ---------------------------------------------------------------------------

describe('the takeover rings only while the order waits for the store', () => {
  it('a PENDING order keeps ringing; one the server says has moved on is settled', () => {
    expect(takeoverSettled({ status: 'PENDING' })).toBe(false);
    for (const status of ['CANCELLED', 'ACCEPTED', 'REFUNDED']) expect(takeoverSettled({ status }), status).toBe(true);
  });

  it('an order the server has not answered for yet (still loading) is not settled', () => {
    expect(takeoverSettled(undefined)).toBe(false);
    expect(takeoverSettled(null)).toBe(false);
    expect(takeoverSettled({})).toBe(false);
  });

  it('NewOrderTakeover dismisses a settled order by itself', () => {
    const file = join(process.cwd(), 'src/modules/vendor/NewOrderTakeover.tsx');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let settledName: string | undefined;
    const effects: Array<{ callsDismiss: boolean; deps: string[] }> = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'takeoverSettled'
      ) {
        settledName = node.name.text;
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') {
        const [callback, deps] = node.arguments;
        let callsDismiss = false;
        const scan = (n: ts.Node) => {
          if (ts.isCallExpression(n) && n.expression.getText(source) === 'onDismiss') callsDismiss = true;
          ts.forEachChild(n, scan);
        };
        if (callback) scan(callback);
        effects.push({ callsDismiss, deps: deps && ts.isArrayLiteralExpression(deps) ? deps.elements.map((e) => e.getText(source)) : [] });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(settledName, 'the takeover reads takeoverSettled(order)').toBeDefined();
    expect(effects.some((e) => e.callsDismiss && e.deps.includes(settledName!)), 'an effect keyed on it dismisses the order').toBe(true);
  });
});
