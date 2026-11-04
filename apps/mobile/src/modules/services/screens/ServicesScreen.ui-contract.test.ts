import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SCREEN = readFileSync(new URL('./ServicesScreen.tsx', import.meta.url), 'utf8');

function parse() {
  return ts.createSourceFile('ServicesScreen.tsx', SCREEN, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function openingElement(node: ts.Node): ts.JsxOpeningLikeElement | undefined {
  return ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined;
}

function tagName(node: ts.Node, source: ts.SourceFile): string | undefined {
  return openingElement(node)?.tagName.getText(source);
}

function attribute(node: ts.Node, source: ts.SourceFile, name: string): ts.JsxAttribute | undefined {
  return openingElement(node)?.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(source) === name,
  );
}

function stringAttribute(node: ts.Node, source: ts.SourceFile, name: string): string | undefined {
  const initializer = attribute(node, source, name)?.initializer;
  return initializer && ts.isStringLiteral(initializer) ? initializer.text : undefined;
}

function containsText(node: ts.Node, source: ts.SourceFile, text: string): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (ts.isJsxText(child) && child.getText(source).trim() === text) found = true;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function firstDescendant(node: ts.Node, source: ts.SourceFile, predicate: (candidate: ts.Node) => boolean): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (predicate(child)) {
      found = child;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

describe('ServicesScreen customer-first hierarchy', () => {
  const source = parse();
  const providerInvitation = firstDescendant(
    source,
    source,
    (node) => tagName(node, source) === 'Card' && containsText(node, source, 'Offer your own services'),
  );

  it('keeps provider onboarding after the customer trade and provider-discovery states', () => {
    const providerStates = firstDescendant(
      source,
      source,
      (node) => ts.isConditionalExpression(node) && node.condition.getText(source) === '!trade',
    );

    expect(providerStates).toBeDefined();
    expect(providerInvitation).toBeDefined();
    expect(providerInvitation!.getStart(source)).toBeGreaterThan(providerStates!.getEnd());
  });

  it('makes the invitation a heading and keeps its nested setup action independently accessible', () => {
    expect(providerInvitation).toBeDefined();
    expect(attribute(providerInvitation!, source, 'accessibilityLabel')).toBeUndefined();

    const heading = firstDescendant(
      providerInvitation!,
      source,
      (node) => tagName(node, source) === 'T' && containsText(node, source, 'Offer your own services'),
    );
    const setup = firstDescendant(
      providerInvitation!,
      source,
      (node) => tagName(node, source) === 'PillButton' && stringAttribute(node, source, 'label') === 'Set up profile',
    );

    expect(stringAttribute(heading!, source, 'accessibilityRole')).toBe('header');
    expect(setup).toBeDefined();
    expect(setup!.getText(source)).toContain('enterServiceProvider(');
  });

  it('uses the named input typography token for the editable job composer', () => {
    const composer = firstDescendant(
      source,
      source,
      (node) => tagName(node, source) === 'TextInput' && stringAttribute(node, source, 'placeholder') === 'Describe the job (at least 10 characters)…',
    );

    expect(composer).toBeDefined();
    expect(composer!.getText(source)).toContain('fontSize: fontSize.input');
    expect(composer!.getText(source)).not.toContain('fontSize: fontSize.base');
  });
});
