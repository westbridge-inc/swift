import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Owner: "logging out of any account — the confirmation 'should we log you
// out', like every other app."
//
// THE LOG-OUT CENSUS. Every control a person presses to leave their account
// goes through the one shared ask (kit/logout-confirm.tsx). This walks every
// source file under apps/mobile/src on the TypeScript syntax tree (comments and
// strings cannot fool it) and fails when:
//
//   1. a file reaches the store's logout() or logoutIfCurrent() and is not on
//      the allowlist below. A new single-tap "Log out" has to do exactly that;
//   2. a control labelled "Log out" or "Sign out" is pressed into anything but
//      the confirm's requestLogout;
//   3. a screen with such a control does not render the confirm's dialog. A
//      control that opens nothing would leave the person unable to leave;
//   4. a FORCED log-out (an expired session, a refresh the server refused,
//      account deletion) grows a confirm. Asking about a session that is
//      already gone would be a lie.
// ---------------------------------------------------------------------------

const SRC = process.cwd().endsWith('apps/mobile')
  ? join(process.cwd(), 'src')
  : join(process.cwd(), 'apps', 'mobile', 'src');

/**
 * The only files that may reach the store's teardown directly, each with why.
 * Everything else goes through useLogoutConfirm.
 */
const MAY_END_A_SESSION: Record<string, string> = {
  // Defines logout() and logoutIfCurrent(): the one real teardown.
  'stores/authStore.ts': 'the auth store',
  // Runs the store's logout() once the person has said "Log out".
  'kit/logout-confirm.tsx': 'the confirm itself',
  // The advertiser exit's intent-first teardown. The confirm hands it the
  // store's logout(), and it clears the intent before calling it.
  'modules/advertiser/advertiserExit.ts': 'the advertiser exit, run by the confirm',
  // FORCED: a refresh the server refused ends the session (logoutIfCurrent).
  // It also holds the raw POST /auth/logout client the store revokes through.
  'services/api.ts': 'session refresh (forced)',
  // FORCED: the refresh coordinator's port to logoutIfCurrent.
  'lib/authSession.ts': 'session refresh (forced)',
  // FORCED: account deletion closes the session once the server has deleted it.
  'modules/profile/screens/PersonalDataScreen.tsx': 'account deletion (forced)',
};

/** Forced log-outs: the session is already gone, so none of them may ask. */
const FORCED = ['services/api.ts', 'lib/authSession.ts', 'modules/profile/screens/PersonalDataScreen.tsx'];

/** Every person-facing log-out control this census must find (a floor, so a
 *  broken walker cannot pass by finding nothing). */
const KNOWN_CONTROLS = [
  'modules/profile/screens/ProfileScreen.tsx',
  'modules/mover/screens/MoverAccountScreen.tsx',
  'modules/mover/screens/MoverOnboardingScreen.tsx',
  'modules/vendor/shared.tsx',
  'screens/auth/SelfieCaptureScreen.tsx',
  'modules/advertiser/screens/AdvertiserRegisterScreen.tsx',
  'modules/advertiser/screens/AdvertiserTeamScreen.tsx',
];

const TEARDOWN = new Set(['logout', 'logoutIfCurrent']);
const LABEL = /^\s*(log|sign)[\s-]?out\b/i;
const LABEL_PROPS = new Set(['label', 'title', 'accessibilityLabel']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

const FILES = sourceFiles(SRC).map((path) => {
  const text = readFileSync(path, 'utf8');
  const rel = relative(SRC, path).split(sep).join('/');
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return { rel, source: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind) };
});

const lineOf = (source: ts.SourceFile, node: ts.Node) =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Every way a file can reach the store's teardown: `s.logout`, a `logout()`
 *  call, `{ logout } = useAuthStore()`, `onPress={logout}`, or defining one. */
function teardownReaches(source: ts.SourceFile): string[] {
  const hits: string[] = [];
  walk(source, (node) => {
    const hit = (what: string) => hits.push(`${lineOf(source, node)}: ${what}`);
    if (ts.isPropertyAccessExpression(node) && TEARDOWN.has(node.name.text)) {
      hit(node.getText(source));
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && TEARDOWN.has(node.expression.text)) {
      hit(`${node.expression.text}()`);
    } else if (ts.isBindingElement(node) && TEARDOWN.has((node.propertyName ?? node.name).getText(source))) {
      hit(`destructures ${(node.propertyName ?? node.name).getText(source)}`);
    } else if (
      ts.isJsxAttribute(node)
      && node.initializer
      && ts.isJsxExpression(node.initializer)
      && node.initializer.expression
      && ts.isIdentifier(node.initializer.expression)
      && TEARDOWN.has(node.initializer.expression.text)
    ) {
      hit(node.getText(source));
    } else if (
      (ts.isPropertyAssignment(node) || ts.isPropertySignature(node) || ts.isMethodDeclaration(node))
      && ts.isIdentifier(node.name)
      && TEARDOWN.has(node.name.text)
    ) {
      hit(`defines ${node.name.text}`);
    }
  });
  return hits;
}

function attribute(element: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return element.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function literal(value: ts.JsxAttributeValue | undefined): string | null {
  if (!value) return null;
  if (ts.isStringLiteral(value)) return value.text;
  if (ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression)) return value.expression.text;
  return null;
}

/** The pressed element of a control: the label's own element, or for a text
 *  label the nearest enclosing element that takes a press. */
function pressable(node: ts.Node): ts.JsxOpeningLikeElement | null {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    const opening = ts.isJsxElement(at) ? at.openingElement : ts.isJsxSelfClosingElement(at) ? at : null;
    if (opening && attribute(opening, 'onPress')) return opening;
  }
  return null;
}

/** True when a press handler is the shared confirm's requestLogout. */
function asksFirst(element: ts.JsxOpeningLikeElement | null): boolean {
  const handler = element && attribute(element, 'onPress')?.initializer;
  const expression = handler && ts.isJsxExpression(handler) ? handler.expression : undefined;
  if (!expression) return false;
  if (ts.isIdentifier(expression)) return expression.text === 'requestLogout';
  return ts.isPropertyAccessExpression(expression) && expression.name.text === 'requestLogout';
}

interface Control {
  file: string;
  line: number;
  label: string;
  handler: string;
  asks: boolean;
}

function logoutControls(rel: string, source: ts.SourceFile): Control[] {
  const found: Control[] = [];
  const record = (node: ts.Node, label: string, element: ts.JsxOpeningLikeElement | null) => {
    const handler = element ? (attribute(element, 'onPress')?.getText(source) ?? '(no onPress)') : '(no pressable element)';
    found.push({ file: rel, line: lineOf(source, node), label, handler, asks: asksFirst(element) });
  };
  walk(source, (node) => {
    if (ts.isJsxAttribute(node) && LABEL_PROPS.has(node.name.getText(source))) {
      const label = literal(node.initializer);
      if (label && LABEL.test(label)) record(node, label, node.parent.parent as ts.JsxOpeningLikeElement);
    } else if (ts.isJsxText(node) && LABEL.test(node.text)) {
      record(node, node.text.trim(), pressable(node));
    }
  });
  return found;
}

/** Renders `{logoutDialog}` or `{x.logoutDialog}` somewhere in its JSX. */
function rendersDialog(source: ts.SourceFile): boolean {
  let renders = false;
  walk(source, (node) => {
    if (!ts.isJsxExpression(node) || !node.expression) return;
    const expression = node.expression;
    if (
      (ts.isIdentifier(expression) && expression.text === 'logoutDialog')
      || (ts.isPropertyAccessExpression(expression) && expression.name.text === 'logoutDialog')
    ) renders = true;
  });
  return renders;
}

function mentions(source: ts.SourceFile, name: string): boolean {
  let found = false;
  walk(source, (node) => {
    if (ts.isIdentifier(node) && node.text === name) found = true;
  });
  return found;
}

const CONTROLS = FILES.flatMap(({ rel, source }) => (rel === 'kit/logout-confirm.tsx' ? [] : logoutControls(rel, source)));

describe('every log-out control asks first', () => {
  it('walks a real tree and finds every known log-out control', () => {
    expect(FILES.length).toBeGreaterThan(100);
    const files = new Set(CONTROLS.map((control) => control.file));
    for (const known of KNOWN_CONTROLS) expect(files.has(known), `${known} has a log-out control`).toBe(true);
  });

  it('only the allowlisted files reach the store’s logout directly', () => {
    const unlisted = FILES.flatMap(({ rel, source }) =>
      MAY_END_A_SESSION[rel] ? [] : teardownReaches(source).map((hit) => `${rel}:${hit}`));
    expect(
      unlisted,
      'These reach the store’s logout directly. A person’s own log-out control goes through ' +
        'useLogoutConfirm (kit/logout-confirm.tsx); a forced log-out uses logoutIfCurrent and is listed with why.',
    ).toEqual([]);
  });

  it('the allowlist is live: every listed file still reaches the teardown', () => {
    const byFile = new Map(FILES.map(({ rel, source }) => [rel, source]));
    const stale = Object.keys(MAY_END_A_SESSION).filter((rel) => {
      const source = byFile.get(rel);
      return !source || teardownReaches(source).length === 0;
    });
    expect(stale, 'remove allowlist entries that no longer reach logout').toEqual([]);
  });

  it('every "Log out" / "Sign out" control is pressed into the confirm’s requestLogout', () => {
    const bypasses = CONTROLS.filter((control) => !control.asks)
      .map((control) => `${control.file}:${control.line} "${control.label}" → ${control.handler}`);
    expect(bypasses, 'wire the control to requestLogout from useLogoutConfirm').toEqual([]);
  });

  it('every screen with such a control renders the confirm’s dialog', () => {
    const files = [...new Set(CONTROLS.map((control) => control.file))];
    const silent = files.filter((rel) => !rendersDialog(FILES.find((file) => file.rel === rel)!.source));
    expect(silent, 'render {logoutDialog}; without it the control opens nothing').toEqual([]);
  });
});

describe('forced log-outs never ask', () => {
  it.each(FORCED)('%s ends the session through logoutIfCurrent, with no confirm', (rel) => {
    const source = FILES.find((file) => file.rel === rel)!.source;
    expect(mentions(source, 'logoutIfCurrent'), `${rel} is a forced log-out`).toBe(true);
    expect(mentions(source, 'useLogoutConfirm'), `${rel} must not ask about a session that is already gone`).toBe(false);
  });
});
