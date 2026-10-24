import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// [UI-SWEEP U-P3, owner 22 Oct] On "Your activity" a store with no photo
// showed its name squeezed under the shop icon inside the 56pt tile, broken
// across lines ("SWIF / T M..."). A photo tile with no photo draws the
// kit placeholder (kit/photo-placeholder.tsx), which prints `label` under its
// pictogram unless `showLabel={false}`. In a tile narrower than 84pt the
// name cannot fit, and a row already prints it beside the tile.
//
// This census reads every screen with the TypeScript parser: a Photo /
// PhotoPlaceholder / PhotoPlaceholderTile that is given a `label` and does
// not pass showLabel={false} must be at least 84pt wide ('100%', a number of
// 84 or more, or a named width listed below with its size). The label still
// reaches the screen reader either way.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const TILES = new Set(['Photo', 'PhotoPlaceholder', 'PhotoPlaceholderTile']);
const MIN_NAMED_TILE_PT = 84;

/** Widths written as a name, with why they are wide enough. */
const NAMED_WIDTHS: Record<string, string> = {
  TILE_W: "store menu grid: a third of the screen (about 106pt on a 390pt phone); the name is printed under it too",
  SCREEN_W: 'a full-width hero photo',
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(p);
    return e.name.endsWith('.tsx') && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });
}

function attr(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return el.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}
const expr = (a: ts.JsxAttribute | undefined) => (a?.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined);

/** The tile's width as written: a number, '100%', a name, or null when it cannot be read. */
function widthOf(el: ts.JsxOpeningLikeElement): string | number | null {
  if (el.tagName.getText() === 'PhotoPlaceholderTile') {
    const size = expr(attr(el, 'size'));
    if (!attr(el, 'size')) return 84; // the kit default
    return size && ts.isNumericLiteral(size) ? Number(size.text) : size?.getText() ?? null;
  }
  const style = expr(attr(el, 'style'));
  if (!style || !ts.isObjectLiteralExpression(style)) return null;
  const w = style.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'width')?.initializer;
  if (!w) return null;
  if (ts.isNumericLiteral(w)) return Number(w.text);
  if (ts.isStringLiteral(w)) return w.text;
  return w.getText();
}

function census(files: Array<{ file: string; text: string }>): string[] {
  const hits: string[] = [];
  for (const { file, text } of files) {
    // The kit's own Photo forwards the caller's label and showLabel; the caller is what is checked.
    if (file === 'kit/photo-placeholder.tsx') continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node) => {
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && TILES.has(n.tagName.getText()) && attr(n, 'label')) {
        const hidden = expr(attr(n, 'showLabel'))?.kind === ts.SyntaxKind.FalseKeyword;
        if (!hidden) {
          const w = widthOf(n);
          const wide = w === '100%' || (typeof w === 'number' && w >= MIN_NAMED_TILE_PT) || (typeof w === 'string' && w in NAMED_WIDTHS);
          if (!wide) hits.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.tagName.getText()} width ${w ?? 'unreadable'} draws its name`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return hits;
}

describe('[UI-SWEEP U-P3] a small photo tile never squeezes a name into itself', () => {
  const files = sources(SRC).map((f) => ({ file: f.slice(SRC.length + 1), text: readFileSync(f, 'utf8') }));

  it('every labelled photo tile under 84pt passes showLabel={false}', () => {
    expect(census(files)).toEqual([]);
  });

  it('the census catches the old activity tile and passes the shapes the app uses (guards the guard)', () => {
    const wrap = (jsx: string) => `export function S() { return (${jsx}); }`;
    const hits = (jsx: string) => census([{ file: 'virtual.tsx', text: wrap(jsx) }]);
    expect(hits(`<Photo uri={u} label={o.vendor?.name} glyph="shops" style={{ width: size, height: size }} />`)).toHaveLength(1);
    expect(hits(`<Photo uri={u} label={it.name} style={{ width: 64, height: 64 }} />`)).toHaveLength(1);
    expect(hits(`<PhotoPlaceholderTile label={n} size={56} />`)).toHaveLength(1);
    expect(hits(`<Photo uri={u} label={o.vendor?.name} showLabel={false} style={{ width: size, height: size }} />`)).toEqual([]);
    expect(hits(`<Photo uri={u} label={n} style={{ width: '100%', height: '100%' }} />`)).toEqual([]);
    expect(hits(`<Photo uri={u} label={n} style={{ width: TILE_W, height: TILE_W }} />`)).toEqual([]);
    expect(hits(`<Photo uri={u} glyph="shops" style={{ width: 56, height: 56 }} />`)).toEqual([]);
  });
});
