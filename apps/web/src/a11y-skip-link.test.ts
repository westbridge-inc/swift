import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [Row 111 · W8] A keyboard or screen-reader user can skip straight to a page's
// content. The site-wide layout opens with a "Skip to main content" link, and
// every page's main region is its target (id="main", focusable so the jump
// lands there). The link stays out of sight until it has keyboard focus.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');
function sources(directory = SRC, out: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) { if (name !== 'test') sources(path, out); }
    else if (name.endsWith('.tsx') && !/\.test\.tsx$/.test(name)) out.push(path);
  }
  return out;
}

describe('[W8] skip to main content', () => {
  it('the site-wide layout opens with a "Skip to main content" link to #main', () => {
    const layout = read('app/layout.tsx');
    expect(layout).toMatch(/<body[^>]*>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<a href="#main" className="sw-skip-link">Skip to main content<\/a>/);
  });

  it('every main region a page renders is the link’s target: id="main", focusable', () => {
    const mains = sources().flatMap((path) => [...readFileSync(path, 'utf8').matchAll(/<main\b[^>]*>/g)].map((m) => ({ path: relative(SRC, path).split(sep).join('/'), tag: m[0] })));
    expect(mains.length).toBeGreaterThan(10);
    expect(mains.filter((m) => !/\bid="main"/.test(m.tag) || !/tabIndex=\{-1\}/.test(m.tag))).toEqual([]);
  });

  it('the link is out of sight until it has keyboard focus', () => {
    const css = read('app/globals.css');
    expect(css).toMatch(/\.sw-skip-link\s*\{[^}]*position:\s*absolute[^}]*\}/);
    expect(css).toMatch(/\.sw-skip-link:focus(-visible)?\s*\{[^}]*\}/);
  });
});
