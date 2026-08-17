import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement, source: ts.SourceFile): string {
  const name = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return name.getText(source);
}

describe('PopupCard caller semantics', () => {
  it('uses one semantic PopupTitle and hides raw icon-font artwork in every dialog', () => {
    const issues: string[] = [];
    let popupCount = 0;

    for (const file of tsxFiles(join(process.cwd(), 'src'))) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );

      const visit = (node: ts.Node) => {
        if (ts.isJsxElement(node) && tagName(node, source) === 'PopupCard') {
          popupCount += 1;
          let titleCount = 0;

          const inspectPopup = (descendant: ts.Node, hiddenArtwork = false) => {
            if (
              descendant !== node
              && ts.isJsxElement(descendant)
              && tagName(descendant, source) === 'PopupCard'
            ) {
              return;
            }

            let hidesChildren = hiddenArtwork;
            if (ts.isJsxElement(descendant) || ts.isJsxSelfClosingElement(descendant)) {
              const tag = tagName(descendant, source);
              if (tag === 'PopupTitle') titleCount += 1;
              hidesChildren ||= tag === 'DecorativeIcon' || tag === 'IconChip';

              if ((tag === 'Feather' || tag === 'MaterialCommunityIcons') && !hidesChildren) {
                const line = source.getLineAndCharacterOfPosition(descendant.getStart(source)).line + 1;
                issues.push(`${file}:${line} exposes decorative ${tag} artwork`);
              }
            }

            ts.forEachChild(descendant, (child) => inspectPopup(child, hidesChildren));
          };

          inspectPopup(node);
          if (titleCount !== 1) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            issues.push(`${file}:${line} has ${titleCount} PopupTitle elements`);
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(source);
    }

    expect(popupCount).toBeGreaterThan(0);
    expect(issues).toEqual([]);
  });
});
