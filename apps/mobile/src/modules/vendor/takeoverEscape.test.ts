import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Leaving a new-order takeover must be a DECISION.
//
// `onRequestClose` fires on the Android hardware back button. It used to call
// `onDismiss` directly — the same path as the deliberate "View later" button —
// so a reflex back press was indistinguishable from a considered choice, and
// the vendor had no way to know which of the three things they had just done.
//
// The order itself was never lost (the server's escalation ladder re-alerts,
// then sends SMS), but "did I mean to do that?" is not a question a kitchen
// should have to answer during service.
//
// Asserted on the AST rather than the text so a comment mentioning onDismiss,
// or reformatting, cannot make this pass or fail spuriously.
// ---------------------------------------------------------------------------

const FILE = join(process.cwd(), 'src/modules/vendor/NewOrderTakeover.tsx');

function parse() {
  return ts.createSourceFile(FILE, readFileSync(FILE, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** The JSX attribute value for `name` on the first Modal in the file. */
function modalAttribute(source: ts.SourceFile, name: string): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (opening && opening.tagName.getText(source) === 'Modal') {
      for (const attr of opening.attributes.properties) {
        if (ts.isJsxAttribute(attr) && attr.name.getText(source) === name) {
          found = attr.initializer;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

describe('new-order takeover — the back button is not a decision', () => {
  it('the Modal declares onRequestClose (Android back is handled, not ignored by omission)', () => {
    expect(modalAttribute(parse(), 'onRequestClose')).toBeDefined();
  });

  it('onRequestClose calls NOTHING — no dismiss, no mutation', () => {
    const source = parse();
    const attr = modalAttribute(source, 'onRequestClose');
    expect(attr).toBeDefined();

    const calls: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(attr!);

    // Any call here is a back press doing something the vendor did not choose.
    expect(calls, `onRequestClose must be inert; it calls: ${calls.join(', ')}`).toEqual([]);
  });

  it('the deliberate paths still exist — decide() and an explicit View later', () => {
    // Guards the opposite regression: making back inert must not be achieved by
    // removing the ways a vendor is meant to leave.
    const text = readFileSync(FILE, 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code.length, 'comment stripper returned nothing — the assertions below would be vacuous')
      .toBeGreaterThan(500);
    expect(code).toContain('decide(');
    expect(code).toContain('onDismiss(current.orderId)'); // the View later button
  });
});
