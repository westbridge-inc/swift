import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// A runtime whose native side has no web view module (the 1.0.0 store builds 9 and 10).
vi.mock('react-native', () => ({ TurboModuleRegistry: { get: () => null } }));

import { CARD_WEBVIEW_NATIVE_MODULE, cardWebView, loadCardWebView } from './cardWebView';

// [CARD embed] react-native-webview is a native module the 1.0.0 binaries do not have.
// Its JavaScript demands the native module as soon as it loads, so an unguarded import
// crashes those builds at startup. The guard: ask the native side first, load the package
// only then, inside a try; anything else means the in-app browser opens the card page.
const WebView = { $$typeof: Symbol.for('react.forward_ref'), render: () => null };

describe('the card web view is loaded only where the native side has it', () => {
  it('a build without the native module: no web view, and the package is never even loaded', () => {
    const load = vi.fn(() => ({ WebView }));
    expect(loadCardWebView({ get: () => null }, load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('asks the native side for the module the package itself requires', () => {
    const get = vi.fn((name: string) => (name === CARD_WEBVIEW_NATIVE_MODULE ? {} : null));
    expect(loadCardWebView({ get }, () => ({ WebView }))).toBe(WebView);
    expect(get).toHaveBeenCalledWith('RNCWebViewModule');
  });

  it('every failure is "no web view", never a crash', () => {
    const present = { get: () => ({}) };
    expect(loadCardWebView({ get: () => { throw new Error('no registry'); } }, () => ({ WebView }))).toBeNull();
    expect(loadCardWebView(null, () => ({ WebView }))).toBeNull();
    expect(loadCardWebView({}, () => ({ WebView }))).toBeNull();
    expect(loadCardWebView(present, () => { throw new Error("TurboModuleRegistry.getEnforcing(...): 'RNCWebViewModule' could not be found"); })).toBeNull();
    expect(loadCardWebView(present, () => ({}))).toBeNull();
    expect(loadCardWebView(present, () => null)).toBeNull();
    expect(loadCardWebView(present, () => ({ WebView: 'not a component' }))).toBeNull();
  });

  it('this run’s runtime (no native module) answers no web view, once', () => {
    expect(cardWebView()).toBeNull();
    expect(cardWebView()).toBeNull();
  });
});

describe('nothing else in the phone app loads the web view package', () => {
  const SRC = join(process.cwd(), 'src');
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? (['node_modules', '__tests__', '__mocks__'].includes(e.name) ? [] : files(join(dir, e.name)))
    : /\.(?:[cm]?[jt]sx?)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) ? [join(dir, e.name)] : []);
  const code = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('only lib/cardWebView.ts reaches it at run time (a type-only import erases to nothing)', () => {
    const runtime = files(SRC).filter((f) => {
      const c = code(f).replace(/^\s*import\s+type\b[^;]*;/gm, '');
      return /react-native-webview/.test(c);
    }).map((f) => f.slice(SRC.length + 1));
    expect(runtime).toEqual(['lib/cardWebView.ts']);
  });

  it('there it is a require inside the guarded loader, never a top-level import', () => {
    const c = code(join(SRC, 'lib/cardWebView.ts'));
    expect(c).not.toMatch(/^\s*import\s+(?!type\b)[^;]*['"]react-native-webview['"]/m);
    expect(c).not.toMatch(/^\s*export\s+[^;]*from\s+['"]react-native-webview['"]/m);
    expect(c.match(/require\('react-native-webview'\)/g)).toHaveLength(1);
  });
});
