import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

// Native maps are opaque to the DOM renderer. Parse the real screen JSX so
// every route map must carry its credit in the same visible layout branch.
const screens = [
  ['../modules/movement/screens/TaxiScreen.tsx', 2],
  ['../modules/movement/screens/CourierScreen.tsx', 1],
  ['../modules/orders/screens/DeliveryScreen.tsx', 1],
  ['../modules/mover/screens/ActiveJobScreen.tsx', 1],
] as const;
describe('routing credit beside every route map', () => {
  it.each(screens)('%s keeps a credit alongside each of its %i maps', (file, count) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const maps: ts.JsxElement[] = [];
    const credits: ts.JsxSelfClosingElement[] = [];
    const walk = (node: ts.Node) => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'MapView') maps.push(node);
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'RouteAttribution') credits.push(node);
      ts.forEachChild(node, walk);
    };
    walk(ast);
    expect(maps).toHaveLength(count);
    expect(credits, 'routing credit is rendered, not just imported').toHaveLength(count);
    for (const map of maps) {
      expect(credits.some((credit) => credit.parent === map.parent), 'credit is a sibling of the native map').toBe(true);
    }
  });
});
