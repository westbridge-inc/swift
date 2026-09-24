import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Owner: "logging out of any account — the confirmation 'should we log you
// out', like every other app."
//
// THE WEB SIGN-OUT CENSUS, twin of apps/mobile's logout-census. Every sign-out
// control on the web goes through the one shared ask (components/
// sign-out-button.tsx). This walks every source file under apps/web/src on the
// TypeScript syntax tree and fails when:
//
//   1. a file reaches lib/auth's logout() and is not on the allowlist below. A
//      new single-click "Sign out" has to do exactly that;
//   2. a "Sign out" / "Log out" label sits anywhere but inside SignOutButton.
//
// The expired-session path (apiFetch clearing a session the server already
// ended) is forced and never asks; it goes through clearSession, not logout().
// ---------------------------------------------------------------------------

const SRC = process.cwd().endsWith('apps/web')
  ? join(process.cwd(), 'src')
  : join(process.cwd(), 'apps', 'web', 'src');

/** The only files that may reach logout() directly, each with why. */
const MAY_END_A_SESSION: Record<string, string> = {
  // Defines logout(): the server revokes the session and expires the cookies.
  'lib/auth.ts': 'the session module',
  // Runs logout() once the person has said "Sign out".
  'components/sign-out-button.tsx': 'the confirm itself',
};

/** Every sign-out control this census must find (a floor, so a broken walker
 *  cannot pass by finding nothing). */
const KNOWN_CONTROLS = ['app/dashboard/layout.tsx', 'app/portal/layout.tsx', 'app/(app)/account/page.tsx'];

const LABEL = /^\s*(log|sign)[\s-]?out\b/i;
const LABEL_PROPS = new Set(['label', 'title', 'aria-label']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

const FILES = sourceFiles(SRC).map((path) => {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return {
    rel: relative(SRC, path).split(sep).join('/'),
    source: ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, kind),
  };
});

const lineOf = (source: ts.SourceFile, node: ts.Node) =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

function walk(node: ts.Node, visit: (_node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Every way a file reaches logout(): importing it, calling it, `x.logout`,
 *  `onClick={logout}`, or defining it. */
function logoutReaches(source: ts.SourceFile): string[] {
  const hits: string[] = [];
  walk(source, (node) => {
    const hit = (what: string) => hits.push(`${lineOf(source, node)}: ${what}`);
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'logout') hit('imports logout');
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'logout') hit('logout()');
    else if (ts.isPropertyAccessExpression(node) && node.name.text === 'logout') hit(node.getText(source));
    else if (ts.isFunctionDeclaration(node) && node.name?.text === 'logout') hit('defines logout');
    else if (
      ts.isJsxAttribute(node)
      && node.initializer
      && ts.isJsxExpression(node.initializer)
      && node.initializer.expression
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === 'logout'
    ) hit(node.getText(source));
  });
  return hits;
}

function tagOf(node: ts.Node): string | null {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return null;
}

/** Sign-out labels outside SignOutButton: JSX text, or a label-like attribute. */
function bareLabels(rel: string, source: ts.SourceFile): string[] {
  const bare: string[] = [];
  const insideConfirm = (node: ts.Node) => {
    for (let at: ts.Node | undefined = node; at; at = at.parent) if (tagOf(at) === 'SignOutButton') return true;
    return false;
  };
  walk(source, (node) => {
    let label: string | null = null;
    if (ts.isJsxText(node)) label = node.text;
    else if (ts.isJsxAttribute(node) && LABEL_PROPS.has(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) {
      label = node.initializer.text;
    }
    if (label && LABEL.test(label) && !insideConfirm(node)) bare.push(`${rel}:${lineOf(source, node)} "${label.trim()}"`);
  });
  return bare;
}

function usesConfirm(source: ts.SourceFile): boolean {
  let found = false;
  walk(source, (node) => {
    if (tagOf(node) === 'SignOutButton') found = true;
  });
  return found;
}

describe('every web sign-out control asks first', () => {
  it('walks a real tree and finds every known sign-out control using the shared ask', () => {
    expect(FILES.length).toBeGreaterThan(50);
    for (const known of KNOWN_CONTROLS) {
      const file = FILES.find(({ rel }) => rel === known);
      expect(file, `${known} exists`).toBeTruthy();
      expect(usesConfirm(file!.source), `${known} signs out through SignOutButton`).toBe(true);
    }
  });

  it('only the allowlisted files reach logout() directly', () => {
    const unlisted = FILES.flatMap(({ rel, source }) =>
      MAY_END_A_SESSION[rel] ? [] : logoutReaches(source).map((hit) => `${rel}:${hit}`));
    expect(unlisted, 'sign out through SignOutButton (components/sign-out-button.tsx)').toEqual([]);
  });

  it('the allowlist is live: every listed file still reaches logout()', () => {
    const stale = Object.keys(MAY_END_A_SESSION).filter((rel) => {
      const file = FILES.find((candidate) => candidate.rel === rel);
      return !file || logoutReaches(file.source).length === 0;
    });
    expect(stale).toEqual([]);
  });

  it('no "Sign out" / "Log out" label sits outside SignOutButton', () => {
    const bare = FILES.flatMap(({ rel, source }) => (rel === 'components/sign-out-button.tsx' ? [] : bareLabels(rel, source)));
    expect(bare, 'wrap the control in SignOutButton so it asks first').toEqual([]);
  });
});
